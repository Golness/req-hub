import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore, hash } from '../../src/server/conversations/store.js';
import { ConversationService } from '../../src/server/conversations/service.js';
import { clearRetiredWorkspaceConversations, removeRetiredCodexStore } from '../../src/server/conversations/retired-storage.js';
import { createConversationRoutes } from '../../src/server/routes/conversation-routes.js';
import { createOperations } from '../../src/server/operations.js';
import { dshSource } from '../../src/server/conversations/dsh-source.js';
import { Readable } from 'node:stream';

let root, store, library;
const snap = (sessionId, text = 'final') => {
  const turns = [{ sessionId, turnNumber: 1, syncable: true, messages: [{ role: 'user', label: '用户输入', kind: 'input', text: 'input' }, { role: 'assistant', label: '助手最终回复', kind: 'final', text }] }];
  return { sessionId, version: hash(JSON.stringify(turns)), turns, turnCount: 1, syncTurnCount: 1, totalTokens: 10 };
};
const provider = (source = 'dsh', instance = 'profile-a', id = 'one') => ({ source, instance,
  inventory: async () => ({ workspaces: [{ id: 'project', title: 'Project' }], sessions: [{ id, title: 'Title', workspaceId: 'project' }], warnings: [] }),
  snapshot: async row => snap(row.id),
});
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rh-conversations-')); store = new ConversationStore(join(root, 'library/conversations.sqlite')); library = new ConversationService({ store, owner: 'profile-a' }); });
afterEach(async () => { await library.close(); await store.close(); await rm(root, { recursive: true, force: true }); });

it('stores both sources identically, deduplicates refreshes, and restores missing Markdown from SQLite', async () => {
  const dsh = provider(), codex = provider('codex', 'codex-home', 'codex:one');
  const a = (await library.refresh('ws', 'project', dsh)).sessions[0];
  const b = (await library.refresh('ws', 'project', codex)).sessions[0];
  expect(a.conversationId).not.toBe(b.conversationId);
  await library.refresh('ws', 'project', dsh);
  expect((await store.database()).prepare('SELECT count(*) AS n FROM snapshots').get().n).toBe(2);
  const file = join(root, 'library', a.markdownFile);
  expect(await readFile(file, 'utf8')).toContain('source: "dsh"');
  await rm(file); expect((await library.snapshot('ws', 'one', dsh)).version).toBe(a.snapshotVersion);
  expect(await readFile(file, 'utf8')).toContain('用户输入');
});

it('reads prototype-backed DSH workspace fields without copying the host entity internals', async () => {
  class Workspace {
    constructor() { this.id = 'project'; this.host = { privateService: true }; }
    get path() { return root; }
    get title() { return 'DSH workspace'; }
  }
  const workspace = new Workspace();
  const adapter = dshSource({ registry: { list: () => [workspace] }, instance: 'profile-a',
    sessions: { list: () => [{ header: { id: 'one', cwd: root } }], get: () => ({ snapshotEvents: () => [] }) } });
  const inventory = await adapter.inventory('project');
  expect(inventory.workspaces).toEqual([{ id: 'project', path: root, title: 'DSH workspace', paths: [root] }]);
  expect(inventory.sessions.map(session => session.id)).toEqual(['one']);
  const imported = await library.refresh('project', 'project', adapter);
  expect(imported.workspace).toMatchObject({ id: 'project', path: root, title: 'DSH workspace' });
  expect(imported.workspace).not.toHaveProperty('host');
  expect(imported.sessions[0].snapshotVersion).toBeDefined();
});

it('streams DSH acquisition progress through the shared refresh route and stores the same library snapshot', async () => {
  const adapter = provider();
  const route = createConversationRoutes({ list: () => [{ id: 'project' }] }, library, [adapter]).find(route => route.path.endsWith('-refresh'));
  const input = body => Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' });
  const events = [], res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, write(line) { events.push(JSON.parse(line)); }, end() {} };
  await route.handler(input({ workspaceId: 'project', source: 'dsh', stream: true }), res);
  expect(res.headers['Content-Type']).toContain('application/x-ndjson');
  expect(events.filter(event => event.type === 'progress').map(event => event.phase)).toEqual(['queued', 'inventory', 'importing', 'importing', 'saving']);
  const entry = events.at(-1).result.sessions[0];
  expect(entry.id).toBe('one');
  expect((await library.list('project', adapter)).sessions[0].snapshotVersion).toBe(entry.snapshotVersion);
  expect(await readFile(join(root, 'library', entry.markdownFile), 'utf8')).toContain('助手最终回复');
  events.length = 0;
  adapter.inventory = async () => { throw Error('SOURCE_UNAVAILABLE'); };
  await route.handler(input({ workspaceId: 'project', source: 'dsh', stream: true }), res);
  expect(events.at(-1)).toEqual({ type: 'error', error: 'SOURCE_UNAVAILABLE' });
  expect(events.some(event => event.type === 'result')).toBe(false);
});

it('isolates native IDs across source instances, profiles and workspace bindings', async () => {
  const first = provider(); const second = provider('dsh', 'profile-b');
  const a = (await library.refresh('ws', 'project', first)).sessions[0];
  const other = new ConversationService({ store, owner: 'profile-b' });
  try {
    expect((await other.list('ws', first)).sessions).toEqual([]);
    const b = (await other.refresh('ws', 'project', second)).sessions[0]; expect(a.conversationId).not.toBe(b.conversationId);
    expect((await library.list('unbound', first)).sessions).toEqual([]);
    await expect(library.snapshot('unbound', 'one', first)).rejects.toThrow('SESSION_WORKSPACE_MISSING');
    const operations = createOperations(createConversationRoutes({ list: () => [{ id: 'unbound' }] }, library, [first]));
    expect((await operations.execute({ action: 'conversations-detail', query: { workspaceId: 'unbound', id: a.conversationId } }, {})).status).toBe(404);
  } finally { await other.close(); }
});

it('rejects changed/archived evidence and preserves pinned versions until task deletion', async () => {
  const adapter = provider(), first = (await library.refresh('ws', 'project', adapter)).sessions[0];
  const frozen = await library.snapshot('ws', 'one', adapter); await store.pin('task', [frozen]);
  adapter.snapshot = async row => snap(row.id, 'changed');
  await expect(library.snapshot('ws', 'one', adapter)).rejects.toThrow('SESSION_CHANGED');
  await library.refresh('ws', 'project', adapter);
  await expect(store.remove(first.conversationId, first.snapshotVersion)).rejects.toThrow('SESSION_VERSION_IN_USE');
  await expect(store.remove(first.conversationId)).rejects.toThrow('SESSION_VERSION_IN_USE');
  expect((await store.versions(first.conversationId))).toHaveLength(2);
  await store.unpin('task'); await store.remove(first.conversationId, first.snapshotVersion);
  expect((await store.versions(first.conversationId))).toHaveLength(1);
  adapter.inventory = async () => ({ workspaces: [{ id: 'project' }], sessions: [], warnings: [] });
  await expect(library.snapshot('ws', 'one', adapter)).rejects.toThrow('SESSION_ARCHIVED');
  expect((await library.refresh('ws', 'project', adapter)).sessions).toEqual([]);
  await store.remove(first.conversationId); expect(await library.accessible('ws', [adapter])).toEqual([]);
});

it('does not invalidate cached sessions when inventory fails and does not publish cancelled reads', async () => {
  const adapter = provider(); const first = (await library.refresh('ws', 'project', adapter)).sessions[0];
  adapter.inventory = async () => { throw Error('source unavailable'); };
  await expect(library.refresh('ws', 'project', adapter)).rejects.toThrow('source unavailable');
  expect((await library.list('ws', adapter)).sessions[0].snapshotVersion).toBe(first.snapshotVersion);
  Object.assign(adapter, provider());
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  adapter.snapshot = () => new Promise(resolve => { release = () => resolve(snap('one', 'must not publish')); started(); });
  const pending = library.refresh('ws', 'project', adapter); await ready;
  library.cancel('ws'); release(); await expect(pending).rejects.toThrow('SESSION_REFRESH_CANCELLED');
  expect((await library.list('ws', adapter)).sessions[0].snapshotVersion).toBe(first.snapshotVersion);
  const jobs = (await store.database()).prepare('SELECT payload FROM jobs').all().map(row => JSON.parse(row.payload));
  expect(jobs.map(job => job.status)).toEqual(['completed', 'failed', 'cancelled']);
});

it('persists queued progress, waits for shutdown and recovers unfinished jobs only for the same owner', async () => {
  const adapter = provider(); let release, started; const ready = new Promise(resolve => { started = resolve; });
  adapter.snapshot = () => new Promise(resolve => { release = () => resolve(snap('one')); started(); });
  const first = library.refresh('ws', 'project', adapter); await ready;
  const next = library.refresh('ws', 'project', provider()); await new Promise(resolve => setTimeout(resolve, 5));
  const db = await store.database(); expect(db.prepare("SELECT count(*) AS n FROM jobs WHERE json_extract(payload,'$.status')='queued'").get().n).toBe(1);
  let closed = false; const closing = library.close().then(() => { closed = true; });
  expect(closed).toBe(false); release(); await Promise.allSettled([first, next]); await closing;
  db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('stale-a', '', JSON.stringify({ owner: 'profile-a', status: 'running' }));
  db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('live-b', '', JSON.stringify({ owner: 'profile-b', status: 'running' }));
  library = new ConversationService({ store, owner: 'profile-a' }); await library.ready();
  expect(JSON.parse(db.prepare('SELECT payload FROM jobs WHERE id=?').get('stale-a').payload).status).toBe('interrupted');
  expect(JSON.parse(db.prepare('SELECT payload FROM jobs WHERE id=?').get('live-b').payload).status).toBe('running');
});

it('deletes the retired Codex store without importing it or touching source and knowledge data', async () => {
  await mkdir(join(root, 'req-hub/codex/documents'), { recursive: true }); await writeFile(join(root, 'req-hub/codex/codex.sqlite'), 'old');
  await mkdir(join(root, 'req-hub/knowledge'), { recursive: true }); await writeFile(join(root, 'req-hub/knowledge/keep'), 'knowledge');
  await mkdir(join(root, '.codex')); await writeFile(join(root, '.codex/source'), 'source');
  await removeRetiredCodexStore(root);
  await expect(access(join(root, 'req-hub/codex'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(root, 'req-hub/knowledge/keep'), 'utf8')).toBe('knowledge');
  expect(await readFile(join(root, '.codex/source'), 'utf8')).toBe('source');
  await symlink(join(root, '.codex'), join(root, 'req-hub/codex'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(removeRetiredCodexStore(root)).rejects.toThrow('RETIRED_STORE_SYMLINK');
});

it('removes only historical conversation files and links, retaining documents and new evidence', async () => {
  const req = join(root, 'docs/alice/2026-10-25-example'), old = 'v2/old/attempt', current = 'v2/new/attempt';
  for (const dir of [old, current]) {
    await mkdir(join(req, 'sync-logs', dir, 'input/sessions'), { recursive: true });
    await writeFile(join(req, 'sync-logs', dir, 'input/sessions/session-1.md'), 'session');
  }
  await writeFile(join(req, 'requirement.md'), 'published');
  const state = { history: [{ snapshotDir: old, sessionIds: ['s'], generatedFiles: [{ fileName: `sync-logs/${old}/input/sessions/session-1.md` }] }, { snapshotDir: current, sessionIds: ['s'], conversationStorageVersion: 1 }] };
  await writeFile(join(req, 'sync-logs/v2/.sync-state.json'), JSON.stringify(state));
  await clearRetiredWorkspaceConversations(root, 'docs');
  await expect(access(join(req, 'sync-logs', old, 'input/sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(req, 'sync-logs', current, 'input/sessions/session-1.md'), 'utf8')).toBe('session');
  expect(await readFile(join(req, 'requirement.md'), 'utf8')).toBe('published');
  const clean = JSON.parse(await readFile(join(req, 'sync-logs/v2/.sync-state.json'), 'utf8'));
  expect(clean.history[0].sessionIds).toEqual([]); expect(clean.history[0].generatedFiles).toEqual([]);
});
