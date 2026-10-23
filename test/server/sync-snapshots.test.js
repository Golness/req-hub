import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSyncSnapshots } from '../../src/server/sync-snapshots.js';
let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'req-hub-snapshots-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const version = (id, docType = 'requirement', status = 'completed') => ({ schemaVersion:2,id, docType, status, startedAt: 1, snapshotDir: 'v2/' + id });
const snapshot = async (id, fileName, content) => {
  await mkdir(join(dir, 'sync-logs', 'v2', id), { recursive: true });
  await writeFile(join(dir, 'sync-logs', 'v2', id, fileName), content);
};
describe('successful sync snapshots', () => {
  it.each(['requirement', 'design'])('reads exact %s success snapshots including empty content', async type => {
    await snapshot('a', `${type}.md`, ''); await snapshot('b', `${type}.md`, 'new');
    expect(await compareSyncSnapshots(dir, [version('a', type), version('b', type)], 'a', 'b'))
      .toMatchObject({ oldContent: '', newContent: 'new' });
  });
  it.each(['failed', 'aborted', 'running'])('rejects %s versions on the server', async status => {
    await expect(compareSyncSnapshots(dir, [version('a'), version('b', 'requirement', status)], 'a', 'b')).rejects.toThrow('成功同步');
  });
  it('rejects different document types, identical versions, unknown IDs and traversal', async () => {
    await expect(compareSyncSnapshots(dir, [version('a'), version('b', 'design')], 'a', 'b')).rejects.toThrow('同类文档');
    await expect(compareSyncSnapshots(dir, [version('a')], 'a', 'a')).rejects.toThrow();
    await expect(compareSyncSnapshots(dir, [], '../a', 'b')).rejects.toThrow();
    await expect(compareSyncSnapshots(dir, [version('../a'), version('b')], '../a', 'b')).rejects.toThrow('无效');
  });
  it('never falls back to .prev or another document type', async () => {
    await snapshot('a', 'requirement.md.prev', 'wrong'); await snapshot('a', 'design.md', 'wrong');
    await snapshot('b', 'requirement.md', 'new');
    await expect(compareSyncSnapshots(dir, [version('a'), version('b')], 'a', 'b')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects legacy snapshots instead of importing generated-file paths', async () => {
    await snapshot('sync-123', 'requirement.md', 'legacy'); await snapshot('b', 'requirement.md', 'new');
    const legacy = { ...version('sync-100'), snapshotDir: undefined, generatedFiles: [{ fileName: 'sync-logs/sync-123/code-diffs.md' }] };
    await expect(compareSyncSnapshots(dir, [legacy, version('b')], 'sync-100', 'b')).rejects.toThrow('旧版');
  });
});
