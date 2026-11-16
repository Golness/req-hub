/**
 * Project stored sync outcomes into timeline items.
 * @param history - Stored sync attempts for the selected requirement.
 * @returns Timeline entries in the same order as the supplied history.
 */
export function buildSyncTimeline(history) {
  return history.map((sync) => {
    let statusLabel = 'STATUS_SYNC_FAILED';
    if (sync.status === 'completed') {
      statusLabel = 'STATUS_SYNC_SUCCEEDED';
    } else if (sync.status === 'aborted') {
      statusLabel = 'STATUS_TERMINATED';
    }
    return {
      id: sync.id,
      type: 'sync',
      docType: sync.docType,
      status: sync.status,
      title: `${sync.docTypeName || sync.docType} · ${statusLabel}`,
      date: new Date(sync.completedAt || sync.abortedAt || sync.startedAt || 0).toISOString(),
      commitHash: sync.commitHash,
      description: sync.error || sync.branchName,
      files: (sync.generatedFiles || []).map((file) => file.fileName),
    };
  });
}
