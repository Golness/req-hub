// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { SyncPanel } = require('../../src/client/components/SyncPanel.js');
const { DocsViewerContext } = require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, fetchMock, imported, refreshes, failRefresh;
const project = { id: 'project:p', title: 'Codex 订单项目', path: 'D:/codex/orders', sessionCount: 2 };
const session = { id: 'codex:one', title: 'Codex 完整会话', turnCount: 2, syncTurnCount: 1, snapshotVersion: 'cx-v1', createdAt: 1 };
const dsh = { id: 'dsh-one', title: 'DSH 完整会话', turnCount: 1, syncTurnCount: 1, snapshotVersion: 'dsh-v1', createdAt: 1 };
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 409, headers: { get: () => 'application/json' }, json: async () => data });
beforeEach(() => {
  imported = false; refreshes = 0; failRefresh = false;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  fetchMock = vi.fn(async (url, options) => {
    if (url.includes('/codex/workspaces?')) return response({ workspaces: [project, { ...project, id: 'other', title: '其他项目', path: 'D:/other' }] });
    if (url.includes('/codex/refresh')) {
      refreshes++; if (failRefresh) return response({ error: 'CODEX_SESSION_CHANGING: 会话正在写入' }, false);
      imported = true;
      expect(JSON.parse(options.body)).toMatchObject({ workspaceId: 'ws', codexWorkspaceId: project.id });
      return response({ workspace: project, importedCount: 2, refreshedAt: '2026-10-24T01:00:00Z', sessions: [{ ...session, snapshotVersion: `cx-v${refreshes}` }, { id: 'codex:partial', title: 'Codex 未完成会话', turnCount: 1, syncTurnCount: 0, snapshotVersion: 'partial', createdAt: 1 }] });
    }
    if (url.includes('/codex/sessions?')) return response({ workspace: imported ? project : null, sessions: imported ? [{ ...session, snapshotVersion: `cx-v${refreshes}` }] : [] });
    if (url.includes('/sync-branch-info')) return response({ targetBranch: 'feature/dev/orders', baseBranch: 'main' });
    if (url.includes('/sync-commits?')) return response({ commits: [], branchTip: 'f'.repeat(40), baseline: 'a'.repeat(40), hasUncommitted: false });
    if (url.includes('/sessions?')) return response({ sessions: [dsh] });
    if (url.includes('/session-turns?')) return response({ success: true, turnCount: 1, totalTokens: 100, turns: [{ turnNumber: 1, syncable: true, messages: [
      { role: 'user', kind: 'input', label: '用户输入', text: 'CODEX_USER' },
      { role: 'assistant', kind: 'intermediate', label: '助手中间回复 1', text: 'CODEX_INTERMEDIATE' },
      { role: 'assistant', kind: 'final', label: '助手最终回复', text: 'CODEX_FINAL' },
    ] }] });
    if (url.endsWith('/phased-sync')) return response({ skipped: true, message: '已同步' });
    return response({ active: false });
  }); vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const click = async element => act(async () => element.click());
const button = text => [...container.querySelectorAll('button')].find(element => element.textContent.trim() === text);
const change = async (input, value) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
async function open() {
  await act(async () => root.render(React.createElement(DocsViewerContext.Provider, { value: { refreshTree: vi.fn(), headerBackTarget: container } },
    React.createElement(SyncPanel, { workspaceId: 'ws', selectedReq: { id: '2026-10-24-orders', title: '订单' }, onClose: vi.fn() }))));
  await click(button('同步需求文档'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
}
async function chooseWorkspace() {
  await click(button('选择 Codex 工作区'));
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog.getAttribute('aria-label')).toBe('选择 Codex 工作区');
  await change(dialog.querySelector('input'), 'codex/orders');
  expect(dialog.textContent).not.toContain('其他项目');
  await click(dialog.querySelector('.rh-codex-workspace'));
}

it('places Codex under DSH sessions, imports a chosen workspace and submits both sources with their preview versions', async () => {
  await open();
  expect(button('开始同步需求文档').disabled).toBe(true);
  expect(button('刷新 Codex 会话').disabled).toBe(true);
  const dshArea = container.querySelector('[aria-label="选择相关会话"]');
  const codexArea = container.querySelector('[aria-label="选择 Codex 会话"]');
  expect(dshArea.compareDocumentPosition(codexArea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await chooseWorkspace();
  expect(container.textContent).toContain('Markdown 已入库');
  expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 未完成会话"]').disabled).toBe(true);
  await click(container.querySelector('[aria-label="选择会话 DSH 完整会话"]'));
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  expect(button('开始同步需求文档').disabled).toBe(false);
  await click(codexArea.querySelector('.rh-session-row button'));
  await click(button('全部展开'));
  expect(container.textContent).toContain('CODEX_USER'); expect(container.textContent).toContain('CODEX_INTERMEDIATE'); expect(container.textContent).toContain('CODEX_FINAL');
  const previewCall = fetchMock.mock.calls.find(([url]) => url.includes('/session-turns?'))[0];
  expect(previewCall).toContain('sessionId=codex%3Aone'); expect(previewCall).toContain('version=cx-v1');
  await click(button('返回'));
  expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]').checked).toBe(true);
  await click(button('开始同步需求文档'));
  const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/phased-sync'));
  expect(JSON.parse(call[1].body)).toMatchObject({ sessionIds: ['dsh-one', 'codex:one'], sessionVersions: { 'dsh-one': 'dsh-v1', 'codex:one': 'cx-v1' } });
});

it('clears old selections during refresh, loads new versions and preserves a checked item while filtering', async () => {
  await open(); await chooseWorkspace();
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  await change(container.querySelector('[aria-label="筛选 Codex 会话"]'), '找不到');
  expect(container.textContent).toContain('已选择 1 个 Codex 会话');
  await click(button('刷新 Codex 会话'));
  expect(refreshes).toBe(2); expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]').checked).toBe(false);
  expect(button('开始同步需求文档').disabled).toBe(true);
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  await click(button('开始同步需求文档'));
  const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/phased-sync'));
  expect(JSON.parse(call[1].body)).toMatchObject({ sessionIds: ['codex:one'], sessionVersions: { 'codex:one': 'cx-v2' } });
});

it('shows a refresh error and prevents stale imported versions from staying selected', async () => {
  await open(); await chooseWorkspace();
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  failRefresh = true; await click(button('刷新 Codex 会话'));
  expect(container.textContent).toContain('会话正在写入');
  expect(button('开始同步需求文档').disabled).toBe(true);
  expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]')).toBeNull();
});
