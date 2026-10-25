// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { ConversationKnowledgeImport } = require('../../src/client/components/ConversationKnowledgeImport.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); root = null; vi.unstubAllGlobals(); });
const session = { conversationId: 'conversation-one', id: 'codex:native', title: 'Fixture conversation', source: 'codex', snapshotVersion: 'v1', turnCount: 3, sourceScopeId: 'source-scope', sourceWorkspaceId: 'codex-native-workspace', sourceWorkspaceTitle: 'Same name', sourceWorkspacePaths: ['/codex/source'] };
function detail(version = 'v1') { return { entry: session, version, versions: [{ version: 'v1', created_at: '2026-10-25' }, { version: 'v0', created_at: '2026-10-24' }], turns: [1, 2, 3].map(number => ({ key: 'turn-' + number, number, knowledgeState: ['new', 'same', 'changed'][number - 1], importable: true, turn: { syncable: number !== 3, messages: [{ label: 'User', text: 'Question ' + number }, { label: 'Assistant', text: 'Reply ' + number }] } })) }; }
function api() {
  const fetch = vi.fn(async (url, options) => ({ ok: true, json: async () => String(url).includes('-options') ? { sessions: [session], targets: [{ id: 'target-kb', title: 'Same name', path: '/knowledge/target' }] } : options?.method === 'POST' ? { added: 1, updated: 1, skipped: 0 } : detail(new URL(String(url), 'http://localhost').searchParams.get('version')) }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
async function render(initialTarget) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => root.render(React.createElement(ConversationKnowledgeImport, { initialTarget, onClose: vi.fn(), onImported: vi.fn() }))); }
async function button(text) { await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === text).click()); }
it('requires an explicit destination and keeps source workspaces distinct from knowledge targets', async () => {
  api(); await render('');
  expect(document.querySelector('[role="dialog"]').classList.contains('frame')).toBe(true);
  expect(document.querySelector('.sessions')).not.toBeNull();
  expect(document.querySelector('input[type="checkbox"]').disabled).toBe(true);
  expect([...document.querySelectorAll('button')].find(button => button.textContent === '导入所选轮次').disabled).toBe(true);
  await act(async () => document.querySelector('button[aria-label="目标知识库工作区"]').click());
  await act(async () => document.querySelector('[role="menuitem"][data-value="target-kb"]').click());
  expect(document.querySelector('input[type="checkbox"]').disabled).toBe(false);
  expect(document.body.textContent).toContain('/knowledge/target');
});
it('supports session multi-selection and round deselection, submitting only the chosen frozen rounds', async () => {
  const fetch = api(); await render('target-kb');
  await act(async () => document.querySelector('input[aria-label="选择会话：Fixture conversation"]').click());
  expect(document.body.textContent).toContain('已导入，重复将跳过');
  expect(document.body.textContent).toContain('已变化，选中后更新');
  expect(document.body.textContent).toContain('未完成或已中断');
  await act(async () => document.querySelectorAll('[aria-label="会话轮次"] input')[1].click());
  expect(document.querySelector('input[aria-label="选择会话：Fixture conversation"]').indeterminate).toBe(true);
  await button('导入所选轮次');
  const call = fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(JSON.parse(call[1].body)).toEqual({ targetWorkspaceId: 'target-kb', selections: [{ id: 'conversation-one', version: 'v1', turnKeys: ['turn-1', 'turn-3'] }] });
  expect([...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('新增 1 轮，更新 1 轮'))).toBe(true);
});
it('clears selected rounds when changing the frozen snapshot version', async () => {
  api(); await render('target-kb');
  await act(async () => document.querySelector('input[type="checkbox"]').click());
  await act(async () => document.querySelector('button[aria-label="会话版本"]').click());
  await act(async () => document.querySelector('[role="menuitem"][data-value="v0"]').click());
  expect([...document.querySelectorAll('[aria-label="会话轮次"] input')].every(input => !input.checked)).toBe(true);
  expect([...document.querySelectorAll('button')].find(button => button.textContent === '导入所选轮次').disabled).toBe(true);
});

function liveLibrary() {
  const sessions = [], project = { id: 'native-project', title: 'Codex source', path: '/native/project', sessionCount: 1 };
  let revision = 0, failRefresh = false;
  const response = data => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  const fetch = vi.fn(async (url, init) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    if (path.endsWith('-options')) return response({ sessions: [...sessions], targets: [{ id: 'target-kb', title: 'Knowledge', path: '/knowledge' }, { id: 'source-ws', title: 'DSH source', path: '/source' }] });
    if (path.endsWith('/codex/workspaces')) return response({ workspaces: [project] });
    if (path.endsWith('/codex/sessions')) return response({ workspace: revision ? project : null, sessions: sessions.filter(entry => entry.source === 'codex') });
    if (path.endsWith('/sessions')) return response({ sessions: sessions.filter(entry => entry.source === 'dsh') });
    if (path.endsWith('/codex/refresh') || path.endsWith('/conversations-refresh')) {
      const body = JSON.parse(init.body); expect(body.workspaceId).toBe('source-ws');
      if (failRefresh) return { ok: false, json: async () => ({ error: 'SOURCE_UNAVAILABLE' }) };
      const source = path.endsWith('/codex/refresh') ? 'codex' : 'dsh';
      if (source === 'codex') expect(body.codexWorkspaceId).toBe('native-project');
      else expect(body).toMatchObject({ source: 'dsh', stream: true });
      revision++;
      const entry = { ...session, conversationId: source + '-conversation', source, id: source + ':native', title: source.toUpperCase() + ' new conversation', snapshotVersion: 'v' + revision,
        sourceWorkspaceId: source === 'codex' ? project.id : 'source-ws', sourceWorkspaceTitle: source === 'codex' ? project.title : 'DSH source' };
      const prior = sessions.findIndex(row => row.conversationId === entry.conversationId);
      if (prior >= 0) sessions[prior] = entry; else sessions.push(entry);
      return response({ workspace: source === 'codex' ? project : { id: 'source-ws' }, sessions: [entry] });
    }
    if (path.endsWith('-detail')) {
      const params = new URL(String(url), 'http://localhost').searchParams;
      const entry = sessions.find(row => row.conversationId === params.get('id'));
      return response({ ...detail(entry.snapshotVersion), entry });
    }
    if (path.endsWith('-import')) return response({ added: 3, updated: 0, skipped: 0 });
    throw Error('Unexpected request: ' + path);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, fail: () => { failRefresh = true; } };
}
async function sourceWorkspace() {
  await act(async () => document.querySelector('button[aria-label="DSH 会话工作区"]').click());
  await act(async () => document.querySelector('[role="menuitem"][data-value="source-ws"]').click());
}
it('pulls DSH conversations inside knowledge and imports into an independently selected knowledge workspace', async () => {
  const { fetch } = liveLibrary(); await render('target-kb'); await sourceWorkspace();
  expect(document.body.textContent).not.toContain('请先在同步功能');
  await button('刷新会话');
  await act(async () => document.querySelector('input[aria-label="选择会话：DSH new conversation"]').click());
  await button('导入所选轮次');
  const imported = fetch.mock.calls.find(([url]) => String(url).endsWith('-import'));
  expect(JSON.parse(imported[1].body)).toEqual({ targetWorkspaceId: 'target-kb', selections: [{ id: 'dsh-conversation', version: 'v1', turnKeys: ['turn-1', 'turn-2', 'turn-3'] }] });
  expect(fetch.mock.calls.some(([url]) => String(url).includes('phased-sync'))).toBe(false);
});
it('chooses and refreshes a Codex workspace in knowledge using the same acquisition UI as document sync', async () => {
  const { fetch, fail } = liveLibrary(); await render('target-kb'); await sourceWorkspace();
  await button('选择 Codex 工作区');
  const picker = [...document.querySelectorAll('[role="dialog"]')].find(node => node.getAttribute('aria-label') === '选择 Codex 工作区');
  await act(async () => picker.querySelector('.rh-codex-workspace').click());
  await act(async () => document.querySelector('input[aria-label="选择会话：CODEX new conversation"]').click());
  expect(document.body.textContent).toContain('已选择 1 个会话、3 个轮次');
  await button('刷新 Codex 会话');
  expect(document.querySelector('input[aria-label="选择会话：CODEX new conversation"]').checked).toBe(false);
  await act(async () => document.querySelector('input[aria-label="选择会话：CODEX new conversation"]').click());
  await button('导入所选轮次');
  const imported = fetch.mock.calls.find(([url]) => String(url).endsWith('-import'));
  expect(JSON.parse(imported[1].body)).toMatchObject({ targetWorkspaceId: 'target-kb', selections: [{ version: 'v2' }] });
  fail(); await button('刷新 Codex 会话');
  expect(document.querySelector('[role="alert"]').textContent).toContain('SOURCE_UNAVAILABLE');
  expect([...document.querySelectorAll('button')].find(node => node.textContent === '导入所选轮次').disabled).toBe(true);
});

it('shows DSH refresh progress in knowledge and disables stale selections until the new snapshot is ready', async () => {
  const { fetch } = liveLibrary(); await render('target-kb'); await sourceWorkspace(); await button('刷新会话');
  await act(async () => document.querySelector('input[aria-label="选择会话：DSH new conversation"]').click());
  const original = fetch.getMockImplementation(); let finish, finalResult;
  fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (!String(url).endsWith('/conversations-refresh')) return response;
    finalResult = await response.json(); let first = true;
    return { ok: true, headers: { get: () => 'application/x-ndjson' }, body: { getReader: () => ({ releaseLock() {}, read() {
      if (first) { first = false; return Promise.resolve({ value: new TextEncoder().encode(JSON.stringify({ type: 'progress', phase: 'importing', completed: 1, total: 3 }) + '\n'), done: false }); }
      return new Promise(resolve => { finish = resolve; });
    } }) } };
  });
  await button('刷新会话');
  expect(document.querySelector('progress').value).toBe(1);
  expect(document.body.textContent).toContain('正在拉取 DSH 会话（1/3）');
  expect(document.body.textContent).toContain('已选择 0 个会话、0 个轮次');
  expect(document.querySelector('button[aria-label="目标知识库工作区"]').disabled).toBe(true);
  await act(async () => finish({ value: new TextEncoder().encode(JSON.stringify({ type: 'result', result: finalResult }) + '\n'), done: true }));
  expect(document.querySelector('progress')).toBeNull();
  expect(document.querySelector('input[aria-label="选择会话：DSH new conversation"]').checked).toBe(false);
  expect(document.querySelector('button[aria-label="目标知识库工作区"]').disabled).toBe(false);
});

it('aborts pending source requests when closing knowledge without late library reloads', async () => {
  const { fetch } = liveLibrary(), original = fetch.getMockImplementation();
  let finish, signal;
  fetch.mockImplementation(async (url, init) => {
    if (!String(url).includes('/sessions?') || String(url).includes('/codex/')) return original(url, init);
    signal = init.signal;
    return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ sessions: [] }) }); });
  });
  await render('target-kb');
  const count = fetch.mock.calls.length;
  await act(async () => root.unmount()); root = null;
  expect(signal.aborted).toBe(true);
  await act(async () => finish());
  expect(fetch.mock.calls).toHaveLength(count);
});
