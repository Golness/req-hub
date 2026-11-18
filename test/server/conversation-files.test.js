import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConversationFiles } from '../../src/server/conversation-files.js';
import { withDocumentLock } from '../../src/server/sync-document-validator.js';

let root, service, registry;
const configLoader = async () => ({
  docsDir: 'docs',
  documents: { larkSyncEnabled: false, maxFileBytes: 1 },
});
const input = () => ({
  workspaceId: 'ws',
  source: 'codex',
  id: 'session',
  snapshot: {
    sessionId: 'session',
    version: 'v1',
    turns: [
      {
        turnNumber: 1,
        messages: [
          { role: 'user', text: 'Question' },
          { role: 'assistant', text: 'Answer' },
        ],
      },
    ],
  },
});
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'reqhub-local-conversations-')));
  await mkdir(join(root, 'workspace/docs'), { recursive: true });
  registry = { list: () => [{ id: 'ws', path: join(root, 'workspace') }] };
  service = new ConversationFiles({ registry, directory: root, configLoader });
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

it('waits for a canceled export to leave its file lock before closing storage', async () => {
  const first = await service.exportConversation(input());
  const target = join(root, 'workspace/docs', first.path);
  let release;
  const lock = withDocumentLock(
    target,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const scope = vi.spyOn(service, 'scope');
  const operation = service.exportConversation({
    ...input(),
    snapshot: { ...input().snapshot, version: 'v2' },
  });
  await vi.waitFor(() => expect(scope).toHaveBeenCalled());
  await scope.mock.results[0].value;
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await lock;
  await expect(operation).rejects.toThrow();
  await closing;
  expect(await readFile(target, 'utf8')).toContain('version: "v1"');
});

it('retains prior local export ownership using metadata without requiring Feishu to run', async () => {
  const first = await service.exportConversation(input());
  const ownership = service.db.prepare('SELECT id,hash FROM exports').get();
  await service.close();
  await rm(join(root, 'conversation-files.sqlite'));
  const retired = new DatabaseSync(join(root, 'document-replicas.sqlite'));
  retired.exec('CREATE TABLE exports(id TEXT PRIMARY KEY,hash TEXT)');
  retired.prepare('INSERT INTO exports VALUES(?,?)').run(ownership.id, ownership.hash);
  retired.close();
  service = new ConversationFiles({ registry, directory: root, configLoader });
  const second = await service.exportConversation({
    ...input(),
    snapshot: { ...input().snapshot, version: 'v2' },
  });
  expect(second.path).toBe(first.path);
  expect(await readFile(join(root, 'workspace/docs', second.path), 'utf8')).toContain(
    'version: "v2"',
  );
});
