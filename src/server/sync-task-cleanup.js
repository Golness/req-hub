import { getSyncScope } from './sync-state.js';
/**
 * Validate task storage ownership before constructing cleanup.
 * @param _requirementPath - Retained positional argument; cleanup uses the task storage identity.
 * @param task - The scoped task record.
 * @returns An async cleanup callback restricted to the validated attempt.
 */
export async function planSyncTaskCleanup(_requirementPath, task) {
  const scope = getSyncScope(task.workspaceId, task.requirementId);
  if (!scope || task.storageVersion !== 1 || task.scopeKey !== scope.key) {
    throw new Error('SYNC_DELETE_PATH_INVALID');
  }
  scope.store.attemptRoot(task);
  return async () => {
    scope.store.cleanup(task);
    scope.store.collect(scope.workspaceKey);
  };
}
