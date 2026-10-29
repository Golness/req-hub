import {bindOwnedSession} from '../../src/server/delegation-context.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WritingRuntime, installWritingTools, WRITING_TOOLS } from '../../src/server/writing-runtime.js';
import { createWritingRoutes } from '../../src/server/routes/writing-routes.js';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { PROMPT_REGISTRY } from '../../src/server/prompts.js';
import { createOperations } from '../../src/server/operations.js';

const doc = (id, scopeId, body = '审核后发货') => ({ id, scopeId, body, title: '订单', tags: [], sources: [{ relativePath: `alice/2026-10-23-orders/${id}.md` }], version: 1 });
it('requires selected-scope search and full paginated evidence before submission', () => {
  const runtime = new WritingRuntime([{ id: 'a' }, { id: 'b' }], [doc('one', 'a', '审核'.repeat(5000)), doc('two', 'b')]);
  expect(() => runtime.search({ scopeId: 'other', query: '订单' })).toThrow();
  expect(() => runtime.read({ id: 'one' })).toThrow();
  runtime.search({ scopeId: 'a', query: '订单' }); runtime.read({ id: 'one' });
  expect(() => runtime.submit({ content: '# 订单', evidenceIds: ['one'] })).toThrow('必须检索');
  runtime.search({ scopeId: 'b', query: '订单' }); runtime.read({ id: 'two' });
  expect(() => runtime.submit({ content: '# 订单', evidenceIds: ['one', 'two'] })).toThrow('完整读取');
  expect(() => runtime.read({ id: 'one', offset: 9999 })).toThrow();
  while ((runtime.coverage.get('one') || 0) < runtime.documents[0].body.length) runtime.read({ id: 'one', offset: runtime.coverage.get('one') });
  expect(() => runtime.submit({ content: '# 订单', evidenceIds: ['one'] })).toThrow('至少需要');
  runtime.submit({ content: '# 订单', evidenceIds: ['one', 'two'] });
  expect(runtime.result.evidence).toHaveLength(2);
  expect(runtime.result.evidence[0].body).toBeUndefined();
});
it('allows blank knowledge selection and empty scopes without invented references', () => {
  const runtime = new WritingRuntime([], []); runtime.submit({ content: '# 原文优化', evidenceIds: [] });
  expect(runtime.result.evidence).toEqual([]);
  const empty = new WritingRuntime([{ id: 'empty' }], []); empty.search({ scopeId: 'empty', query: '订单' });
  empty.submit({ content: '# 待确认', evidenceIds: [] });
});
it('isolates runtime tools to the child session and denies calls after close', async () => {
  const definitions = new Map(); let hook, guard;
  const ctx = { tools: { register: d => { definitions.set(d.name, d); return () => {}; }, guard: fn => { guard = fn; return () => {}; } }, on: (_name, fn) => { hook = fn; return () => {}; } };
  const installation = installWritingTools(ctx), runtime = new WritingRuntime([{ id: 'a' }], [doc('one', 'a')]);
  installation.add(runtime);
  const search = definitions.get(WRITING_TOOLS[0]);
  expect(() => search.execute({ scopeId: 'a', query: '订单' }, { agent: { session: { id: 'parent' } } })).toThrow('DENIED');
  async function* next() { yield 'ok'; }
  bindOwnedSession(runtime, 'child');
  for await (const _ of hook({ sessionId: 'child', messages: [{ content: `REQHUB_WRITING=${runtime.id}` }], tools: [{ name: 'child_session_helper' }] }, next)) {}
  expect(search.execute({ scopeId: 'a', query: '订单' }, { agent: { session: { id: 'child' } } }).hits[0].id).toBe('one');
  expect(guard({ name: 'shell', agent: { session: { id: 'child' } } })).toContain('仅允许');
  expect(guard({ name: 'child_session_helper', parent: Symbol('run_code'), agent: { session: { id: 'child' } } })).toContain('仅允许');
  installation.close(runtime);
  expect(() => search.execute({ scopeId: 'a', query: '订单' }, { agent: { session: { id: 'child' } } })).toThrow('DENIED');
  installation.dispose();
});

let root, service, routes, server, base, definitions, streamHook, execute;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rh-writing-')); await mkdir(join(root, 'docs/alice/2026-10-23-orders'), { recursive: true });
  const registry = { list: () => [{ id: 'ws', title: '本工作区', path: root }, { id: 'other', title: '另一个库', path: root }] };
  service = new KnowledgeService({ registry, databasePath: join(root, 'kb.sqlite'), configLoader: async () => ({ docsDir: 'docs' }) });
  for (const id of ['ws', 'other']) {
    await writeFile(join(root, 'docs/alice/2026-10-23-orders', `${id}.md`), `${id} 审核通过后才能发货`);
    const scope = await service.scope(id);
    const { job } = await service.build(scope, { requestKey: id, files: [{ relativePath: `alice/2026-10-23-orders/${id}.md` }] });
    await Promise.all([...service.tasks]); expect(scope.store.job(job.id).status).toBe('completed');
  }
  definitions = new Map();
  const ctx = { subagents: { getProvider: () => ({ capabilities: { toolFilter: true }, inheritsParentContext: false }) },
    tools: { register: d => { definitions.set(d.name, d); return () => {}; }, guard: () => () => {} },
    on: (_event, fn) => { streamHook = fn; return () => {}; } };
  execute = vi.fn(async (_ctx, _llm, _config, options) => {
    const sessionId = `child-${execute.mock.calls.length}`;
    async function* next() { yield 'ok'; }
    bindOwnedSession(options.runtime, sessionId);
    for await (const _ of streamHook({ sessionId, messages: [`REQHUB_WRITING=${options.variables.runtimeId}`], tools: WRITING_TOOLS.map(name => ({ name })) }, next)) {}
    const exec = { agent: { session: { id: sessionId } }, signal: options.signal };
    const evidenceIds = [];
    for (const scope of JSON.parse(options.variables.scopes)) {
      const hits = definitions.get(WRITING_TOOLS[0]).execute({ scopeId: scope.id, query: '审核' }, exec);
      for (const hit of hits.hits) { definitions.get(WRITING_TOOLS[1]).execute({ id: hit.id }, exec); evidenceIds.push(hit.id); }
    }
    definitions.get(WRITING_TOOLS[2]).execute({ content: `${options.variables.content}\n\n审核通过后才能发货`, evidenceIds }, exec);
    return { sessionId, isError: false };
  });
  routes = createWritingRoutes(registry, null, { get: id => id === 'parent' ? { status: 'idle', session: { id, header: { cwd: root } } } : null }, ctx, service, { configLoader: async () => ({}), executeTask: execute });
  server = createServer((req, res) => routes.routes[0].handler(req, res)); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}/req-hub/writing`;
});
afterEach(async () => { server?.closeAllConnections(); if (server) await new Promise(r => server.close(r)); await routes?.dispose(); await service?.close(); await rm(root, { recursive: true, force: true }); });
const post = (path, data) => fetch(base + path, { method: 'POST', body: JSON.stringify(data) });
it('saves to the selected requirement and requires versioned overwrite confirmation', async () => {
  const input = { workspaceId: 'ws', requirementId: '2026-10-23-orders', requirementPath: 'alice/2026-10-23-orders', docType: 'requirement', content: '# Saved' };
  const path = join(root, 'docs', input.requirementPath, 'requirement.md');
  expect((await post('/save', input)).status).toBe(200);
  expect(await readFile(path, 'utf8')).toBe('# Saved');
  const exists = await post('/save', { ...input, content: '# Revised' });
  expect(exists.status).toBe(409); const conflict = await exists.json(); expect(conflict.error).toBe('WRITING_FILE_EXISTS');
  expect(await readFile(path, 'utf8')).toBe('# Saved');
  await writeFile(path, '# External edit');
  const changed = await post('/save', { ...input, expectedVersion: conflict.details.version });
  expect(changed.status).toBe(409); const latest = await changed.json(); expect(latest.error).toBe('WRITING_SAVE_CONFLICT');
  expect(await readFile(path, 'utf8')).toBe('# External edit');
  expect((await post('/save', { ...input, expectedVersion: latest.details.version })).status).toBe(200);
  expect(await readFile(path, 'utf8')).toBe('# Saved');
  expect((await post('/save', { ...input, docType: 'design' })).status).toBe(200);
  expect(await readFile(join(root, 'docs', input.requirementPath, 'design.md'), 'utf8')).toBe('# Saved');
});
it('rejects missing targets and paths escaping the selected workspace', async () => {
  const input = { workspaceId: 'ws', docType: 'requirement', content: '# Safe', requirementId: '2026-10-23-orders' };
  for (const requirementPath of [undefined, '../2026-10-23-orders', 'C:/2026-10-23-orders']) {
    expect((await post('/save', { ...input, requirementPath })).status).toBeGreaterThanOrEqual(400);
  }
  expect(execute).not.toHaveBeenCalled();
});
it('rejects a requirement junction leading outside the document root', async () => {
  const outside = join(root, 'outside/2026-10-23-orders');
  await mkdir(outside, { recursive: true }); await mkdir(join(root, 'docs/bob'));
  await writeFile(join(outside, 'requirement.md'), '# Original');
  await symlink(outside, join(root, 'docs/bob/2026-10-23-orders'), 'junction');
  const response = await post('/save', { workspaceId: 'ws', docType: 'requirement', requirementId: '2026-10-23-orders', requirementPath: 'bob/2026-10-23-orders', content: '# Unsafe' });
  expect(response.status).toBe(403); expect(await readFile(join(outside, 'requirement.md'), 'utf8')).toBe('# Original');
});
it('exposes the same save behavior through the Host action', async () => {
  const operations = createOperations(routes.routes);
  const result = await operations.execute({ action: 'writing-save', method: 'POST', body: { workspaceId: 'ws', requirementId: '2026-10-23-orders', requirementPath: 'alice/2026-10-23-orders', docType: 'design', content: '# Via shared action' } }, {});
  expect(result.status).toBe(200);
  expect(await readFile(join(root, 'docs/alice/2026-10-23-orders/design.md'), 'utf8')).toBe('# Via shared action');
});
it('optimizes in repeated rounds using only selected global knowledge and never edits sources', async () => {
  const options = await (await fetch(base + '/options')).json(); expect(options.scopes).toHaveLength(2);
  const selected = options.scopes.find(s => s.workspaceId === 'other');
  let content = '# 发货需求';
  for (let i = 0; i < 2; i++) {
    const response = await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', scopeIds: [selected.id], docType: 'requirement', content, instruction: '' });
    expect(response.status).toBe(202); const job = await response.json();
    let result;
    await vi.waitFor(async () => { result = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(result.status).toBe('completed'); });
    expect(result.status).toBe('completed'); expect(result.result.original).toBe(content);
    expect(result.result.evidence.map(e => e.workspaceId)).toEqual(['other']); content = result.result.content;
  }
  expect(execute.mock.calls[1][3].variables.content).toContain('审核通过后才能发货');
  expect(execute.mock.calls[0][3].toolFilter).toEqual({ allow: WRITING_TOOLS });
  expect(PROMPT_REGISTRY.template).toBeUndefined();
});
it('uses only the explicitly checked related document when no whole knowledge scope is selected', async () => {
  const scope = await service.scope('other'); const document = scope.store.list()[0];
  const referenceRefs = [{ id: document.id, scopeId: scope.identity, version: document.version }];
  const input = { workspaceId: 'ws', sessionId: 'parent', scopeIds: [], referenceRefs, docType: 'requirement', content: '# Draft', instruction: '' };
  const response = await post('/optimize', input); expect(response.status).toBe(202); const job = await response.json();
  let result; await vi.waitFor(async () => { result = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(result.status).toBe('completed'); });
  expect(execute.mock.calls.at(-1)[3].runtime.documents.map(doc => doc.id)).toEqual([document.id]);
  expect(result.result.evidence.map(doc => doc.id)).toEqual([document.id]);
  expect((await post('/optimize', { ...input, referenceRefs: [{ ...referenceRefs[0], version: document.version + 1 }] })).status).toBe(409);
});
it('rejects the writing candidate if a checked reference changes while the child is running', async () => {
  const scope = await service.scope('other'), document = scope.store.list()[0];
  const original = execute.getMockImplementation();
  execute.mockImplementation(async (...args) => { const result = await original(...args); await writeFile(join(root, 'docs', document.sources[0].relativePath), 'Changed during model execution'); return result; });
  const response = await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', scopeIds: [], referenceRefs: [{ id: document.id, scopeId: scope.identity, version: document.version }], docType: 'requirement', content: '# Draft', instruction: '' });
  expect(response.status).toBe(202); const job = await response.json();
  let result; await vi.waitFor(async () => { result = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(result.status).toBe('failed'); });
  expect(result.error).toBe('ENHANCEMENT_INPUT_CHANGED'); expect(result.result).toBeUndefined();
  expect(result.errorDetails).toMatchObject({ documentId: document.id, scopeId: scope.identity, reason: 'source_changed', expectedVersion: document.version, actualVersion: document.version, sources: [{ relativePath: document.sources[0].relativePath, status: 'stale' }] });
});
it('excludes already stale snapshots before starting AI while preserving ordinary knowledge browsing', async () => {
  const scope = await service.scope('other');
  await service.build(scope, { requestKey: 'additional', files: [{ relativePath: 'alice/2026-10-23-orders/ws.md' }] });
  await Promise.all([...service.tasks]);
  await writeFile(join(root, 'docs/alice/2026-10-23-orders/other.md'), 'Already changed before optimization');
  const response = await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', scopeIds: [scope.identity], docType: 'requirement', content: '# Draft', instruction: '' });
  expect(response.status).toBe(202); const job = await response.json();
  let result; await vi.waitFor(async () => { result = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(result.status).toBe('completed'); });
  expect(result.excludedSourceCount).toBe(1);
  expect(execute.mock.calls[0][3].runtime.documents.map(doc => doc.sources[0].relativePath)).toEqual(['alice/2026-10-23-orders/ws.md']);
  expect(scope.store.list()).toHaveLength(2);
  expect(result.result.evidence).toHaveLength(1);
});
it('fails before invoking AI when a selected library has only invalid sources', async () => {
  const scope = await service.scope('other');
  await writeFile(join(root, 'docs/alice/2026-10-23-orders/other.md'), 'Already stale');
  const response = await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', scopeIds: [scope.identity], docType: 'requirement', content: '# Draft', instruction: '' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'WRITING_KNOWLEDGE_STALE', details: { sources: [{ relativePath: 'alice/2026-10-23-orders/other.md', status: 'stale' }] } });
  expect(execute).not.toHaveBeenCalled();
});
it('still rejects evidence rebuilt to a newer version during AI execution', async () => {
  const scope = await service.scope('other'), document = scope.store.list()[0];
  const original = execute.getMockImplementation();
  execute.mockImplementation(async (...args) => {
    const result = await original(...args);
    await writeFile(join(root, 'docs', document.sources[0].relativePath), 'New indexed source');
    await service.build(scope, { requestKey: 'rebuild', files: [{ relativePath: document.sources[0].relativePath }] });
    await Promise.all([...service.tasks]);
    return result;
  });
  const job = await (await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', scopeIds: [scope.identity], docType: 'requirement', content: '# Draft', instruction: '' })).json();
  let result; await vi.waitFor(async () => { result = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(result.status).toBe('failed'); });
  expect(result.errorDetails).toMatchObject({ reason: 'version_changed', expectedVersion: document.version, actualVersion: document.version + 1 });
  expect(result.result).toBeUndefined();
});
it('rejects invalid types, missing sessions and knowledge outside the catalog', async () => {
  const input = { workspaceId: 'ws', sessionId: 'parent', docType: 'design', content: '# 方案', instruction: '', scopeIds: [] };
  for (const extra of [{ docType: 'cr' }, { sessionId: 'missing' }, { scopeIds: ['outside'] }]) expect((await post('/optimize', { ...input, ...extra })).status).toBe(400);
  expect(execute).not.toHaveBeenCalled();
});
it('cancels with the existing executor abort signal and never publishes a late result', async () => {
  let complete;
  execute.mockImplementation(async (...args) => { await new Promise(r => { complete = r; }); return { isError: false }; });
  const job = await (await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', docType: 'design', content: '# 方案', instruction: '', scopeIds: [] })).json();
  expect((await (await post(`/jobs/${job.id}/cancel`, {})).json()).status).toBe('cancelling');
  expect(execute.mock.calls[0][3].signal.aborted).toBe(true); complete();
  const cancelled = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(cancelled.result).toBeUndefined();
});

it('reports actual retrieval activity and separates overview from document bytes', () => {
  const runtime = new WritingRuntime([{ id: 'a' }], [doc('one', 'a')]);
  const activity = []; runtime.onActivity = value => activity.push(value);
  runtime.search({ scopeId: 'a', query: '订单' });
  expect(activity.at(-1)).toMatchObject({ stage: 'searching', searched: 1, read: 0 });
  runtime.read({ id: 'one' });
  expect(activity.at(-1)).toMatchObject({ stage: 'reading', searched: 1, read: 1 });
  runtime.submit({ content: '# 原文优化', overview: '补充边界条件', evidenceIds: ['one'] });
  expect(activity.at(-1).stage).toBe('submitted');
  expect(runtime.result.content).toBe('# 原文优化');
  expect(runtime.result.overview).toBe('补充边界条件');
  expect(() => runtime.submit({ content: '# 原文优化', overview: 'x'.repeat(8001), evidenceIds: ['one'] })).toThrow('WRITING_OVERVIEW_INVALID');
});

it('counts only real owned model deltas, retains no model text, and passes the stream through', async () => {
  let stream;
  const definitions = new Map();
  const ctx = { tools: { register: value => { definitions.set(value.name, value); return () => {}; }, guard: () => () => {} }, on: (_event, hook) => { stream = hook; return () => {}; } };
  const installed = installWritingTools(ctx), runtime = new WritingRuntime([], []);
  installed.add(runtime); bindOwnedSession(runtime, 'owned');
  const chunks = [{ type: 'reasoning-delta', text: 'private' }, { type: 'text-delta', text: 'answer' }, { type: 'usage', usage: {} }, { type: 'tool-call-delta', argumentsDelta: 'abc' }];
  async function* next() { yield* chunks; }
  const unrelated = [];
  for await (const chunk of stream({ sessionId: 'other', messages: [] }, next)) unrelated.push(chunk);
  expect(unrelated).toEqual(chunks); expect(runtime.activity.lastActivityAt).toBeUndefined();
  const output = [];
  for await (const chunk of stream({ sessionId: 'owned', messages: [] }, next)) output.push(chunk);
  expect(output).toEqual(chunks);
  expect(runtime.activity).toMatchObject({ outputCharacters: 6, reasoningCharacters: 7, toolCharacters: 3, stage: 'tool_call' });
  expect(runtime.activity.lastActivityAt).toBeGreaterThan(0);
  expect(JSON.stringify(runtime.activity)).not.toContain('private');
  expect(definitions.get(WRITING_TOOLS[2]).parameters.required).not.toContain('overview');
  expect(() => definitions.get(WRITING_TOOLS[1]).execute({ id: 'bad' }, { agent: { session: { id: 'owned' } } })).toThrow();
  expect(runtime.activity).toMatchObject({ stage: 'tool_error', toolErrors: 1 });
  installed.close(runtime); installed.dispose();
});
it('publishes the owned child identity before completion and does not turn monitor polls into progress', async () => {
  let finish;
  execute.mockImplementation(async (...args) => {
    const task = args[3]; task.callbacks.onProgress({ stage: 'executing', sessionId: 'actual-child' });
    task.callbacks.onProgress({ stage: 'liveness_active', lastActivity: new Date().toISOString() });
    await new Promise(resolve => { finish = resolve; }); return { isError: true, diagnostic: 'done' };
  });
  const job = await (await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', docType: 'design', content: '# Draft', instruction: '', scopeIds: [] })).json();
  expect(job.sessionId).toBe('actual-child'); expect(job.activity.stage).toBe('waiting_model');
  expect(job.activity.lastActivityAt).toBeUndefined();
  finish();
});

it('stops repeated invalid tool repairs and cannot submit a fallback without the selected knowledge', async () => {
  const definitions = new Map();
  const ctx = { tools: { register: value => { definitions.set(value.name, value); return () => {}; }, guard: () => () => {} }, on: () => () => {} };
  const installed = installWritingTools(ctx), runtime = new WritingRuntime([{ id: 'exact' }], [doc('one', 'exact')]);
  const fatal = vi.fn(); runtime.onFatal = fatal; installed.add(runtime); bindOwnedSession(runtime, 'child');
  const exec = { agent: { session: { id: 'child' } } }, search = definitions.get(WRITING_TOOLS[0]);
  for (let attempt = 0; attempt < 2; attempt++) expect(() => search.execute({ scopeId: 'guessed-' + attempt, query: 'rule' }, exec)).toThrow('allowedScopeIds');
  expect(() => search.execute({ scopeId: 'another-guess', query: 'rule' }, exec)).toThrow('WRITING_TOOL_FAILED');
  expect(fatal).toHaveBeenCalledTimes(1);
  expect(() => runtime.submit({ content: '# Unverified fallback', evidenceIds: [] })).toThrow('WRITING_TOOL_FAILED');
  expect(() => search.execute({ scopeId: 'exact', query: 'rule' }, exec)).toThrow('WRITING_TOOL_FAILED');
  expect(runtime.result).toBeUndefined(); installed.close(runtime); installed.dispose();
});

it('reports exhausted tool repairs as failed rather than cancelled and never publishes a fallback', async () => {
  execute.mockImplementation(async (...args) => {
    const task = args[3]; bindOwnedSession(task.runtime, 'bad-child');
    for (let attempt = 0; attempt < 3; attempt++) {
      try { definitions.get(WRITING_TOOLS[0]).execute({ scopeId: 'guessed', query: 'rule' }, { agent: { session: { id: 'bad-child' } } }); } catch {}
    }
    expect(task.signal.aborted).toBe(true); return { isError: true };
  });
  const job = await (await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', docType: 'design', content: '# Draft', instruction: '', scopeIds: [] })).json();
  let result;
  await vi.waitFor(async () => { result = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(result.status).toBe('failed'); });
  expect(result.error).toBe('WRITING_TOOL_FAILED'); expect(result.result).toBeUndefined();
});

it('discovers detached workspace jobs and keeps background work alive until explicit cancellation', async () => {
  let finish;
  execute.mockImplementation(async () => { await new Promise(resolve => { finish = resolve; }); return { isError: true }; });
  const job = await (await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', docType: 'design', content: '# Draft', instruction: '', scopeIds: [] })).json();
  const list = await (await fetch(base + '/jobs?workspaceId=ws')).json();
  expect(list.jobs[0]).toMatchObject({ id: job.id, workspaceId: 'ws', docType: 'design', status: 'running' });
  expect(execute.mock.calls[0][3].signal.aborted).toBe(false);
  expect((await (await fetch(base + '/jobs?workspaceId=other')).json()).jobs).toEqual([]);
  expect((await fetch(base + '/jobs?workspaceId=outside')).status).toBe(403);
  const operations = createOperations(routes.routes);
  const output = await operations.execute({ action: 'writing-jobs', query: { workspaceId: 'ws' } }, { agent: { session: { id: 'other-parent' } }, signal: new AbortController().signal });
  expect(output.value.jobs).toEqual([]);
  await post(`/jobs/${job.id}/cancel`, {}); expect(execute.mock.calls[0][3].signal.aborted).toBe(true); finish();
});

it('keeps jobs and concurrency reservations separate for different requirements in one workspace', async () => {
  const paths = ['alice/2026-10-29-first', 'alice/2026-10-29-second'];
  for (const path of paths) await mkdir(join(root, 'docs', path), { recursive: true });
  const finishes = [];
  execute.mockImplementation(async () => { await new Promise(resolve => finishes.push(resolve)); return { isError: true }; });
  const input = { workspaceId: 'ws', sessionId: 'parent', docType: 'requirement', content: '# Draft', instruction: '', scopeIds: [] };
  try {
    const firstResponse = await post('/optimize', { ...input, requirementPath: paths[0] }); expect(firstResponse.status).toBe(202);
    const first = await firstResponse.json(); expect(first.requirementPath).toBe(paths[0]);
    expect((await post('/optimize', { ...input, requirementPath: paths[0] })).status).toBe(409);
    const secondResponse = await post('/optimize', { ...input, requirementPath: paths[1] }); expect(secondResponse.status).toBe(202);
    const second = await secondResponse.json();
    for (const [index, expected] of [first, second].entries()) {
      const list = await (await fetch(base + '/jobs?' + new URLSearchParams({ workspaceId: 'ws', requirementPath: paths[index] }))).json();
      expect(list.jobs.map(job => job.id)).toEqual([expected.id]);
    }
    expect((await (await fetch(base + '/jobs?workspaceId=ws')).json()).jobs).toEqual([]);
    expect((await post('/optimize', { ...input, requirementPath: '../2026-10-29-bad' })).status).toBe(400);
    expect((await fetch(base + '/jobs?' + new URLSearchParams({ workspaceId: 'ws', requirementPath: '../outside' }))).status).toBe(400);
    expect(execute.mock.calls.every(call => !call[3].signal.aborted)).toBe(true);
  } finally { for (const finish of finishes) finish(); }
});

it('uses the same image extraction operation for UI and Agent, then serves only generated scoped files', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=';
  const input = { workspaceId: 'ws', requirementPath: 'alice/2026-10-23-orders', content: `# Draft\n![shot](data:image/png;base64,${png})` };
  const operations = createOperations(routes.routes);
  const extracted = await operations.execute({ action: 'writing-assets', method: 'POST', body: input }, { agent: { session: { id: 'parent' } }, signal: new AbortController().signal });
  expect(extracted.status).toBe(200); expect(extracted.value.content).not.toContain('base64');
  const filename = extracted.value.images[0].split('/').at(-1);
  const response = await fetch(base + '/assets/' + filename + '?' + new URLSearchParams({ workspaceId: 'ws', requirementPath: input.requirementPath }));
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(png, 'base64'));
  const rejected = await post('/optimize', { ...input, sessionId: 'parent', scopeIds: [], docType: 'requirement', instruction: '' });
  expect((await rejected.json()).error).toBe('WRITING_INLINE_IMAGES');
  const accepted = await post('/optimize', { ...input, content: extracted.value.content, sessionId: 'parent', scopeIds: [], docType: 'requirement', instruction: '' });
  expect(accepted.status).toBe(202); expect(execute.mock.calls.at(-1)[3].variables.content).not.toContain('base64');
});

it('steers only its owned incomplete child and stops at a bounded number of repair notices', () => {
  const hooks = new Map(), disposers = [];
  const ctx = { tools: { register: () => () => {}, guard: () => () => {} }, on: (name, hook) => { hooks.set(name, hook); const dispose = vi.fn(); disposers.push(dispose); return dispose; } };
  const installation = installWritingTools(ctx), runtime = new WritingRuntime([{ id: 'scope' }], [doc('one', 'scope')]);
  installation.add(runtime); bindOwnedSession(runtime, 'owned');
  const steer = vi.fn(), stop = hooks.get('agent/turn-stopping'), onFatal = vi.fn(); runtime.onFatal = onFatal;
  stop({ agent: { session: { id: 'unrelated' }, steer } }); expect(steer).not.toHaveBeenCalled();
  stop({ agent: { session: { id: 'owned' }, steer }, signal: AbortSignal.abort() }); expect(steer).not.toHaveBeenCalled();
  runtime.search({ scopeId: 'scope', query: '订单' });
  for (let attempt = 0; attempt < 4; attempt++) stop({ agent: { session: { id: 'owned' }, steer } });
  expect(steer).toHaveBeenCalledTimes(3); expect(onFatal).toHaveBeenCalledTimes(1);
  const text = steer.mock.calls[0][0].content[0].text;
  expect(text).toContain('NOT received'); expect(text).toContain('nextReads'); expect(text).toContain('one');
  expect(runtime.coverage.size).toBe(0); expect(runtime.result).toBeUndefined();
  installation.close(runtime); stop({ agent: { session: { id: 'owned' }, steer } }); expect(steer).toHaveBeenCalledTimes(3);
  installation.dispose(); expect(disposers.every(dispose => dispose.mock.calls.length === 1)).toBe(true);
});

it('rejects a successful-looking final answer when no actual submit tool receipt exists', async () => {
  execute.mockImplementation(async () => ({ isError: false, output: '<function=req_hub_writing_submit><parameter=content>claimed</parameter></function>', sessionId: 'child' }));
  const job = await (await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', docType: 'design', content: '# Original', instruction: '', scopeIds: [] })).json();
  let state;
  await vi.waitFor(async () => { state = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(state.status).toBe('failed'); });
  expect(state.error).toBe('WRITING_RESULT_INCOMPLETE'); expect(state.result).toBeUndefined();
});
