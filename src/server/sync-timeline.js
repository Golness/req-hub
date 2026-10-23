export function buildSyncTimeline(history) {
  return history.map(sync => ({
    id: sync.id, type: 'sync', docType: sync.docType, status: sync.status,
    title: `${sync.docTypeName || sync.docType} · ${sync.status === 'completed' ? '同步成功' : sync.status === 'aborted' ? '已终止' : '同步失败'}`,
    date: new Date(sync.completedAt || sync.abortedAt || sync.startedAt || 0).toISOString(),
    commitHash: sync.commitHash, description: sync.error || sync.branchName,
    files: (sync.generatedFiles || []).map(file => file.fileName),
  }));
}
