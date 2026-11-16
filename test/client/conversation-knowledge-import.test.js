// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  React = require('react'),
  { act } = React;
const { createRoot } = require('react-dom/client');
const {
  ConversationKnowledgeImport,
} = require('../../src/client/components/ConversationKnowledgeImport.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  container?.remove();
  root = null;
  vi.unstubAllGlobals();
});

const TARGET = 'target-kb';
const workspace = { id: TARGET, title: 'Target workspace', path: '/knowledge/target' };
const session = {
  conversationId: 'conversation-one',
  id: 'codex:sess-one',
  title: 'Fixture conversation',
  source: 'codex',
  snapshotVersion: 'v1',
  turnCount: 3,
};
const dshSession = {
  conversationId: 'dsh-one',
  id: 'dsh-native-one',
  title: 'DSH discussion',
  source: 'dsh',
  snapshotVersion: 'v1',
  turnCount: 3,
};
const versions = [
  { version: 'v1', created_at: '2026-10-25' },
  { version: 'v0', created_at: '2026-10-24' },
];
const turns = [1, 2, 3].map((number) => ({
  key: 'turn-' + number,
  number,
  knowledgeState: ['new', 'same', 'changed'][number - 1],
  importable: number !== 2,
  syncable: number !== 3,
  messages: [
    {
      role: 'user',
      kind: 'input',
      label: '用户输入',
      text: '轮次 ' + number + ' 的原始输入',
    },
    {
      role: 'assistant',
      kind: 'final',
      label: '助手最终回复',
      text: '轮次 ' + number + ' 的完整回复',
    },
  ],
}));
const detail = (entry = session, version = 'v1') => ({ entry, version, versions, turns });
const response = (data) => ({ ok: true, json: async () => data });

/** Route knowledge-v2 calls through a handler; unrelated source widgets get empty data. */
function api(options = {}) {
  const fetch = vi.fn(async (url, init) => {
    const parsed = new URL(String(url), 'http://localhost');
    const path = parsed.pathname;
    if (path === '/req-hub/session-turns') {
      return response(options.sessionTurns || { success: true, turns: [] });
    }
    if (!path.startsWith('/req-hub/knowledge-v2')) {
      return response({ sessions: [], workspaces: [], items: [], total: 0 });
    }
    const tail = path.slice('/req-hub/knowledge-v2'.length);
    if (tail === '/sources/sessions' && init?.method === 'POST') {
      return response({ saved: 1, skipped: 0, failed: 0, job: { id: 'job-1' } });
    }
    if (tail === '/sources/sessions') {
      return response({
        workspace: Object.hasOwn(options, 'workspace') ? options.workspace : workspace,
        sessions: options.sessions || [session],
        adapters: [],
      });
    }
    if (tail === '/sources/sessions/detail') {
      const id = parsed.searchParams.get('id');
      const entry = (options.sessions || [session]).find((item) => item.conversationId === id);
      return response(
        options.detail || detail(entry || session, parsed.searchParams.get('version') || 'v1'),
      );
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function render(target = TARGET) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(ConversationKnowledgeImport, {
        initialTarget: target,
        onClose: vi.fn(),
        onImported: vi.fn(),
      }),
    ),
  );
}
const button = (text) =>
  [...document.querySelectorAll('button')].find((node) => node.textContent === text);
const click = async (node) => act(async () => node.click());
const flush = () => act(async () => {});
function setInputValue(element, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
const tabs = () => [
  ...document.querySelectorAll('[role="tablist"][aria-label="会话来源"] [role="tab"]'),
];

it.each([undefined, { id: 'wrong-workspace' }])(
  'rejects unscoped or mismatched workspace responses instead of showing global conversations',
  async (returnedWorkspace) => {
    api({ workspace: returnedWorkspace });
    await render();
    await flush();
    expect(document.querySelector('[role="alert"]').textContent).toContain(
      '工作区无效，请重新选择工作区。',
    );
    expect(document.querySelector('input[aria-label="选择会话：Fixture conversation"]')).toBeNull();
    expect(button('导入所选轮次').disabled).toBe(true);
  },
);

it('uses the current workspace without destination or source workspace pickers', async () => {
  const fetch = api();
  await render();
  await flush();
  const optionsCall = fetch.mock.calls.find(([url]) =>
    String(url).includes('/req-hub/knowledge-v2/sources/sessions?'),
  );
  expect(optionsCall).toBeTruthy();
  expect(optionsCall[0]).toContain('workspaceId=target-kb');
  expect(fetch.mock.calls.some(([url]) => String(url).includes('-options'))).toBe(false);
  expect(document.querySelector('button[aria-label="目标知识库工作区"]')).toBeNull();
  expect(document.querySelector('button[aria-label="DSH 会话工作区"]')).toBeNull();
  expect(
    document.querySelector('input[aria-label="选择会话：Fixture conversation"]'),
  ).not.toBeNull();
  expect(button('导入所选轮次').disabled).toBe(true);
});

it('groups DSH and Codex sessions by source', async () => {
  api({ sessions: [session, dshSession] });
  await render();
  await flush();
  const groups = [...document.querySelectorAll('[data-source]')];
  expect(groups.map((node) => node.getAttribute('data-source'))).toEqual(['dsh', 'codex']);
  expect(groups.map((node) => node.getAttribute('aria-label'))).toEqual(['DSH', 'Codex']);
  expect(document.querySelector('input[aria-label="选择会话：DSH discussion"]')).not.toBeNull();
});

it('switches DSH and Codex through tabs while keeping per-source search drafts', async () => {
  api({ sessions: [session, dshSession] });
  await render();
  await flush();
  const switches = tabs();
  expect(switches).toHaveLength(2);
  expect(switches.map((node) => node.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  const dshPanel = document.querySelector('[role="tabpanel"][data-source="dsh"]');
  const codexPanel = document.querySelector('[role="tabpanel"][data-source="codex"]');
  expect(dshPanel.hidden).toBe(false);
  expect(codexPanel.hidden).toBe(true);
  await act(async () => setInputValue(dshPanel.querySelector('input[type="search"]'), 'DSH'));
  expect(dshPanel.querySelector('input[type="search"]').value).toBe('DSH');
  await click(switches[1]);
  expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  expect(dshPanel.hidden).toBe(true);
  expect(codexPanel.hidden).toBe(false);
  expect(codexPanel.querySelector('input[type="search"]').value).toBe('');
  await click(switches[0]);
  expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  expect(dshPanel.querySelector('input[type="search"]').value).toBe('DSH');
});

it('keeps selected turns and the import action when the active source changes', async () => {
  api({ sessions: [session, dshSession] });
  await render();
  await flush();
  await click(tabs()[1]);
  await click(document.querySelector('input[aria-label="选择会话：Fixture conversation"]'));
  await flush();
  expect(document.body.textContent).toContain('已选择 1 个会话、2 个轮次');
  await click(tabs()[0]);
  expect(document.body.textContent).toContain('已选择 1 个会话、2 个轮次');
  expect(button('导入所选轮次').disabled).toBe(false);
});

it('uses the shared tab, action bar and inset pager layout', async () => {
  api();
  await render();
  await flush();
  const dialog = document.querySelector('[data-rh-modal]');
  expect(dialog.querySelector('[role="tablist"][aria-label="会话来源"]')).toBeTruthy();
  expect(
    [...dialog.querySelectorAll('[role="tabpanel"][data-source]')].map((node) =>
      node.getAttribute('data-source'),
    ),
  ).toEqual(['dsh', 'codex']);
  expect(dialog.textContent).toContain('/knowledge/target');
  const bar = dialog.querySelector('[data-rh-action-bar="section"]');
  expect(bar).toBeTruthy();
  expect(bar.textContent).toContain('已选择 0 个会话、0 个轮次');
  expect(bar.textContent).toContain('保存并更新 Wiki');
  expect(dialog.querySelector('[data-rh-paged-inset="true"]')).toBeTruthy();
  expect(
    new Set(
      [...dialog.querySelectorAll('[role="tabpanel"] [data-rh-size]')].map((node) =>
        node.getAttribute('data-rh-size'),
      ),
    ),
  ).toEqual(new Set(['sm']));
});

it('previews the frozen conversation content without changing the turn selection', async () => {
  const fetch = api();
  await render();
  await flush();
  const previewButton = () =>
    [...document.querySelectorAll('button')].find((node) => node.textContent === '查看内容');
  expect(previewButton()).toBeTruthy();
  await click(previewButton());
  await flush();
  expect(document.querySelector('[aria-label="会话内容"]')).toBeTruthy();
  expect(document.querySelector('[aria-label="会话内容"]').textContent).toContain('第 1 轮');
  expect(document.querySelector('[aria-label="会话轮次"]')).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/session-turns'))).toBe(false);
  await click(button('全部展开'));
  expect(document.body.textContent).toContain('轮次 1 的完整回复');
  expect(document.body.textContent).toContain('轮次 3 的原始输入');
  expect(button('导入所选轮次').disabled).toBe(true);
  const detailCalls = fetch.mock.calls.filter(([url]) =>
    String(url).includes('/sources/sessions/detail'),
  );
  expect(detailCalls).toHaveLength(1);
  await click(button('选择轮次'));
  await flush();
  expect(document.querySelector('[aria-label="会话轮次"]')).toBeTruthy();
  expect(
    fetch.mock.calls.filter(([url]) => String(url).includes('/sources/sessions/detail')),
  ).toHaveLength(1);
});

/** Older Host processes return turns with no frozen text at all. */
const detailWithoutText = {
  entry: session,
  version: 'v1',
  versions,
  turns: turns.map(({ messages, ...item }) => item),
};
const syncSnapshot = {
  success: true,
  version: 'v1',
  turns: [1, 2, 3].map((number) => ({
    turnNumber: number,
    messages: [
      { role: 'user', kind: 'input', label: '用户输入', text: `同步输入 ${number}` },
      { role: 'assistant', kind: 'final', label: '助手最终回复', text: `同步回复 ${number}` },
    ],
  })),
};

it('fills missing frozen text from the sync-side session snapshot', async () => {
  const fetch = api({ detail: detailWithoutText, sessionTurns: syncSnapshot });
  await render();
  await flush();
  await click(button('查看内容'));
  await flush();
  await flush();
  await click(button('全部展开'));
  await flush();
  expect(document.body.textContent).toContain('同步回复 1');
  expect(document.body.textContent).toContain('同步输入 3');
  expect(document.body.textContent).toContain('正文来自同步功能');
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/session-turns'))).toBe(true);
  expect(
    fetch.mock.calls.filter(([url]) => String(url).includes('/sources/sessions/detail')),
  ).toHaveLength(1);
});

it('explains unavailable conversation text instead of rendering blank rows', async () => {
  api({ detail: detailWithoutText, sessionTurns: { success: false, error: 'SESSION_CHANGED' } });
  await render();
  await flush();
  await click(button('查看内容'));
  await flush();
  await flush();
  await click(button('全部展开'));
  await flush();
  expect(document.body.textContent).toContain('这一轮没有可显示的正文');
  expect(document.body.textContent).toContain('无法读取会话正文');
});

it('selects only importable frozen turns and submits the chosen rounds', async () => {
  const fetch = api();
  await render();
  await flush();
  await click(document.querySelector('input[aria-label="选择会话：Fixture conversation"]'));
  await flush();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.textContent).toContain('已选择 1 个会话、2 个轮次');
  await click([...document.querySelectorAll('[aria-label="会话轮次"] input')][0]);
  await click(button('导入所选轮次'));
  await flush();
  const post = fetch.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/req-hub/knowledge-v2/sources/sessions') && init?.method === 'POST',
  );
  expect(post).toBeTruthy();
  expect(JSON.parse(post[1].body)).toEqual({
    workspaceId: TARGET,
    selections: [{ id: 'conversation-one', version: 'v1', turnKeys: ['turn-3'] }],
    mode: 'merge',
    ingest: true,
  });
  expect(document.body.textContent).toContain('已加入导入队列');
});

it('clears selected rounds when the frozen snapshot version changes', async () => {
  api();
  await render();
  await flush();
  await click(document.querySelector('input[aria-label="选择会话：Fixture conversation"]'));
  await flush();
  expect(document.body.textContent).toContain('已选择 1 个会话、2 个轮次');
  const version = document.querySelector('button[aria-label="会话版本"]');
  if (version) {
    await click(version);
    const option = document.querySelector('[role="menuitem"][data-value="v0"]');
    if (option) {
      await click(option);
      await flush();
    }
  }
  expect(button('导入所选轮次').disabled).toBe(true);
});

it('aborts a pending session-list request when the panel unmounts', async () => {
  let signal;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init) =>
        new Promise((resolve) => {
          signal = init?.signal;
          setTimeout(() => resolve(response({ workspace, sessions: [] })), 10);
        }),
    ),
  );
  await render();
  await act(async () => root.unmount());
  root = null;
  expect(signal?.aborted).toBe(true);
});
