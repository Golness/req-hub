// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  React = require('react'),
  { act } = React;
const { createRoot } = require('react-dom/client');
const { ConversationKnowledgeImport } = require('../../src/client/components/ConversationKnowledgeImport.js');
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
  title: 'Fixture conversation',
  source: 'codex',
  snapshotVersion: 'v1',
  turnCount: 3,
};
const dshSession = {
  conversationId: 'dsh-one',
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
}));
const detail = (entry = session, version = 'v1') => ({ entry, version, versions, turns });
const response = (data) => ({ ok: true, json: async () => data });

/** Route knowledge-v2 calls through a handler; unrelated source widgets get empty data. */
function api(options = {}) {
  const fetch = vi.fn(async (url, init) => {
    const parsed = new URL(String(url), 'http://localhost');
    const path = parsed.pathname;
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
      return response(detail(entry || session, parsed.searchParams.get('version') || 'v1'));
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
  expect(document.querySelector('input[aria-label="选择会话：Fixture conversation"]')).not.toBeNull();
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
