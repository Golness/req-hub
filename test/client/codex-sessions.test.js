// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  React = require('react'),
  { act } = React;
const { createRoot } = require('react-dom/client');
const { SyncPanel } = require('../../src/client/components/SyncPanel.js');
const { DocsViewerContext } = require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, fetchMock, imported, refreshes, failRefresh;
const project = {
  id: 'project:p',
  title: 'Codex 订单项目',
  path: 'D:/codex/orders',
  sessionCount: 2,
};
const session = {
  id: 'codex:one',
  title: 'Codex 完整会话',
  turnCount: 2,
  syncTurnCount: 1,
  snapshotVersion: 'cx-v1',
  createdAt: 1,
};
const dsh = {
  id: 'dsh-one',
  title: 'DSH 完整会话',
  turnCount: 1,
  syncTurnCount: 1,
  snapshotVersion: 'dsh-v1',
  createdAt: 1,
};
const response = (data, ok = true) => ({
  ok,
  status: ok ? 200 : 409,
  headers: { get: () => 'application/json' },
  json: async () => data,
});
beforeEach(() => {
  imported = false;
  refreshes = 0;
  failRefresh = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url, options) => {
    if (url.includes('/codex/workspaces?'))
      return response({
        workspaces: [project, { ...project, id: 'other', title: '其他项目', path: 'D:/other' }],
      });
    if (url.includes('/codex/refresh')) {
      refreshes++;
      if (failRefresh) return response({ error: 'CODEX_SESSION_CHANGING: 会话正在写入' }, false);
      imported = true;
      expect(JSON.parse(options.body)).toMatchObject({ workspaceId: 'ws', matchWorkspace: true });
      expect(JSON.parse(options.body)).not.toHaveProperty('codexWorkspaceId');
      return response({
        workspace: project,
        importedCount: 2,
        refreshedAt: '2026-10-24T01:00:00Z',
        sessions: [
          { ...session, snapshotVersion: `cx-v${refreshes}` },
          {
            id: 'codex:partial',
            title: 'Codex 未完成会话',
            turnCount: 1,
            syncTurnCount: 0,
            snapshotVersion: 'partial',
            createdAt: 1,
          },
        ],
      });
    }
    if (url.includes('/codex/sessions?'))
      return response({
        workspace: project,
        sessions: imported ? [{ ...session, snapshotVersion: `cx-v${refreshes}` }] : [],
      });
    if (url.includes('/sync-branch-info'))
      return response({ targetBranch: 'feature/dev/orders', baseBranch: 'main' });
    if (url.includes('/sync-commits?'))
      return response({
        commits: [],
        branchTip: 'f'.repeat(40),
        baseline: 'a'.repeat(40),
        hasUncommitted: false,
      });
    if (url.includes('/sessions?')) return response({ sessions: [dsh] });
    if (url.includes('/session-turns?'))
      return response({
        success: true,
        turnCount: 1,
        totalTokens: 100,
        turns: [
          {
            turnNumber: 1,
            syncable: true,
            messages: [
              { role: 'user', kind: 'input', label: '用户输入', text: 'CODEX_USER' },
              {
                role: 'assistant',
                kind: 'intermediate',
                label: '助手中间回复 1',
                text: 'CODEX_INTERMEDIATE',
              },
              { role: 'assistant', kind: 'final', label: '助手最终回复', text: 'CODEX_FINAL' },
            ],
          },
        ],
      });
    if (url.endsWith('/phased-sync')) return response({ skipped: true, message: '已同步' });
    return response({ active: false });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
const click = async (element) => act(async () => element.click());
const button = (text) =>
  [...container.querySelectorAll('button')].find((element) => element.textContent.trim() === text);
const change = async (input, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
async function open() {
  await act(async () =>
    root.render(
      React.createElement(
        DocsViewerContext.Provider,
        { value: { refreshTree: vi.fn(), headerBackTarget: container } },
        React.createElement(SyncPanel, {
          workspaceId: 'ws',
          selectedReq: { id: '2026-10-24-orders', title: '订单' },
          onClose: vi.fn(),
        }),
      ),
    ),
  );
  await click(button('自定义同步'));
  await click(button('同步需求文档'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}
async function refreshCurrentWorkspace() {
  const expand = container.querySelector('[aria-label="展开会话来源"]');
  if (expand) await click(expand);
  await click(
    [...container.querySelectorAll('[role="tab"]')].find((node) =>
      node.textContent.startsWith('Codex 会话'),
    ),
  );
  expect(button('选择 Codex 工作区')).toBeUndefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click(button('刷新 Codex 会话'));
}

it('keeps independent source selections and filters while switching tabs and returning from preview', async () => {
  await open();
  await click(container.querySelector('[aria-label="展开会话来源"]'));
  const tabs = container.querySelector('[role="tablist"][aria-label="会话来源"]');
  const dshTab = () =>
    [...tabs.querySelectorAll('[role="tab"]')].find((node) => node.textContent.startsWith('DSH'));
  const codexTab = () =>
    [...tabs.querySelectorAll('[role="tab"]')].find((node) => node.textContent.startsWith('Codex'));
  expect(dshTab().textContent).toBe('DSH 会话（共 1 · 已选 0）');
  expect(codexTab().textContent).toBe('Codex 会话（共 0 · 已选 0）');
  await click(container.querySelector('[aria-label="选择会话 DSH 完整会话"]'));
  const before = fetchMock.mock.calls.filter(([url]) => url.includes('/sessions?')).length;
  await refreshCurrentWorkspace();
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  await change(container.querySelector('[aria-label="筛选 Codex 会话"]'), '完整');
  expect(dshTab().textContent).toBe('DSH 会话（共 1 · 已选 1）');
  expect(codexTab().textContent).toBe('Codex 会话（共 2 · 已选 1）');
  await click(dshTab());
  expect(container.querySelector('[aria-label="选择会话 DSH 完整会话"]').checked).toBe(true);
  expect(
    container.querySelector('[aria-label="选择 Codex 会话"]').closest('[role="tabpanel"]').hidden,
  ).toBe(true);
  await click(codexTab());
  expect(container.querySelector('[aria-label="筛选 Codex 会话"]').value).toBe('完整');
  expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]').checked).toBe(
    true,
  );
  expect(fetchMock.mock.calls.filter(([url]) => url.includes('/sessions?'))).toHaveLength(before);
  const footer = container.querySelector('footer[aria-label="同步选择汇总"]');
  expect(footer.textContent).toContain('DSH 1 · Codex 1');
  await click(container.querySelector('[aria-label="选择 Codex 会话"] .rh-session-row button'));
  await click(button('返回'));
  expect(
    [...container.querySelectorAll('[role="tab"]')]
      .find((node) => node.textContent.startsWith('Codex 会话'))
      .getAttribute('aria-selected'),
  ).toBe('true');
  expect(container.querySelector('[aria-label="收起会话来源"]')).not.toBeNull();
});

it('always requests the current workspace match and leaves refresh available without matching Codex sessions', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options) => {
    if (url.includes('/codex/sessions?') || url.endsWith('/codex/refresh')) {
      return response({ workspace: null, sessions: [] });
    }
    return original(url, options);
  });
  await open();
  expect(container.textContent).toContain('当前项目暂无 Codex 会话。');
  expect(container.textContent).not.toContain('按当前项目路径匹配');
  expect(button('选择 Codex 工作区')).toBeUndefined();
  expect(button('刷新 Codex 会话').disabled).toBe(false);
  await click(button('刷新 Codex 会话'));
  const listed = fetchMock.mock.calls.find(([url]) => url.includes('/codex/sessions?'));
  expect(listed[0]).toContain('matchWorkspace=true');
  const refreshed = fetchMock.mock.calls.find(([url]) => url.endsWith('/codex/refresh'));
  expect(JSON.parse(refreshed[1].body)).toEqual({
    workspaceId: 'ws',
    stream: true,
    matchWorkspace: true,
  });
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/codex/workspaces'))).toBe(false);
});

it('shows streamed refresh counts before completion and hides progress after the result', async () => {
  await open();
  await refreshCurrentWorkspace();
  let next;
  let initial = true;
  const releaseLock = vi.fn();
  fetchMock.mockImplementationOnce(async () => ({
    ok: true,
    headers: { get: () => 'application/x-ndjson' },
    body: {
      getReader: () => ({
        releaseLock,
        read: () => {
          if (initial) {
            initial = false;
            return Promise.resolve({
              value: new TextEncoder().encode(
                JSON.stringify({ type: 'progress', phase: 'importing', completed: 1, total: 3 }) +
                  '\n',
              ),
              done: false,
            });
          }
          return new Promise((resolve) => {
            next = resolve;
          });
        },
      }),
    },
  }));
  await click(button('刷新 Codex 会话'));
  expect(container.textContent).toContain('正在拉取 Codex 会话（1/3）');
  expect(container.querySelector('progress').value).toBe(1);
  expect(container.querySelector('progress').max).toBe(3);
  expect(button('刷新 Codex 会话').disabled).toBe(true);
  expect(container.textContent).not.toContain('已拉取');
  await act(async () =>
    next({
      value: new TextEncoder().encode(
        JSON.stringify({ type: 'result', result: { workspace: project, sessions: [session] } }) +
          '\n',
      ),
      done: true,
    }),
  );
  expect(container.querySelector('progress')).toBeNull();
  expect(container.textContent).toContain('已拉取');
  expect(button('刷新 Codex 会话').disabled).toBe(false);
  expect(releaseLock).toHaveBeenCalled();
});

it('places Codex under DSH sessions, imports the path-matched workspace and submits both sources with their preview versions', async () => {
  await open();
  expect(button('开始同步需求文档').disabled).toBe(true);
  expect(button('刷新 Codex 会话').disabled).toBe(false);
  const dshArea = container.querySelector('[aria-label="选择相关会话"]');
  const codexArea = container.querySelector('[aria-label="选择 Codex 会话"]');
  expect(
    dshArea.compareDocumentPosition(codexArea) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await refreshCurrentWorkspace();
  expect(container.textContent).toContain('已拉取');
  expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 未完成会话"]').disabled).toBe(
    true,
  );
  await click(container.querySelector('[aria-label="选择会话 DSH 完整会话"]'));
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  expect(button('开始同步需求文档').disabled).toBe(false);
  await click(codexArea.querySelector('.rh-session-row button'));
  await click(button('全部展开'));
  expect(container.textContent).toContain('CODEX_USER');
  expect(container.textContent).toContain('CODEX_INTERMEDIATE');
  expect(container.textContent).toContain('CODEX_FINAL');
  const previewCall = fetchMock.mock.calls.find(([url]) => url.includes('/session-turns?'))[0];
  expect(previewCall).toContain('sessionId=codex%3Aone');
  expect(previewCall).toContain('version=cx-v1');
  await click(button('返回'));
  expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]').checked).toBe(
    true,
  );
  await click(button('开始同步需求文档'));
  const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/phased-sync'));
  expect(JSON.parse(call[1].body)).toMatchObject({
    sessionIds: ['dsh-one', 'codex:one'],
    sessionVersions: { 'dsh-one': 'dsh-v1', 'codex:one': 'cx-v1' },
  });
});

it('clears old selections during refresh, loads new versions and preserves a checked item while filtering', async () => {
  await open();
  await refreshCurrentWorkspace();
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  await change(container.querySelector('[aria-label="筛选 Codex 会话"]'), '找不到');
  expect(container.textContent).toContain('已选择 1 个 Codex 会话');
  await click(button('刷新 Codex 会话'));
  expect(refreshes).toBe(2);
  expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]').checked).toBe(
    false,
  );
  expect(button('开始同步需求文档').disabled).toBe(true);
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  await click(button('开始同步需求文档'));
  const call = fetchMock.mock.calls.find(([url]) => url.endsWith('/phased-sync'));
  expect(JSON.parse(call[1].body)).toMatchObject({
    sessionIds: ['codex:one'],
    sessionVersions: { 'codex:one': 'cx-v2' },
  });
});

it('shows a refresh error and prevents stale imported versions from staying selected', async () => {
  await open();
  await refreshCurrentWorkspace();
  await click(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]'));
  failRefresh = true;
  await click(button('刷新 Codex 会话'));
  expect(container.textContent).toContain('会话正在写入');
  expect(button('开始同步需求文档').disabled).toBe(true);
  expect(container.querySelector('[aria-label="选择 Codex 会话 Codex 完整会话"]')).toBeNull();
});
