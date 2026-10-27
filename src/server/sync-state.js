/** Execution state in global workspace-isolated SQLite; no legacy reads. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSyncStorage, syncStorageRoot } from './sync-storage.js';
import { buildSyncTimeline } from './sync-timeline.js';
import { readDocumentVersion } from './sync-document-validator.js';
import { hashBytes } from './sync-artifacts.js';
import model from '../shared/sync-task.cjs';
const bindings = new Map(), localActive = new Map(), controllers = new Map(), removed = new Set();
const key = (workspaceId, requirementId) => JSON.stringify([syncStorageRoot(), workspaceId, requirementId]);
const identity = task => JSON.stringify([task.workspaceId, task.requirementId, task.id, task.snapshotDir]);
export const isSyncTaskRemoved = task => !!task?.removed || removed.has(identity(task));
export const getSyncScope = (workspaceId, requirementId) => { const scope = bindings.get(key(workspaceId, requirementId)); if (scope?.store.closed) scope.store = getSyncStorage(scope.store.root); return scope; };
export const getCachedRequirementPath = (workspaceId, requirementId) => getSyncScope(workspaceId, requirementId)?.path;
async function recoverPublication(scope, task) {
  if (scope.store.live(task)) return;
  let published = false;
  try {
    const fileName = task.docType === 'design' ? 'design.md' : 'requirement.md';
    const snapshot = await readFile(scope.store.file(task, fileName));
    const live = await readDocumentVersion(join(scope.path, fileName));
    const journal = JSON.parse(await readFile(scope.store.file(task, 'publish-journal.json'), 'utf8'));
    const validation = JSON.parse(await readFile(scope.store.file(task, 'validation.json'), 'utf8'));
    published = journal.schemaVersion === 2 && journal.docPath === join(scope.path, fileName)
      && journal.candidateHash === task.candidateHash && journal.originalHash === task.originalHash
      && validation.candidateHash === task.candidateHash && validation.originalHash === task.originalHash
      && live.exists && hashBytes(live.bytes) === task.candidateHash && hashBytes(snapshot) === task.candidateHash;
  } catch { /* Inconsistent evidence cannot become success. */ }
  if (published) { task.publishState = 'state_committed'; for (const step of task.steps || []) Object.assign(step, { status: 'completed', completedAt: Date.now() }); }
  model.finishSyncTask(task, { status: published ? 'completed' : 'failed', error: published ? undefined : 'SYNC_EXECUTION_INTERRUPTED' });
  scope.store.recover(task);
}
export async function loadState(workspaceId, requirementId, requirementPath, options = {}) {
  if (!workspaceId || !requirementId || !requirementPath) return;
  const store = options.store || getSyncStorage(), previous = getSyncScope(workspaceId, requirementId);
  const scope = store.bind(options.workspace || { id: workspaceId, path: requirementPath }, requirementId, requirementPath, options.docsRoot || requirementPath);
  if (previous?.key !== scope.key) localActive.delete(key(workspaceId, requirementId));
  bindings.set(key(workspaceId, requirementId), scope); store.retire(scope);
  const state = store.state(scope);
  if (state.activeSync && !store.live(state.activeSync)) await recoverPublication(scope, state.activeSync);
  return getState(workspaceId, requirementId);
}
function getState(workspaceId, requirementId) {
  const scope = getSyncScope(workspaceId, requirementId);
  if (!scope) return { schemaVersion: 2, activeSync: null, history: [] };
  const state = scope.store.state(scope), cached = localActive.get(key(workspaceId, requirementId));
  if (cached && !isSyncTaskRemoved(cached) && state.activeSync?.id === cached.id && scope.store.owned(cached)) state.activeSync = cached;
  state.timeline = buildSyncTimeline(state.history); return state;
}
export async function getActiveSync(workspaceId, requirementId) { return getState(workspaceId, requirementId).activeSync; }
export function getCachedActiveSyncs() { return [...localActive.values()].filter(task => model.isSyncActive(task) && !isSyncTaskRemoved(task)); }
export async function getSyncHistory(workspaceId, requirementId) { return getState(workspaceId, requirementId).history; }
export async function getSyncById(id, workspaceId, requirementId) { const state = getState(workspaceId, requirementId); return [state.activeSync, ...state.history].find(task => task?.id === id); }
export async function setActiveSync(task, requirementPath, options = {}) {
  task.removed = false;
  if (!getSyncScope(task.workspaceId, task.requirementId)) await loadState(task.workspaceId, task.requirementId, requirementPath, options);
  const scope = getSyncScope(task.workspaceId, task.requirementId);
  if (!scope) throw new Error('SYNC_SCOPE_MISSING');
  scope.store.start(scope, task); localActive.set(key(task.workspaceId, task.requirementId), task);
}
export async function updateSyncProgress(id, updates, workspaceId, requirementId) {
  for (const task of localActive.values()) {
    if (task.id !== id || workspaceId && task.workspaceId !== workspaceId || requirementId && task.requirementId !== requirementId || isSyncTaskRemoved(task)) continue;
    if (updates.snapshotDir && updates.snapshotDir !== task.snapshotDir || task.status === 'cancelling' && updates.status === 'running') return;
    Object.assign(task, updates); getSyncScope(task.workspaceId, task.requirementId).store.save(task); return;
  }
}
export async function completeSync(id, workspaceId, requirementId, snapshotDir) {
  for (const [cacheKey, task] of localActive) {
    if (task.id !== id || workspaceId && task.workspaceId !== workspaceId || requirementId && task.requirementId !== requirementId || snapshotDir && task.snapshotDir !== snapshotDir || isSyncTaskRemoved(task)) continue;
    if (!snapshotDir && model.isSyncActive(task)) return;
    model.finishSyncTask(task); getSyncScope(task.workspaceId, task.requirementId).store.save(task); localActive.delete(cacheKey); return;
  }
}
export async function removeSyncTask(task, options = {}) {
  const scope = getSyncScope(task.workspaceId, task.requirementId); if (!scope) throw new Error('SYNC_SCOPE_MISSING');
  const deleted = scope.store.remove(task, options);
  for (const item of deleted) {
    removed.add(identity(item));
    const cached = localActive.get(key(item.workspaceId, item.requirementId));
    if (cached?.id === item.id) { cached.removed = true; localActive.delete(key(item.workspaceId, item.requirementId)); }
    const control = getAbortController(item.workspaceId, item.requirementId);
    if (control?.syncId === item.id) { control.controller.abort(); deleteAbortController(item.workspaceId, item.requirementId, item.id, control.controller); }
  }
  task.removed = true; return deleted;
}

export function setAbortController(workspaceId, requirementId, controller, syncId) { controllers.set(key(workspaceId, requirementId), { controller, syncId }); }
export function getAbortController(workspaceId, requirementId) { return controllers.get(key(workspaceId, requirementId)); }
export function deleteAbortController(workspaceId, requirementId, syncId, controller) {
  const cacheKey = key(workspaceId, requirementId), item = controllers.get(cacheKey);
  if (syncId && item?.syncId !== syncId || controller && item?.controller !== controller) return; controllers.delete(cacheKey);
}
export async function recoverSyncTask(task, reason) {
  const scope = getSyncScope(task.workspaceId, task.requirementId);
  if (!scope || scope.store.live(task) && !scope.store.owned(task)) return;
  const active = await getActiveSync(task.workspaceId, task.requirementId); if (active?.id !== task.id) return;
  getAbortController(task.workspaceId, task.requirementId)?.controller.abort(new Error(reason));
  model.finishSyncTask(active, { status: 'failed', error: reason });
  if (scope.store.owned(task)) scope.store.save(active); else scope.store.recover(active);
  localActive.delete(key(task.workspaceId, task.requirementId)); deleteAbortController(task.workspaceId, task.requirementId, task.id);
}
export async function abortSync(id, workspaceId, requirementId) {
  const task = await getActiveSync(workspaceId, requirementId), scope = getSyncScope(workspaceId, requirementId);
  if (!task || task.id !== id) return { success: false, error: 'SYNC_NOT_RUNNING' };
  if (!scope.store.owned(task)) return { success: false, error: 'SYNC_STORAGE_BUSY' };
  const control = getAbortController(workspaceId, requirementId);
  control?.controller.abort(); model.updateSyncTask(task, { type: 'cancel' }); scope.store.save(task);
  if (control?.syncId === id) return { success: true, status: 'cancelling' };
  model.finishSyncTask(task, { status: 'aborted' }); scope.store.save(task); localActive.delete(key(workspaceId, requirementId)); return { success: true };
}
