import { readFile } from 'node:fs/promises';
import { getSyncScope } from './sync-state.js';
import taskModel from '../shared/sync-task.cjs';

export async function readSyncSnapshot(reqDir, sync) {
  const fileName = sync.docType === 'requirement' ? 'requirement.md' : 'design.md';
  const scope = getSyncScope(sync.workspaceId, sync.requirementId);
  if (sync.storageVersion !== 1 || !scope || scope.path !== reqDir || scope.key !== sync.scopeKey) throw new Error('SYNC_SNAPSHOT_SCOPE');
  return readFile(scope.store.file(sync, fileName), 'utf8');
}

export async function compareSyncSnapshots(reqDir, history, id1, id2) {
  const oldSync = history.find(sync => sync.id === id1);
  const newSync = history.find(sync => sync.id === id2);
  if (!oldSync || !newSync || oldSync.schemaVersion !== 2 || newSync.schemaVersion !== 2 || id1 === id2 || !taskModel.hasPublishedDocument(oldSync) || !taskModel.hasPublishedDocument(newSync)
    || !['requirement', 'design'].includes(oldSync.docType) || oldSync.docType !== newSync.docType) {
    const error = new Error('仅支持同类文档两个不同的成功同步版本对比');
    error.statusCode = 400;
    throw error;
  }
  const [oldContent, newContent] = await Promise.all([readSyncSnapshot(reqDir, oldSync), readSyncSnapshot(reqDir, newSync)]);
  const label = sync => `${sync.docTypeName || sync.docType} · ${(sync.commitHash || sync.id).slice(0, 8)} · ${new Date(sync.startedAt).toLocaleString()}`;
  return { oldContent, newContent, oldLabel: label(oldSync), newLabel: label(newSync) };
}
