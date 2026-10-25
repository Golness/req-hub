import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { KnowledgeStore } from '../../src/server/knowledge/store.js';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { createKnowledgeRoutes } from '../../src/server/routes/knowledge-routes.js';
import { readSource, normalizeSourcePath, hash } from '../../src/server/knowledge/source-reader.js';
import { DatabaseSync } from 'node:sqlite';

let root, service, stores, server;
const path = 'alice/2026-10-22-orders/requirement.md';
const source = (relativePath = path, content = 'v1') => ({ relativePath, contentHash: hash(content) });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'req-hub-knowledge-')); stores = []; await mkdir(join(root, 'docs/alice/2026-10-22-orders'), { recursive: true }); await writeFile(join(root, 'docs', path), '# Orders\n审核后发货'); });
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); server = null; } if (service) { await service.close(); service = null; } for (const store of stores) store.close(); await rm(root, { recursive: true, force: true }); });
function store() { const s = new KnowledgeStore(join(root, `kb-${stores.length}.sqlite`), 'ws'); stores.push(s); return s; }
function makeService(readSourceFile = readSource) {
  service = new KnowledgeService({ registry: { list: () => [{ id: 'ws', path: root }, { id: 'ws2', path: root }] }, configLoader: async () => ({ docsDir: 'docs' }), readSourceFile, databasePath: join(root, 'central/knowledge.sqlite') });
  return service;
}
const request = (key = 'one', files = [path]) => ({ requestKey: key, files: files.map(relativePath => ({ relativePath })) });
async function settle() { await Promise.all([...service.tasks]); }

describe('document storage and retrieval', () => {
  const document = (body = '# 订单\n审核通过后发货', relativePath = path) => ({ ...source(relativePath, body), text: body, coordinate: 'source' });
  it('indexes complete document contents and retrieves text beyond the old model chunk limit', () => {
    const s = store(), other = store();
    const body = '# 完整文档\n' + '不截断正文。'.repeat(10000) + '\n尾部唯一检索内容 order_status';
    const { documentId } = s.publishDocument(document(body), 'fp');
    expect(s.entry(documentId).body).toBe(body);
    expect(s.search('尾部唯一检索内容').hits[0].snippet).toContain('尾部唯一检索内容');
    expect(s.search('order_status').hits).toHaveLength(1);
    expect(() => s.search('" OR * NEAR() 100%')).not.toThrow();
    expect(other.search('order_status').hits).toHaveLength(0);
  });
  it('replaces the whole file on update, preserving document identity and versions', () => {
    const s = store(); const first = s.publishDocument(document(), 'fp').documentId;
    s.publishDocument(document('已取消订单不能发货'), 'fp');
    expect(s.entry(first)).toMatchObject({ version: 2, body: '已取消订单不能发货' });
    expect(s.entry(first).versions).toHaveLength(2);
    expect(s.search('审核').hits).toHaveLength(0);
    expect(s.search('已取消').hits).toHaveLength(1);
  });
  it('keeps same-name files and contradictory content as independent source documents', () => {
    const s = store(), otherPath = 'bob/2026-10-22-orders/requirement.md';
    s.publishDocument(document('必须审核后发货'), 'fp');
    s.publishDocument(document('无需审核可以发货', otherPath), 'fp');
    expect(s.list()).toHaveLength(2);
    s.markMissing(path);
    expect(s.search('无需审核').hits[0].sources[0].relativePath).toBe(otherPath);
    expect(s.list()).toHaveLength(1);
  });
  it('rolls back source and FTS changes if document publication fails', () => {
    const s = store(), initial = document(); s.publishDocument(initial, 'fp');
    expect(() => s.publishDocument({ ...document('changed'), text: null }, 'fp')).toThrow();
    expect(s.source(path).hash).toBe(initial.contentHash);
    expect(s.search('审核').hits).toHaveLength(1);
  });
  it('rejects legacy or newer databases without adapting data', async () => {
    const dbPath = join(root, 'kb-0.sqlite'), legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE entries(body TEXT); INSERT INTO entries VALUES ('旧模型内容'); PRAGMA user_version=2;");
    legacy.close();
    expect(() => store()).toThrow('不做历史数据适配');
    await rm(dbPath);
    const s = store(); expect(s.list()).toHaveLength(0);
    s.db.exec('PRAGMA user_version=99');
    expect(() => new KnowledgeStore(dbPath, 'ws')).toThrow('历史数据');
  });
  it('shares one database across workspace sources without collisions or version leakage', async () => {
    const database = new KnowledgeStore(join(root, 'central/knowledge.sqlite')); stores.push(database);
    const a = database.scoped('one', { id: 'a', title: 'A' }, root, join(root, 'docs'));
    const b = database.scoped('two', { id: 'b', title: 'B' }, root, join(root, 'docs'));
    expect(a.db).toBe(b.db);
    const first = a.publishDocument(document('工作区 A 正文'), 'fp');
    const second = b.publishDocument(document('工作区 B 正文'), 'fp');
    expect(first.documentId).not.toBe(second.documentId);
    a.publishDocument(document('工作区 A 更新正文'), 'fp');
    expect(a.entry(first.documentId).version).toBe(2);
    expect(b.entry(second.documentId).version).toBe(1);
    expect(b.entry(first.documentId)).toBeNull();
    expect(database.search('正文').hits).toHaveLength(2);
    const files = await readdir(join(root, 'central/documents'));
    expect(files).toHaveLength(2);
    const contents = await Promise.all(files.map(file => readFile(join(root, 'central/documents', file), 'utf8')));
    expect(contents.some(content => content.includes('工作区 A 更新正文') && content.includes('workspaceId: "a"'))).toBe(true);
    expect(contents.some(content => content.includes('工作区 B 正文') && content.includes('workspaceId: "b"'))).toBe(true);
    await rm(join(root, 'central/documents', files[0]));
    database.syncDocuments();
    expect(await readdir(join(root, 'central/documents'))).toHaveLength(2);
    expect(await readFile(join(root, 'docs', path), 'utf8')).toBe('# Orders\n审核后发货');
  });

});

describe('selected file boundaries and builds', () => {
  it('normalizes Windows tree paths and rejects traversal, unsupported files and unrelated directories', () => {
    expect(normalizeSourcePath(path.replaceAll('/', '\\'))).toBe(path);
    for (const bad of ['../secrets.md', '/tmp/a.md', 'C:/a.md', 'alice/random/x.md', 'alice/2026-10-22-orders/a.exe', 'alice/2026-10-22-orders/../../a.md']) expect(() => normalizeSourcePath(bad)).toThrow();
  });
  it('strips executable HTML and preserves JSON structure while bounding oversized long lines', async () => {
    const html = path.replace('.md', '.html'), json = path.replace('.md', '.json');
    await writeFile(join(root, 'docs', html), '<h1>订单</h1><script>secret()</script><style>bad{}</style><p>审核 &amp; 发货</p>');
    await writeFile(join(root, 'docs', json), '{"status":"paid"}');
    expect((await readSource(join(root, 'docs'), html)).text.trim()).toBe('订单\n审核 & 发货');
    expect((await readSource(join(root, 'docs'), json)).text).toContain('"status": "paid"');
    await writeFile(join(root, 'docs', path), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    await expect(readSource(join(root, 'docs'), path)).rejects.toMatchObject({ status: 413 });
  });
  it('rejects a selected file escaping docsRoot through a symbolic link', async () => {
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside/secret.md'), 'private');
    const link = 'alice/2026-10-22-orders/link/secret.md';
    await symlink(join(root, 'outside'), join(root, 'docs/alice/2026-10-22-orders/link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readSource(join(root, 'docs'), link)).rejects.toThrow('越界');
  });
  it('builds without sessions or model services, indexes only selected files and skips unchanged content', async () => {
    const reader = vi.fn(readSource), svc = makeService(reader), scope = await svc.scope('ws');
    await writeFile(join(root, 'docs/alice/2026-10-22-orders/unselected.md'), 'never read');
    const { job } = await svc.build(scope, request()); await settle();
    expect(scope.store.job(job.id).status).toBe('completed');
    expect(scope.store.list()[0].body).toBe('# Orders\n审核后发货');
    expect(reader.mock.calls.every(([, selected]) => selected === path)).toBe(true);
    expect((await svc.build(scope, request())).job.id).toBe(job.id);
    const next = await svc.build(scope, request('two')); await settle();
    expect(scope.store.job(next.job.id).files[0].status).toBe('skipped');
    expect((await svc.scope('ws2')).store.search('审核').hits).toHaveLength(0);
  });
  it('serializes duplicate builds and refuses another active build', async () => {
    let release, calls = 0;
    const svc = makeService(async (...args) => { if (++calls === 2) await new Promise(r => { release = r; }); return readSource(...args); }), scope = await svc.scope('ws');
    const [a,b] = await Promise.all([svc.build(scope, request()), svc.build(scope, request())]);
    expect(a.job.id).toBe(b.job.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(svc.build(scope, request('two'))).rejects.toMatchObject({ status: 409 });
    release(); await settle();
  });
  it('does not publish a file after cancellation during parsing', async () => {
    let release, calls = 0;
    const svc = makeService(async (...args) => { if (++calls === 2) await new Promise(r => { release = r; }); return readSource(...args); }), scope = await svc.scope('ws');
    const { job } = await svc.build(scope, request()); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    svc.cancel(scope, job.id); release(); await settle();
    expect(scope.store.job(job.id).status).toBe('cancelled'); expect(scope.store.list()).toHaveLength(0);
  });
  it('protects against source changes during parsing and reports file failures separately', async () => {
    let calls = 0;
    const svc = makeService(async (...args) => { const source = await readSource(...args); if (++calls === 2) await writeFile(join(root, 'docs', path), 'modified'); return source; }), scope = await svc.scope('ws');
    const { job } = await svc.build(scope, request('one', [path, 'alice/2026-10-22-orders/missing.md'])); await settle();
    expect(scope.store.job(job.id).status).toBe('partial');
    expect(scope.store.job(job.id).files.map(f => f.status).sort()).toEqual(['failed', 'stale']);
    expect(scope.store.list()).toHaveLength(0);
  });
  it('restores interrupted work after restart without marking it successful', () => {
    const s = store(); s.saveJob({ id: 'j', requestKey: 'k', fingerprint: 'f', status: 'running', files: [{ relativePath: path, status: 'running' }] });
    s.close(); stores.pop();
    const reopened = store(); expect(reopened.job('j').status).toBe('interrupted'); expect(reopened.job('j').files[0].status).toBe('interrupted');
  });
  it('marks a changed source stale and restores it after rebuilding', async () => {
    const svc = makeService(), scope = await svc.scope('ws');
    await svc.build(scope, request()); await settle();
    await svc.refreshSources(scope);
    await writeFile(join(root, 'docs', path), 'changed content');
    await svc.refreshSources(scope);
    expect(scope.store.search('审核').hits[0].sources[0].status).toBe('stale');
    await svc.build(scope, request('updated')); await settle();
    await svc.refreshSources(scope);
    expect(scope.store.search('changed content').hits[0].sources[0].status).toBe('active');
    expect(scope.store.search('审核').hits).toHaveLength(0);
  });
  it('keeps exact raw line locators and labels transformed JSON coordinates separately', async () => {
    const text = '\n\n# Title\n' + '正文\n'.repeat(100);
    await writeFile(join(root, 'docs', path), text);
    expect((await readSource(join(root, 'docs'), path)).text).toBe(text);
    const file = path.replace('.md', '.json'); await writeFile(join(root, 'docs', file), '{"x":1}');
    expect((await readSource(join(root, 'docs'), file)).coordinate).toBe('extracted');
  });
});

it('searches all workspaces while keeping builds and document details bound to their origin', async () => {
  const api = createKnowledgeRoutes({ list: () => [{ id: 'ws', path: root }, { id: 'other', path: root }] }, { configLoader: async () => ({ docsDir: 'docs' }), databasePath: join(root, 'central/knowledge.sqlite') });
  service = api.service;
  server = createServer(api.routes[0].handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/req-hub/knowledge`;
  let res = await fetch(base + '/builds', { method: 'POST', body: JSON.stringify({ ...request(), workspaceId: 'ws' }) });
  expect(res.status).toBe(202); const job = await res.json(); await settle();
  res = await fetch(`${base}/builds/${job.id}?workspaceId=other`); expect(res.status).toBe(404);
  const events = await (await fetch(`${base}/builds/${job.id}/events?workspaceId=ws`)).text(); expect(events).toContain('"status":"completed"');
  const result = await (await fetch(base + '/search?workspaceId=ws&q=审核')).json(); expect(result.hits).toHaveLength(1);
  const detail = await (await fetch(`${base}/entries/${result.hits[0].id}?workspaceId=ws`)).json(); expect(detail.versions).toHaveLength(1);
  expect((await fetch(`${base}/entries/${result.hits[0].id}?workspaceId=other`)).status).toBe(404);
  expect(result.hits[0].workspaceId).toBe('ws');
  expect(result.hits[0].sources[0].workspaceId).toBe('ws');
  const fromEmptyWorkspace = await (await fetch(base + '/search?workspaceId=other&q=审核')).json();
  expect(fromEmptyWorkspace.hits).toHaveLength(1);
  const globalStatus = await (await fetch(base + '/search/status')).json();
  expect(globalStatus.ready).toBe(true);
  const global = await (await fetch(base + '/search?q=审核')).json();
  expect(global.hits).toHaveLength(1);
  expect((await fetch(base + '/status')).status).toBe(400);
  await rm(join(root, 'docs', path));
  expect((await (await fetch(base + '/search?workspaceId=ws&q=审核')).json()).hits).toHaveLength(0);
  await api.dispose(); service = null;
});

it('checks ingestion by exact source path independently of entry pagination and workspace', async () => {
  const api = createKnowledgeRoutes({ list: () => [{ id: 'ws', path: root }, { id: 'other', path: root }] }, { configLoader: async () => ({ docsDir: 'docs' }), databasePath: join(root, 'central/knowledge.sqlite') });
  service = api.service;
  server = createServer(api.routes[0].handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/req-hub/knowledge/source`;
  const url = workspaceId => `${base}?${new URLSearchParams({ workspaceId, path })}`;
  expect(await (await fetch(url('ws'))).json()).toMatchObject({ indexed: false, status: 'not_imported' });
  const scope = await service.scope('ws');
  scope.store.publishDocument(await readSource(scope.docsRoot, path), 'fp');
  for (let i = 0; i < 101; i++) scope.store.publishDocument({ relativePath: path.replace('requirement.md', `other-${i}.md`), contentHash: hash('other'), text: 'other' }, 'fp');
  expect(scope.store.list().some(entry => entry.sources[0].relativePath === path)).toBe(false);
  expect(await (await fetch(url('ws'))).json()).toMatchObject({ indexed: true, status: 'active' });
  expect(await (await fetch(url('other'))).json()).toMatchObject({ indexed: false });
  await writeFile(join(root, 'docs', path), '# Updated');
  expect(await (await fetch(url('ws'))).json()).toMatchObject({ indexed: true, status: 'stale' });
  expect((await fetch(`${base}?${new URLSearchParams({ workspaceId: 'ws', path: '../secret.md' })}`)).status).toBe(400);
  await api.dispose(); service = null;
});

it('merges persisted workspaces with global ranking, limits, provenance and partial failure reporting', async () => {
  let svc = makeService();
  const first = await svc.scope('ws'), second = await svc.scope('ws2');
  for (let i = 0; i < 3; i++) {
    const relativePath = path.replace('requirement.md', `file-${i}.md`);
    await writeFile(join(root, 'docs', relativePath), i === 0 ? '审核 发货' : '审核');
    const parsed = await readSource(join(root, 'docs'), relativePath);
    first.store.publishDocument(parsed, 'fp'); second.store.publishDocument(parsed, 'fp');
  }
  await svc.close(); service = null;
  svc = makeService(); // Search must discover databases without visiting their workspaces first.
  const page = await svc.searchAll('审核 发货', 1);
  expect(page.hits).toHaveLength(1); expect(page.hasMore).toBe(true);
  expect(page.hits[0].sources[0].relativePath).toContain('file-0.md');
  const all = await svc.searchAll('审核', 100);
  expect(all.hits).toHaveLength(6); expect(all.hasMore).toBe(false);
  expect(new Set(all.hits.map(hit => hit.workspaceId))).toEqual(new Set(['ws', 'ws2']));
  for (const hit of all.hits) expect(hit.sources[0].workspaceId).toBe(hit.workspaceId);
  svc.registry = { list: () => [] };
  // Removing workspace registrations must not discard the central knowledge contents.
  expect((await svc.searchAll('审核')).hits).toHaveLength(6);
  expect(await readdir(join(root, 'central'))).not.toContain('knowledge-ws.sqlite');
  await expect(readdir(join(root, '.req-hub/knowledge'))).rejects.toMatchObject({ code: 'ENOENT' });
});
