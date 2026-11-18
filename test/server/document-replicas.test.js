import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentReplicas, readReplicaFile } from '../../src/server/document-replicas.js';
import { ConversationFiles } from '../../src/server/conversation-files.js';
import { createDocumentRoutes } from '../../src/server/routes/document-routes.js';

let root;
let registry;
let config;
let lark;
let service;
const signal = () => new AbortController().signal;
const cycle = async () => {
  await service.refresh();
  await service.publication;
};
const status = async () => (await service.list('ws')).items;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'reqhub-replicas-test-')));
  await mkdir(join(root, 'workspace', 'docs'), { recursive: true });
  registry = { list: () => [{ id: 'ws', path: join(root, 'workspace') }] };
  config = { docsDir: 'docs', documents: { larkSyncEnabled: true } };
  lark = { pushReplica: vi.fn(async (input) => ({ fileToken: 'File', version: input.version })) };
  service = new DocumentReplicas({
    registry,
    lark,
    directory: join(root, 'control'),
    configLoader: async () => config,
  });
});

it('ignores the historical baseline and saves exact bytes for every new format', async () => {
  await writeFile(join(root, 'workspace/docs/old.md'), 'old');
  await service.start();
  await mkdir(join(root, 'workspace/docs/nested'), { recursive: true });
  const bytes = Buffer.from([0, 255, 5, 0, 10]);
  await writeFile(join(root, 'workspace/docs/nested/archive.bin'), bytes);
  await cycle();
  expect(lark.pushReplica).not.toHaveBeenCalled();
  await cycle();
  expect(lark.pushReplica).toHaveBeenCalledTimes(1);
  expect(lark.pushReplica.mock.calls[0][0].bytes).toEqual(bytes);
  expect(await status()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'old.md', status: 'historical' }),
      expect.objectContaining({ status: 'saved', bytes: bytes.length }),
    ]),
  );
  expect(await readFile(join(root, 'workspace/docs/nested/archive.bin'))).toEqual(bytes);
});

it('deduplicates explicit producer commits and filesystem discovery, including unchanged saves', async () => {
  await service.start();
  const file = join(root, 'workspace/docs/requirement.md');
  await writeFile(file, '# Requirement');
  await service.committed('ws', 'requirement.md', 'sync');
  await service.committed('ws', 'requirement.md', 'sync');
  await cycle();
  await writeFile(file, '# Requirement');
  await cycle();
  await cycle();
  expect(lark.pushReplica).toHaveBeenCalledTimes(1);
});

it('retries a failed branch after restart without regenerating the local file', async () => {
  lark.pushReplica.mockRejectedValueOnce(new Error('LARK_TARGET_NOT_BOUND'));
  await service.start();
  await writeFile(join(root, 'workspace/docs/draft.md'), 'draft');
  await service.committed('ws', 'draft.md', 'writing');
  await cycle();
  expect((await status())[0]).toMatchObject({ status: 'failed', error: 'LARK_TARGET_NOT_BOUND' });
  await service.close();
  service = new DocumentReplicas({
    registry,
    lark,
    directory: join(root, 'control'),
    configLoader: async () => config,
  });
  await service.start();
  await service.retry('ws', 'draft.md');
  await cycle();
  expect((await status())[0].status).toBe('saved');
  expect(await readFile(join(root, 'workspace/docs/draft.md'), 'utf8')).toBe('draft');
});

it('does not let a slow old upload block a new local commit or replace its status', async () => {
  let finish;
  lark.pushReplica.mockImplementationOnce(
    (input) =>
      new Promise((resolve) => {
        finish = () => resolve({ fileToken: 'Old', version: input.version });
      }),
  );
  await service.start();
  const file = join(root, 'workspace/docs/a.md');
  await writeFile(file, 'v1');
  await service.committed('ws', 'a.md', 'writing');
  await service.refresh();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await writeFile(file, 'v2');
  await service.committed('ws', 'a.md', 'writing');
  finish();
  await service.publication;
  expect((await status())[0].status).toBe('queued');
  await cycle();
  expect((await status())[0].result.fileToken).toBe('File');
  expect(lark.pushReplica.mock.calls[1][0].bytes.toString()).toBe('v2');
});

it('retains remote copies when local files disappear and ignores writes while disabled', async () => {
  await service.start();
  await writeFile(join(root, 'workspace/docs/a.md'), 'v1');
  await service.committed('ws', 'a.md');
  await cycle();
  await rm(join(root, 'workspace/docs/a.md'));
  await cycle();
  expect((await status())[0].status).toBe('missing');
  config.documents.larkSyncEnabled = false;
  await cycle();
  await writeFile(join(root, 'workspace/docs/disabled.md'), 'private');
  config.documents.larkSyncEnabled = true;
  await cycle();
  await cycle();
  expect(lark.pushReplica).toHaveBeenCalledTimes(1);
  expect((await status()).find((item) => item.path === 'disabled.md').status).toBe('historical');
});

it('exports new synchronized conversations locally even when Lark is disabled and preserves user edits', async () => {
  config.documents.larkSyncEnabled = false;
  config.documents.maxFileBytes = 1;
  await service.start();
  const input = {
    workspaceId: 'ws',
    source: 'codex',
    id: 'opaque-id',
    signal: signal(),
    snapshot: {
      sessionId: 'session',
      version: 'version',
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
  };
  const local = new ConversationFiles({
    registry,
    directory: root,
    configLoader: async () => config,
  });
  let exported;
  try {
    exported = await local.exportConversation(input);
    const path = join(root, 'workspace/docs', exported.path);
    expect(await readFile(path, 'utf8')).toContain('Question');
    await local.exportConversation(input);
    await writeFile(path, 'User edit');
    await expect(local.exportConversation(input)).rejects.toThrow('DOCUMENT_EXPORT_CONFLICT');
    expect(await readFile(path, 'utf8')).toBe('User edit');
    expect(lark.pushReplica).not.toHaveBeenCalled();
  } finally {
    await local.close();
  }
});

it('rejects escaped links, traversal and complete-file budget overflow', async () => {
  const docs = join(root, 'workspace/docs');
  await writeFile(join(root, 'secret'), 'secret');
  await symlink(root, join(docs, 'outside'), 'junction');
  await expect(readReplicaFile(docs, 'outside/secret', 100, signal())).rejects.toThrow();
  await expect(readReplicaFile(docs, '../secret', 100, signal())).rejects.toThrow();
  await writeFile(join(docs, 'large.bin'), Buffer.alloc(101));
  await expect(readReplicaFile(docs, 'large.bin', 100, signal())).rejects.toThrow(
    'DOCUMENT_FILE_TOO_LARGE',
  );
});

it('refuses blind retry after an ambiguous remote creation', async () => {
  await service.start();
  await writeFile(join(root, 'workspace/docs/a.md'), 'a');
  await service.committed('ws', 'a.md');
  lark.pushReplica.mockRejectedValue(new Error('DOCUMENT_REMOTE_UNCERTAIN'));
  await cycle();
  await expect(service.retry('ws', 'a.md')).rejects.toThrow('DOCUMENT_REMOTE_UNCERTAIN');
  await cycle();
  expect(lark.pushReplica).toHaveBeenCalledTimes(1);
});

it('keeps scan failures visible rather than reporting partial discovery as success', async () => {
  config.documents.maxFiles = 1;
  await writeFile(join(root, 'workspace/docs/a'), 'a');
  await writeFile(join(root, 'workspace/docs/b'), 'b');
  await service.start();
  expect((await service.list('ws')).scanError).toBe('DOCUMENT_SCAN_LIMIT');
  expect(lark.pushReplica).not.toHaveBeenCalled();
});

it('waits for cancellation on unload and does not blindly replay an interrupted upload', async () => {
  let started;
  const reading = new Promise((resolve) => {
    started = resolve;
  });
  lark.pushReplica.mockImplementation(
    ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      }),
  );
  await service.start();
  await writeFile(join(root, 'workspace/docs/a.md'), 'a');
  await service.committed('ws', 'a.md');
  await service.refresh();
  await reading;
  await service.close();
  service = new DocumentReplicas({
    registry,
    lark,
    directory: join(root, 'control'),
    configLoader: async () => config,
  });
  await service.start();
  await service.publication;
  expect((await status())[0].status).toBe('uncertain');
  expect(lark.pushReplica).toHaveBeenCalledTimes(1);
});

it('exposes the same retry operation to agents but verifies their real workspace', async () => {
  await service.start();
  const route = createDocumentRoutes(registry, service).find((item) =>
    item.path.endsWith('/retry'),
  );
  await expect(
    route.operation.execute(
      { workspaceId: 'ws', path: 'a' },
      {
        kind: 'agent',
        agent: { session: { header: { cwd: root } } },
      },
    ),
  ).rejects.toThrow('CALLER_WORKSPACE_MISMATCH');
});
