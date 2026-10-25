import {bindOwnedSession} from '../../src/server/delegation-context.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WritingRuntime, installWritingTools, WRITING_TOOLS } from '../../src/server/writing-runtime.js';
import { createWritingRoutes } from '../../src/server/routes/writing-routes.js';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { PROMPT_REGISTRY } from '../../src/server/prompts.js';

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
  runtime.read({ id: 'one', offset: 8000 });
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
  for await (const _ of hook({ sessionId: 'child', messages: [{ content: `REQHUB_WRITING=${runtime.id}` }], tools: [] }, next)) {}
  expect(search.execute({ scopeId: 'a', query: '订单' }, { agent: { session: { id: 'child' } } })[0].id).toBe('one');
  expect(guard({ name: 'shell', agent: { session: { id: 'child' } } })).toContain('仅允许');
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
      for (const hit of hits) { definitions.get(WRITING_TOOLS[1]).execute({ id: hit.id }, exec); evidenceIds.push(hit.id); }
    }
    definitions.get(WRITING_TOOLS[2]).execute({ content: `${options.variables.content}\n\n审核通过后才能发货`, evidenceIds }, exec);
    return { sessionId, isError: false };
  });
  routes = createWritingRoutes(registry, null, { get: id => id === 'parent' ? { status: 'idle', session: { id } } : null }, ctx, service, { configLoader: async () => ({}), executeTask: execute });
  server = createServer((req, res) => routes.routes[0].handler(req, res)); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}/req-hub/writing`;
});
afterEach(async () => { server?.closeAllConnections(); if (server) await new Promise(r => server.close(r)); await routes?.dispose(); await service?.close(); await rm(root, { recursive: true, force: true }); });
const post = (path, data) => fetch(base + path, { method: 'POST', body: JSON.stringify(data) });
it('optimizes in repeated rounds using only selected global knowledge and never edits sources', async () => {
  const options = await (await fetch(base + '/options')).json(); expect(options.scopes).toHaveLength(2);
  const selected = options.scopes.find(s => s.workspaceId === 'other');
  let content = '# 发货需求';
  for (let i = 0; i < 2; i++) {
    const response = await post('/optimize', { workspaceId: 'ws', sessionId: 'parent', scopeIds: [selected.id], docType: 'requirement', content, instruction: '' });
    expect(response.status).toBe(202); const job = await response.json();
    const result = await (await fetch(`${base}/jobs/${job.id}`)).json();
    expect(result.status).toBe('completed'); expect(result.result.original).toBe(content);
    expect(result.result.evidence.map(e => e.workspaceId)).toEqual(['other']); content = result.result.content;
  }
  expect(execute.mock.calls[1][3].variables.content).toContain('审核通过后才能发货');
  expect(execute.mock.calls[0][3].toolFilter).toEqual({ allow: WRITING_TOOLS });
  expect(PROMPT_REGISTRY.template).toBeUndefined();
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
  expect((await (await post(`/jobs/${job.id}/cancel`, {})).json()).status).toBe('cancelled');
  expect(execute.mock.calls[0][3].signal.aborted).toBe(true); complete();
  const cancelled = await (await fetch(`${base}/jobs/${job.id}`)).json(); expect(cancelled.result).toBeUndefined();
});
