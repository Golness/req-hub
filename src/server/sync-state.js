/**
 * Sync state manager.
 * Persists active sync tasks and sync history per requirement directory.
 * Stored in requirement's sync-logs directory alongside sync-generated files.
 * @module sync-state
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { log } from './logger.js';
import { buildSyncTimeline } from './sync-timeline.js';
import { readSyncSnapshot } from './sync-snapshots.js';
import { readDocumentVersion } from './sync-document-validator.js';
import { hashBytes } from './sync-artifacts.js';
import taskModel from '../shared/sync-task.cjs';

/** @type {Map<string, SyncState>} In-memory state cache: requirementKey -> state */
const stateCache = new Map();

/** @type {Map<string, string>} Requirement path cache: requirementKey -> requirementPath */
const requirementPathCache = new Map();

/** @type {Map<string, Promise<void>>} Per-key write locks to prevent concurrent saves */
const saveLocks = new Map();

/** @type {Map<string, {controller: AbortController, syncId: string}>} Abort controllers for running sync tasks */
const activeSyncControllers = new Map();
const removedAttempts = new Set();
const attemptKey = task => JSON.stringify([task.workspaceId, task.requirementId, task.snapshotDir]);
export function isSyncTaskRemoved(task) { return !!task?.removed || removedAttempts.has(attemptKey(task)); }
export function getCachedRequirementPath(workspaceId, requirementId) { return requirementPathCache.get(getRequirementKey(workspaceId, requirementId)); }

/**
 * @typedef {Object} SyncState
 * @property {ActiveSync|null} activeSync - Currently running sync task
 * @property {SyncHistoryItem[]} history - Commit-scoped sync history
 * @property {Object[]} [timeline] - Traceability events derived from sync records
 */

/**
 * @typedef {Object} ActiveSync
 * @property {string} id - Sync task ID
 * @property {string} workspaceId - Workspace ID
 * @property {string} requirementId - Requirement ID
 * @property {string} status - Sync status (running/completed/aborted)
 * @property {number} [completedAt] - Completion timestamp
 * @property {number} [abortedAt] - Abort timestamp
 * @property {string} [currentSubagentSessionId] - Current subagent session ID
 */

/**
 * @typedef {Object} SyncHistoryItem
 * @property {string} id - Sync task ID
 * @property {string} status - Final status
 * @property {number} completedAt - Completion timestamp
 */

/**
 * Generate a unique key for a requirement.
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @returns {string} Unique key
 */
function getRequirementKey(workspaceId, requirementId) {
  return `${workspaceId}:${requirementId}`;
}

/**
 * Get state file path for a requirement.
 * @param {string} requirementPath - Requirement directory path
 * @returns {string} Full path to .sync-state.json
 */
function getStateFile(requirementPath) {
  return join(requirementPath, 'sync-logs', 'v2', '.sync-state.json');
}

/**
 * Load sync state from disk for a specific requirement.
 * Caches result in memory for subsequent reads.
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @param {string} requirementPath - Full path to requirement directory
 * @returns {Promise<SyncState|undefined>} Loaded state or undefined on error
 */
export async function loadState(workspaceId, requirementId, requirementPath) {
  if (!workspaceId || !requirementId || !requirementPath) {
    log.state.warn('loadState called without required parameters');
    return;
  }

  const key = getRequirementKey(workspaceId, requirementId);
  
  // Cache the requirement path
  requirementPathCache.set(key, requirementPath);

  // Check if already cached - avoid repeated disk reads
  if (stateCache.has(key)) {
    return stateCache.get(key);
  }

  try {
    const stateFile = getStateFile(requirementPath);
    if (existsSync(stateFile)) {
      const content = await readFile(stateFile, 'utf8');
      const state = JSON.parse(content);
      if (state.schemaVersion !== 2) throw new Error('不支持旧版同步状态');
      state.history = (state.history || []).filter(item => item.schemaVersion === 2);
      state.history ||= [];
      const needsHistoryRepair = state.history.some(taskModel.needsSyncRepair);
      state.history.forEach(taskModel.repairSyncTask);
      const needsRecovery = !!state.activeSync;
      // Recover every active record, including a completed publication not yet archived.
      if (needsRecovery) {
        let published = false;
        const active = state.activeSync;
        if (active.schemaVersion === 2 && active.candidateHash && active.snapshotDir?.startsWith('v2/')) {
          try {
            const snapshot = await readSyncSnapshot(requirementPath, active);
            const fileName = active.docType === 'design' ? 'design.md' : 'requirement.md';
            const live = await readDocumentVersion(join(requirementPath, fileName));
            const journal = JSON.parse(await readFile(join(requirementPath, 'sync-logs', active.snapshotDir, 'publish-journal.json'), 'utf8'));
            const validation = JSON.parse(await readFile(join(requirementPath, 'sync-logs', active.snapshotDir, 'validation.json'), 'utf8'));
            if (journal.schemaVersion !== 2 || journal.candidateHash !== active.candidateHash || journal.originalHash !== active.originalHash || validation.candidateHash !== active.candidateHash || validation.originalHash !== active.originalHash) throw new Error('PUBLISH_RECOVERY_HASH');
            published = live.exists && hashBytes(live.bytes) === active.candidateHash && hashBytes(Buffer.from(snapshot)) === active.candidateHash;
          } catch { /* Missing or changed artifacts must never be promoted to success. */ }
        }
        const interrupted = { ...active, status: 'running',
          publishState: published ? 'state_committed' : active.publishState,
        };
        if (published) {
          for (const step of interrupted.steps || []) if (!['analysis', 'index'].includes(step.phase)) Object.assign(step, { status: 'completed', completedAt: Date.now() });
        }
        taskModel.finishSyncTask(interrupted, { status: published && !(interrupted.steps || []).some(s => ['analysis', 'index'].includes(s.phase) && !['completed', 'skipped'].includes(s.status)) ? 'completed' : 'failed', error: published ? undefined : '服务重启，同步已中断或发布冲突，可重试当前 commit' });
        state.history = [interrupted, ...state.history.filter(item => item.id !== interrupted.id)];
        state.activeSync = null;
      }
      state.timeline = buildSyncTimeline(state.history || []);
      stateCache.set(key, state);
      if (needsRecovery || needsHistoryRepair) await saveState(key);
      log.state.info(`Loaded sync state for ${key}: ${state.history.length} history items`);
    } else {
      // Initialize empty state
      stateCache.set(key, { schemaVersion: 2, activeSync: null, history: [] });
    }
  } catch (e) {
    stateCache.delete(key);
    log.state.warn(`Failed to load sync state for ${key}: ${e.message}`);
    throw new Error(`无法读取同步状态，已停止同步以保护历史基准: ${e.message}`);
  }
  
  return stateCache.get(key);
}

/**
 * Save sync state to disk for a specific requirement.
 * Uses per-key lock to prevent concurrent writes.
 * Performs atomic write via temp file + rename.
 * @param {string} key - Requirement key
 * @returns {Promise<void>}
 */
async function saveState(key) {
  if (!key) return;

  // Queue behind any in-flight save for this key
  while (saveLocks.has(key)) {
    await saveLocks.get(key);
  }

  const run = (async () => {
    const requirementPath = requirementPathCache.get(key);
    if (!requirementPath) {
      log.state.warn(`Cannot save state: requirement path not cached for ${key}`);
      return;
    }

    try {
      const state = stateCache.get(key);
      if (!state) return;

      // Ensure sync-logs directory exists
      const syncLogsDir = join(requirementPath, 'sync-logs', 'v2');
      if (!existsSync(syncLogsDir)) {
        await mkdir(syncLogsDir, { recursive: true });
      }

      const stateFile = getStateFile(requirementPath);
      const tempFile = stateFile + '.tmp';

      // Atomic write: write to temp file first, then rename
      await writeFile(tempFile, JSON.stringify(state, null, 2), 'utf8');

      // Verify temp file exists before rename (guards against antivirus/file-lock deletion)
      if (!existsSync(tempFile)) {
        log.state.warn(`Temp file disappeared before rename for ${key}, retrying`);
        await writeFile(tempFile, JSON.stringify(state, null, 2), 'utf8');
      }

      await rename(tempFile, stateFile);
    } catch (e) {
      log.state.error(`Failed to save sync state for ${key}: ${e.message}`);
      throw e;
    }
  })();

  saveLocks.set(key, run);
  try {
    await run;
  } finally {
    // Only clear the lock entry if it still points to this run
    if (saveLocks.get(key) === run) {
      saveLocks.delete(key);
    }
  }
}

/**
 * Get state for a requirement (loads from disk if not cached).
 * @param {string} key - Requirement key
 * @returns {Promise<SyncState>} Current sync state
 */
async function getState(key) {
  if (!stateCache.has(key)) {
    const requirementPath = requirementPathCache.get(key);
    if (requirementPath) {
      // Extract workspaceId and requirementId from key
      const [workspaceId, requirementId] = key.split(':');
      await loadState(workspaceId, requirementId, requirementPath);
    } else {
      // No path cached, return empty state
      return { activeSync: null, history: [] };
    }
  }
  return stateCache.get(key) || { activeSync: null, history: [] };
}

/**
 * Get active sync task for a requirement.
 * Attempts to load state from disk if not cached.
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @returns {Promise<ActiveSync|null>} Active sync task or null
 */
export async function getActiveSync(workspaceId, requirementId) {
  const key = getRequirementKey(workspaceId, requirementId);
  
  // 如果缓存中没有，尝试从磁盘加载
  if (!stateCache.has(key)) {
    // 需要找到 requirement 路径
    // 这个信息需要从外部传入或者从工作区配置中查找
    // 暂时返回 null，让调用者处理
    log.state.info(`getActiveSync: state not cached for ${key}, need to load from disk`);
    
    // 尝试从可能的路径加载
    // 这里需要知道 workspace 的路径和 docs 目录结构
    // 由于没有这些信息，返回 null
    return null;
  }
  
  const state = await getState(key);
  return state.activeSync;
}

export function getCachedActiveSyncs() {
  return [...stateCache.values()].map(state => state.activeSync).filter(Boolean);
}

/**
 * Set active sync task for a requirement.
 * @param {ActiveSync} sync - Sync task to set as active
 * @param {string} [requirementPath] - Optional requirement path for caching
 * @returns {Promise<void>}
 */
export async function setActiveSync(sync, requirementPath) {
  if (isSyncTaskRemoved(sync)) return;
  if (!sync?.workspaceId || !sync?.requirementId) {
    log.state.warn('setActiveSync called without required fields');
    return;
  }

  const key = getRequirementKey(sync.workspaceId, sync.requirementId);
  
  // Cache the requirement path if provided
  if (requirementPath) {
    requirementPathCache.set(key, requirementPath);
  }

  const state = await getState(key);
  state.activeSync = sync;
  try {
    await saveState(key);
  } catch (error) {
    if (state.activeSync === sync) state.activeSync = null;
    throw error;
  }
}

/**
 * Complete an active sync and move it to history.
 * Keeps the latest outcome for each document and commit without pruning baselines.
 * @param {string} syncId - Sync task ID to complete
 * @returns {Promise<void>}
 */
export async function completeSync(syncId, workspaceId, requirementId, snapshotDir) {
  // Find which requirement this sync belongs to
  let targetKey = null;
  let completedSync = null;

  for (const [key, state] of stateCache.entries()) {
    if (workspaceId && requirementId && key !== getRequirementKey(workspaceId, requirementId)) continue;
    if (state.activeSync && state.activeSync.id === syncId) {
      if (isSyncTaskRemoved(state.activeSync)) return;
      // A caller without an execution identity cannot finish a live modern attempt.
      if (!snapshotDir && state.activeSync.snapshotDir && taskModel.isSyncActive(state.activeSync)) return;
      if (snapshotDir && state.activeSync.snapshotDir !== snapshotDir) return;
      targetKey = key;
      completedSync = { ...state.activeSync };
      break;
    }
  }

  if (!targetKey) {
    return;
  }

  taskModel.finishSyncTask(completedSync);
  
  const state = stateCache.get(targetKey);
  const previousActive = state.activeSync;
  const previousHistory = state.history;
  const previousTimeline = state.timeline;
  // One record per document and commit; failed attempts may be retried.
  state.history = state.history.filter(item => item.id !== syncId);
  state.history.unshift(completedSync);
  const committingHistory = state.history;
  state.timeline = buildSyncTimeline(state.history);
  
  // Clear active
  state.activeSync = null;
  
  try {
    await saveState(targetKey);
  } catch (error) {
    if (state.history === committingHistory && !state.activeSync && !isSyncTaskRemoved(previousActive)) {
      state.history = previousHistory;
      state.timeline = previousTimeline;
      state.activeSync = previousActive;
    }
    throw error;
  }
  log.state.info(`Sync ${syncId} completed and added to history for ${targetKey}`);
}

/**
 * Update active sync progress fields.
 * @param {string} syncId - Sync task ID
 * @param {Object} updates - Fields to update via Object.assign
 * @returns {Promise<void>}
 */
export async function updateSyncProgress(syncId, updates, workspaceId, requirementId) {
  if (isSyncTaskRemoved({ ...updates, workspaceId, requirementId })) return;
  // Find which requirement this sync belongs to
  for (const [key, state] of stateCache.entries()) {
    if (workspaceId && requirementId && key !== getRequirementKey(workspaceId, requirementId)) continue;
    if (state.activeSync && state.activeSync.id === syncId) {
      if (updates.snapshotDir && updates.snapshotDir !== state.activeSync.snapshotDir) return;
      if (state.activeSync.status === 'cancelling' && updates.status === 'running') return;
      Object.assign(state.activeSync, updates);
      await saveState(key);
      return;
    }
    const completed = state.history.find(item => item.schemaVersion === 2 && item.id === syncId);
    if (completed) {
      // Archived task outcomes are immutable; late progress must never revive them.
      return;
    }
  }
}

/**
 * Get sync history for a requirement.
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @returns {Promise<SyncHistoryItem[]>} Sync history array
 */
export async function getSyncHistory(workspaceId, requirementId) {
  const key = getRequirementKey(workspaceId, requirementId);
  const state = await getState(key);
  return state.history;
}

/**
 * Get a specific sync entry by ID (checks active first, then history).
 * @param {string} syncId - Sync task ID
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @returns {Promise<ActiveSync|SyncHistoryItem|undefined>} Sync entry or undefined
 */
export async function getSyncById(syncId, workspaceId, requirementId) {
  const key = getRequirementKey(workspaceId, requirementId);
  const state = await getState(key);
  
  // Check active first
  if (state.activeSync && state.activeSync.id === syncId) {
    return state.activeSync;
  }
  // Check history
  return state.history.find(s => s.id === syncId);
}

/**
 * Delete a sync entry from history.
 * @param {string} syncId - Sync task ID to delete
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @returns {Promise<void>}
 */
export async function deleteSyncFromHistory(syncId, workspaceId, requirementId) {
  const key = getRequirementKey(workspaceId, requirementId);
  const state = await getState(key);
  state.history = state.history.filter(s => s.id !== syncId);
  state.timeline = buildSyncTimeline(state.history);
  await saveState(key);
}

/** Remove only the selected execution attempt; never clear a retry's reservation. */
export async function removeSyncTask(task) {
  removedAttempts.add(attemptKey(task));
  task.removed = true;
  const key = getRequirementKey(task.workspaceId, task.requirementId), state = await getState(key);
  const matches = item => item?.id === task.id && item.snapshotDir === task.snapshotDir;
  if (matches(state.activeSync)) {
    state.activeSync.removed = true;
    state.activeSync = null;
    const info = activeSyncControllers.get(key);
    if (info?.syncId === task.id) {
      try { info.controller.abort(); } catch { /* Best effort only. */ }
      deleteAbortController(task.workspaceId, task.requirementId, task.id, info.controller);
    }
  }
  state.history = state.history.filter(item => !matches(item));
  state.timeline = buildSyncTimeline(state.history);
  await saveState(key);
}

// ─── Abort Controller Management ──────────────────────────────────

/**
 * Set abort controller for a running sync task.
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @param {AbortController} controller - Abort controller instance
 * @param {string} syncId - Sync task ID
 * @returns {void}
 */
export function setAbortController(workspaceId, requirementId, controller, syncId) {
  const key = getRequirementKey(workspaceId, requirementId);
  activeSyncControllers.set(key, { controller, syncId });
}

/**
 * Get abort controller for a running sync task.
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @returns {{controller: AbortController, syncId: string}|undefined} Controller info or undefined
 */
export function getAbortController(workspaceId, requirementId) {
  const key = getRequirementKey(workspaceId, requirementId);
  return activeSyncControllers.get(key);
}

/** Called only after the execution owner is absent or has been fenced and aborted. */
export async function recoverSyncTask(task, reason) {
  const active = await getActiveSync(task.workspaceId, task.requirementId);
  if (!active || active.id !== task.id || active.snapshotDir !== task.snapshotDir) return;
  const info = getAbortController(task.workspaceId, task.requirementId);
  if (info?.syncId === task.id) info.controller.abort(new Error(reason));
  taskModel.finishSyncTask(active, { status: 'failed', error: reason });
  await completeSync(task.id, task.workspaceId, task.requirementId, task.snapshotDir);
  deleteAbortController(task.workspaceId, task.requirementId, task.id, info?.controller);
}

/**
 * Delete abort controller entry.
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @returns {void}
 */
export function deleteAbortController(workspaceId, requirementId, syncId, controller) {
  const key = getRequirementKey(workspaceId, requirementId);
  if (syncId && activeSyncControllers.get(key)?.syncId !== syncId) return;
  if (controller && activeSyncControllers.get(key)?.controller !== controller) return;
  activeSyncControllers.delete(key);
}

/**
 * Abort a running sync task.
 * Triggers abort signal, interrupts subagent if running, moves to history.
 * @param {string} syncId - Sync task ID
 * @param {string} workspaceId - Workspace ID
 * @param {string} requirementId - Requirement ID
 * @param {Object} ctx - DSH Context (for interrupting subagent)
 * @param {Object} parentAgent - Parent agent for interrupt authority
 * @returns {Promise<{success: boolean, error?: string}>} Abort result
 */
export async function abortSync(syncId, workspaceId, requirementId, ctx, parentAgent) {
  const key = getRequirementKey(workspaceId, requirementId);
  const state = await getState(key);

  log.state.info(`abortSync 调用`, { syncId, workspaceId, requirementId, key, hasState: !!state, hasActiveSync: !!state?.activeSync, activeSyncId: state?.activeSync?.id });

  // Check if there's a running sync task
  if (!state?.activeSync || state.activeSync.id !== syncId) {
    log.state.warn(`abortSync 失败: 没有正在运行的同步任务`, { syncId, activeSyncId: state?.activeSync?.id });
    return { success: false, error: '没有正在运行的同步任务' };
  }

  // Get abort controller
  const controllerInfo = activeSyncControllers.get(key);

  // 1. Trigger abort signal (prevents new subagent launches)
  if (controllerInfo?.syncId === syncId) controllerInfo.controller.abort();

  // 2. Interrupt running subagent (if any)
  //  注意：ctx.subagents.interrupt() 对 one-shot subagent 是静默空操作
  // 因为 interrupt() 只作用于 continuable 类型的 subagent（ContinuableActivationRegistry.resident）
  // One-shot subagent 通过 SpawnInProcessProvider.start() 直接启动，不注册到 resident Map
  // 因此取消 one-shot subagent 的唯一有效机制是 AbortSignal（已在上面调用 controller.abort()）
  // 如果未来切换到 continuable subagent，可以恢复 interrupt() 调用
  // 保留 currentSubagentSessionId 的读取仅用于日志记录
  if (state.activeSync.currentSubagentSessionId) {
    log.state.info(`One-shot subagent ${state.activeSync.currentSubagentSessionId} 将通过 AbortSignal 取消`);
  }

  // The run owner archives only after its one-shot children have quiesced.
  taskModel.updateSyncTask(state.activeSync, { type: 'cancel' });
  await saveState(key);
  if (controllerInfo?.syncId === syncId) return { success: true, status: 'cancelling' };
  taskModel.finishSyncTask(state.activeSync, { status: 'aborted' });

  // 4. Move to commit-scoped history and refresh the timeline.
  state.history = state.history.filter(item => item.id !== syncId);
  state.history.unshift({ ...state.activeSync });
  state.timeline = buildSyncTimeline(state.history);

  // 5. Clean up activeSync and controller
  state.activeSync = null;
  // Keep the controller until the engine settles, preventing an overlapping retry.

  await saveState(key);

  log.state.info(`Sync ${syncId} aborted for ${key}`);
  return { success: true };
}

