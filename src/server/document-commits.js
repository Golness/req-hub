/**
 * Notify independent consumers after a successful local commit.
 * Reporting is queued under its own owner and never delays or gates Feishu registration.
 * @param consumers - Independently owned documents and dailyReports services.
 * @param workspaceId - Authorized producing workspace.
 * @param path - Committed docs-relative path.
 * @param source - Producer kind.
 * @returns Feishu's local queue result; remote publication remains asynchronous.
 */
export function notifyDocumentCommit(consumers, workspaceId, path, source) {
  const daily = Promise.resolve().then(() =>
    consumers.dailyReports?.committed(workspaceId, path, source),
  );
  // The daily service persists its own observation errors and awaits work on disposal.
  void daily.catch(() => {});
  return Promise.resolve()
    .then(() => consumers.documents?.committed(workspaceId, path, source))
    .catch((error) => ({ status: 'failed', error: error.code || 'DOCUMENT_REGISTER_FAILED' }));
}
