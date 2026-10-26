import { getSyncScope } from './sync-state.js';
export async function planSyncTaskCleanup(_requirementPath, task) {
  const scope = getSyncScope(task.workspaceId, task.requirementId);
  if (!scope || task.storageVersion !== 1 || task.scopeKey !== scope.key) throw new Error('SYNC_DELETE_PATH_INVALID');
  scope.store.attemptRoot(task);
  return async () => { scope.store.cleanup(task); scope.store.collect(scope.workspaceKey); };
}
