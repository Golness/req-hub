// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { DocumentAssist, EnhancementSettings } = require('../../src/client/components/ContextAssist.js');
const { SessionSelectionContext } = require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, calls, context, kind, live;
const doc = { id: 'doc', scopeId: 'scope', version: 2 };
beforeEach(() => {
  calls = []; live = false;
  context = { enabled: true, indexed: true, documentRefs: [doc], related: [{ id: 'related', scopeId: 'scope', version: 3, path: 'bob/req/design.md', title: 'Design', reasons: ['explicit_dependency'], confirmed: false }],
    graph: { id: 'revision', reviewSeq: 2, entities: [{ id: 'a', key: 'alice/req', documents: [{ id: 'doc' }] }, { id: 'b', key: 'bob/req', documents: [{ id: 'related' }] }], relations: [{ id: 'relation', sourceId: 'a', targetId: 'b', type: 'explicit_dependency', reviewState: 'candidate', validity: 'valid', basisHash: 'basis', evidence: [] }], code: { status: 'stale' } } };
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const parsed = new URL(url, 'http://local'), body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: parsed.pathname, body, params: parsed.searchParams }); let value;
    if (parsed.pathname.endsWith('/context')) value = context;
    else if (parsed.pathname.endsWith('/config')) { if (body) context.enabled = body.enhancements.enabled; value = { enhancements: { enabled: context.enabled, gitnexusServer: 'gitnexus' } }; }
    else if (parsed.pathname.endsWith('/jobs') && body) { kind = body.kind; value = { id: 'job', kind, status: 'queued' }; }
    else if (parsed.pathname.endsWith('/jobs')) value = { enabled: context.enabled, jobs: [], graph: context.graph, mcpServer: 'gitnexus', mcpServers: ['gitnexus'], mcpAvailable: true };
    else if (parsed.pathname.endsWith('/jobs/job')) value = { id: 'job', kind, status: live ? 'running' : 'completed', activity: { stage: 'index_running', percent: 42 }, indexLogs: kind === 'code-index' ? ['Parsing files'] : undefined,
      result: kind === 'code-index' ? { code: { status: 'ready' }, indexUpdated: true } : kind === 'code-refresh' ? { code: { status: 'stale' } } : { findings: [] } };
    else if (parsed.pathname.endsWith('/reviews')) { context.graph.relations[0].reviewState = body.decision; value = context.graph; }
    else throw new Error('Unexpected request: ' + url);
    return { ok: true, json: async () => value };
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const click = node => act(async () => node.click());
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
const render = props => act(async () => root.render(React.createElement(DocumentAssist, { workspaceId: 'w', path: 'alice/req/requirement.md', ...props })));
it('uses the current document without a picker or manual graph build, and navigates related sources', async () => {
  const onOpenSource = vi.fn(); await render({ onOpenSource });
  expect(calls[0].params.get('path')).toBe('alice/req/requirement.md');
  expect(calls.every(call => !call.body)).toBe(true); expect(button('构建文档关联')).toBeUndefined();
  await click(button('bob/req/design.md')); expect(onOpenSource).toHaveBeenCalledWith({ relativePath: 'bob/req/design.md', workspaceId: 'w', title: 'Design' });
  await click(button('结构检查'));
  expect(calls.find(call => call.body?.kind === 'quality-check').body.context).toEqual({ path: 'alice/req/requirement.md' });
});
it('takes the current calling session through the scoped selection context', async () => {
  await act(async () => root.render(React.createElement(SessionSelectionContext.Provider, { value: () => 'active-parent' }, React.createElement(DocumentAssist, { workspaceId: 'w', path: 'alice/req/requirement.md' }))));
  await click(button('结构检查'));
  expect(calls.find(call => call.body?.kind === 'quality-check').body.sessionId).toBe('active-parent');
});
it('passes the actual unsaved writing draft to checking and warns when it changes', async () => {
  await render({ mode: 'writing', draft: '# Current unsaved draft' }); await click(button('结构检查'));
  expect(calls.find(call => call.body?.kind).body.draft).toBe('# Current unsaved draft');
  await render({ mode: 'writing', draft: '# Edited again' });
  expect(container.textContent).toContain('正文已修改');
});
it('selects exact reference versions for sync without changing write targets or confirming candidates implicitly', async () => {
  const onReferencesChange = vi.fn(); await render({ mode: 'sync', references: [], onReferencesChange });
  await click(container.querySelector('input[type=checkbox]'));
  expect(onReferencesChange).toHaveBeenCalledWith([{ id: 'related', scopeId: 'scope', version: 3 }]);
  expect(calls.some(call => call.body)).toBe(false); expect(container.textContent).toContain('不会扩大写入范围');
  await click(button('已确认')); expect(calls.find(call => call.path.endsWith('/reviews')).body).toMatchObject({ expectedRevision: 'revision', expectedReviewSeq: 2, basisHash: 'basis', decision: 'confirmed' });
});
it('moves enabling and MCP selection to settings and displays actual index progress', async () => {
  await act(async () => root.render(React.createElement(EnhancementSettings, { workspaceId: 'w' })));
  expect(container.textContent).toContain('知识关联与代码索引');
  expect(button('结构检查')).toBeUndefined();
  await click(container.querySelector('input[type=checkbox]'));
  expect(calls.find(call => call.path.endsWith('/config') && call.body).body.enhancements.enabled).toBe(false);
  live = true; await click(button('更新索引'));
  expect(calls.find(call => call.body?.kind === 'code-index').body.context).toBeUndefined();
  expect(container.querySelector('progress').value).toBe(42); expect(container.textContent).toContain('Parsing files');
  live = false; await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(container.textContent).toContain('本机索引更新已完成'); expect(container.querySelector('progress')).toBeNull();
});
it('keeps checks unavailable when the source is not imported, dirty or enhancement is disabled', async () => {
  context.enabled = false; context.indexed = false; context.documentRefs = [];
  await render(); expect(button('结构检查').disabled).toBe(true); expect(container.textContent).toContain('设置中启用');
  context.enabled = true; context.documentRefs = [doc]; await render({ dirty: true });
  expect(button('结构检查').disabled).toBe(true);
});
