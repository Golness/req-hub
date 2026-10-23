import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export async function readSyncSnapshot(reqDir, sync) {
  const fileName = sync.docType === 'requirement' ? 'requirement.md' : 'design.md';
  if (sync.schemaVersion !== 2 || !sync.snapshotDir?.startsWith('v2/')) throw new Error('不支持旧版同步快照');
  const root = resolve(reqDir, 'sync-logs', 'v2');
  const path = resolve(reqDir, 'sync-logs', sync.snapshotDir, fileName);
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('无效的快照路径');
  return readFile(path, 'utf8');
}

export async function compareSyncSnapshots(reqDir, history, id1, id2) {
  const oldSync = history.find(sync => sync.id === id1);
  const newSync = history.find(sync => sync.id === id2);
  if (!oldSync || !newSync || oldSync.schemaVersion !== 2 || newSync.schemaVersion !== 2 || id1 === id2 || oldSync.status !== 'completed' || newSync.status !== 'completed'
    || !['requirement', 'design'].includes(oldSync.docType) || oldSync.docType !== newSync.docType) {
    const error = new Error('仅支持同类文档两个不同的成功同步版本对比');
    error.statusCode = 400;
    throw error;
  }
  const [oldContent, newContent] = await Promise.all([readSyncSnapshot(reqDir, oldSync), readSyncSnapshot(reqDir, newSync)]);
  const label = sync => `${sync.docTypeName || sync.docType} · ${(sync.commitHash || sync.id).slice(0, 8)} · ${new Date(sync.startedAt).toLocaleString()}`;
  return { oldContent, newContent, oldLabel: label(oldSync), newLabel: label(newSync) };
}
