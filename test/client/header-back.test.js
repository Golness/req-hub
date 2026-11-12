// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { DocsViewerBody } = require('../../src/client/components/DocsViewerBody.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const req = {
  id: '2026-10-23-orders',
  developer: 'alice',
  path: 'alice/2026-10-23-orders',
  title: '订单',
  date: '2026-10-23',
};
const relativePath = `${req.path}/rules.txt`;
const source = {
  id: 'src-1',
  kind: 'file',
  title: '订单规则',
  revision: 'rev-1',
  bytes: 12,
  origin: { relativePath },
};
let root, container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      let data = {};
      if (url.includes('/knowledge-v2/pages')) data = { pages: [], generationId: null };
      else if (url.includes('/knowledge-v2/jobs')) data = { jobs: [] };
      else if (url.includes('/knowledge-v2/sources?')) data = { items: [source], total: 1 };
      else if (url.includes('/knowledge-v2/sources/src-1'))
        data = { source, content: '审核规则', provenance: { importedAt: '2026-10-23T00:00:00Z' } };
      else if (url.includes('/knowledge-v2/')) data = {};
      else if (url.includes('/tree?'))
        data = { tree: { developers: [{ name: 'alice', requirements: [req] }] } };
      else if (url.includes('/file-tree'))
        data = { tree: [{ type: 'file', path: 'rules.txt', name: 'rules.txt' }] };
      else if (url.includes('/sessions?')) data = { sessions: [{ id: 's', title: '讨论会话' }] };
      else if (url.includes('/session-turns?')) data = { success: true, turns: [] };
      else if (url.includes('/sync-branch-info'))
        data = { targetBranch: 'feature/orders', baseBranch: null };
      else if (url.includes('/sync-history')) data = { history: [] };
      else if (url.includes('/read?')) data = { text: '审核规则' };
      return { ok: true, status: 200, json: async () => data };
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function open(overrides = {}) {
  await act(async () =>
    root.render(
      React.createElement(DocsViewerBody, {
        workspace: { id: 'ws', title: '工作区' },
        docsDir: 'docs',
        workspaces: [],
        initialReqId: req.id,
        onConfigChange: vi.fn(),
        onSelectWorkspace: vi.fn(),
        ...overrides,
      }),
    ),
  );
}
const click = async (element) => act(async () => element.click());
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
const button = (text) =>
  [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === text);
const rail = (text) =>
  [...container.querySelectorAll('.rh-rail-btn')].find((el) => el.textContent.trim() === text);
function backCount(count) {
  expect(container.querySelectorAll('.rh-header-back')).toHaveLength(count);
  expect(container.querySelectorAll('.rh-header-back-slot .rh-header-back')).toHaveLength(count);
  const syncTabs = container.querySelector('[aria-label="同步方式"]');
  if (!syncTabs) {
    expect(container.querySelector('.rh-right-body .rh-header-back')).toBeNull();
  }
}

it('uses a single header return for nested sync pages and removes it at the root', async () => {
  await open();
  await click(rail('同步'));
  expect(container.querySelector('.rh-right-header')).toBeNull();
  await click(button('自定义同步'));
  backCount(0);
  await click(button('同步需求文档'));
  backCount(1);
  await click(button('查看内容'));
  backCount(1);
  expect(container.textContent).toContain('该会话没有对话内容');
  await click(button('返回'));
  backCount(1);
  expect(button('开始同步需求文档')).toBeTruthy();
  await click(button('返回'));
  backCount(0);
  expect(button('同步需求文档')).toBeTruthy();
  await click(button('同步历史'));
  expect(container.querySelector('#sync-tab-history').getAttribute('aria-selected')).toBe('true');
  backCount(0);
  await click(button('自定义同步'));
  backCount(0);
});

it('returns from a knowledge source to its file and back to the owning knowledge tab', async () => {
  await open({
    initialLocation: {
      reportTarget: { kind: 'knowledge', workspaceId: 'ws', documentId: 'src-1' },
    },
  });
  const tabs = container.querySelector('[role="tablist"][aria-label="知识库功能"]');
  expect(tabs).not.toBeNull();
  expect([...tabs.querySelectorAll('[role="tab"]')].find((node) => node.getAttribute('aria-selected') === 'true').textContent).toBe('资料');
  await settle();
  await click(button('打开原文件'));
  expect(container.querySelector('#files-tree')).not.toBeNull();
  expect(container.querySelector('.rh-breadcrumb').textContent).toContain('rules.txt');
  expect(container.querySelector('.rh-file-preview')).not.toBeNull();
  await click(container.querySelector('.rh-right-close'));
  expect(container.querySelector('.rh-file-preview')).toBeNull();
  const restored = container.querySelector('[role="tablist"][aria-label="知识库功能"]');
  expect([...restored.querySelectorAll('[role="tab"]')].find((node) => node.getAttribute('aria-selected') === 'true').textContent).toBe('资料');
});
