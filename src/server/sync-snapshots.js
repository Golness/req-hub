import { readFile } from 'node:fs/promises';
import { getSyncScope } from './sync-state.js';
import taskModel from '../shared/sync-task.cjs';
import clock from '../shared/time.cjs';

/**
 * Read only the artifact recorded for the selected sync attempt.
 * @param reqDir - Authorized requirement directory.
 * @param sync - The selected sync attempt.
 * @returns Snapshot content and metadata.
 */
export async function readSyncSnapshot(reqDir, sync) {
  const fileName = sync.docType === 'requirement' ? 'requirement.md' : 'design.md';
  const scope = getSyncScope(sync.workspaceId, sync.requirementId);
  if (sync.storageVersion !== 1 || !scope || scope.path !== reqDir || scope.key !== sync.scopeKey) {
    throw new Error('SYNC_SNAPSHOT_SCOPE');
  }
  return readFile(scope.store.file(sync, fileName), 'utf8');
}

/**
 * Compare the recorded artifacts of two authorized attempts.
 * @param reqDir - Authorized requirement directory.
 * @param history - Stored sync attempts for the selected requirement.
 * @param id1 - The first attempt identity within the requirement history.
 * @param id2 - The second attempt identity within the requirement history.
 * @param timeZone - Saved general time zone used for comparison labels.
 * @returns The version-comparison result.
 */
export async function compareSyncSnapshots(
  reqDir,
  history,
  id1,
  id2,
  timeZone = clock.DEFAULT_TIME_ZONE,
) {
  const oldSync = history.find((sync) => sync.id === id1);
  const newSync = history.find((sync) => sync.id === id2);
  if (
    !oldSync ||
    !newSync ||
    oldSync.schemaVersion !== 2 ||
    newSync.schemaVersion !== 2 ||
    id1 === id2 ||
    !taskModel.hasPublishedDocument(oldSync) ||
    !taskModel.hasPublishedDocument(newSync) ||
    !['requirement', 'design'].includes(oldSync.docType) ||
    oldSync.docType !== newSync.docType
  ) {
    const error = new Error('ERR_COMPARE_REQUIRES_TWO_SUCCESS_VERSIONS');
    error.statusCode = 400;
    throw error;
  }
  const [oldContent, newContent] = await Promise.all([
    readSyncSnapshot(reqDir, oldSync),
    readSyncSnapshot(reqDir, newSync),
  ]);
  const label = (sync) =>
    `${sync.docTypeName || sync.docType} · ${(sync.commitHash || sync.id).slice(0, 8)} · ${clock.formatTimestamp(sync.startedAt, timeZone)}`;
  const version = (sync) => ({
    label: `${sync.docTypeName || sync.docType} · ${(sync.commitHash || sync.id).slice(0, 8)}`,
    startedAt: sync.startedAt,
  });
  return {
    oldContent,
    newContent,
    oldLabel: label(oldSync),
    newLabel: label(newSync),
    oldVersion: version(oldSync),
    newVersion: version(newSync),
  };
}
