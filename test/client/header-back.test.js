// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { DocsViewerBody } = require('../../src/client/components/DocsViewerBody.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const req = { id: '2026-10-23-orders', developer: 'alice', path: 'alice/2026-10-23-orders', title: '订单', date: '2026-10-23' };
const source = { relativePath: `${req.path}/rules.txt`, startLine: 1, endLine: 2, workspaceId: 'ws', workspaceTitle: '工作区' };
const entry = { id: 'entry', title: '订单规则', snippet: '审核规则', body: '审核规则', tags: [], sources: [source], workspaceId: 'ws', workspaceTitle: '工作区', version: 1 };
let root, container;
beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async url => {
    let data = {};
    if (url.includes('/knowledge/entries/')) data = entry;
    else if (url.includes('/knowledge/search?')) data = { hits: [entry], knowledgeReady: true };
    else if (url.includes('/tree?')) data = { tree: { developers: [{ name: 'alice', requirements: [req] }] } };
    else if (url.includes('/sessions?')) data = { sessions: [{ id: 's', title: '讨论会话' }] };
    else if (url.includes('/session-turns?')) data = { success: true, turns: [] };
    else if (url.includes('/sync-branch-info')) data = { targetBranch: 'feature/orders', baseBranch: null };
    else if (url.includes('/sync-history')) data = { history: [] };
    else if (url.includes('/read?')) data = { text: '审核规则' };
    return { ok: true, status: 200, json: async () => data };
  }));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function open() { await act(async () => root.render(React.createElement(DocsViewerBody, { workspace: { id: 'ws', title: '工作区' }, docsDir: 'docs', workspaces: [], onConfigChange: vi.fn(), onSelectWorkspace: vi.fn() }))); }
const click = async element => act(async () => element.click());
const button = text => [...container.querySelectorAll('button')].find(el => el.textContent.trim() === text);
const rail = text => [...container.querySelectorAll('.rh-rail-btn')].find(el => el.textContent.trim() === text);
function backCount(count) {
  expect(container.querySelectorAll('.rh-header-back')).toHaveLength(count);
  expect(container.querySelectorAll('.rh-right-header > .rh-header-back-slot .rh-header-back')).toHaveLength(count);
  expect(container.querySelector('.rh-right-body .rh-header-back')).toBeNull();
}

it('uses a single header return for nested sync pages and removes it at the root', async () => {
  await open(); await click(rail('同步')); backCount(0);
  await click(button('同步需求文档')); backCount(1);
  await click(button('查看内容')); backCount(1);
  expect(container.textContent).toContain('该会话没有对话内容');
  await click(button('返回')); backCount(1);
  expect(button('开始同步需求文档')).toBeTruthy();
  await click(button('返回')); backCount(0);
  expect(button('同步需求文档')).toBeTruthy();
  await click(button('同步历史')); backCount(1);
  await click(button('返回')); backCount(0);
});

it('returns from a source to search detail and results, and hides navigation on other pages', async () => {
  await open(); await click(rail('知识库'));
  await click(container.querySelector('#knowledge-tab-search')); backCount(0);
  const input = container.querySelector('[aria-label="搜索整个知识库"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '审核');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('form[role="search"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await click(container.querySelector('.rh-knowledge-hit')); backCount(1);
  await click(rail('同步')); backCount(0);
  await click(rail('知识库')); backCount(1);
  await click([...container.querySelectorAll('[aria-label="知识详情"] button')].find(el => el.textContent.includes('rules.txt'))); backCount(1);
  expect(container.querySelector('.rh-file-preview')).toBeTruthy();
  await click(button('返回')); backCount(1);
  expect(container.querySelector('#knowledge-tab-search').getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('[aria-label="知识详情"]')).toBeTruthy();
  expect(input.value).toBe('审核');
  await click(button('返回')); backCount(0);
  expect(container.querySelector('.rh-knowledge-hit')).toBeTruthy();
});
