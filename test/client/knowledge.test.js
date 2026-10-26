// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { FileTreeSidebar } = require('../../src/client/components/FileTreeSidebar.js');
const { SearchPanel } = require('../../src/client/components/SearchPanel.js');
const { DocsViewerBody } = require('../../src/client/components/DocsViewerBody.js');
const { useKnowledge } = require('../../src/client/hooks/useKnowledge.js');
const { act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const req = { id: '2026-10-22-orders', path: 'alice/2026-10-22-orders', title: '订单' };
const tree = [{ type: 'directory', name: 'nested', path: 'nested', children: [{ type: 'file', name: 'a.md', path: 'nested/a.md' }, { type: 'file', name: 'b.json', path: 'nested/b.json' }] }];
const response = data => ({ ok: true, json: async () => data });
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render(node) { await act(async () => root.render(node)); }
async function click(node) { await act(async () => node.click()); }

it('uses the same tree for preview and controlled multi-selection, including filtered directory selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ tree })));
  const preview = vi.fn(); let selected = [];
  function App() {
    const [paths, setPaths] = React.useState(['bob/2026-10-22-other/old.md']);
    selected = paths;
    return React.createElement(FileTreeSidebar, { workspaceId: 'ws', selectedReq: req, onSelectFile: preview, multiSelect: true, selectedPaths: paths, onSelectionChange: setPaths });
  }
  await render(React.createElement(App));
  await click(container.querySelector('.rh-tree-dir'));
  const a = container.querySelector('[aria-label="选择文件 nested/a.md"]');
  await click(a);
  expect(preview).not.toHaveBeenCalled();
  expect(selected).toContain(req.path + '/nested/a.md');
  expect(container.querySelector('[aria-label="选择目录 nested"]').indeterminate).toBe(true);
  await click(container.querySelector('.rh-tree-file'));
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({ path: req.path + '/nested/a.md' }));
  expect(a.checked).toBe(true);
  await click(container.querySelector('.rh-filter-toggle'));
  await click(container.querySelector('[aria-label="文件类型"]'));
  await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === 'JSON'));
  expect(container.textContent).toContain('不在当前筛选结果');
  await click(container.querySelector('[aria-label="选择目录 nested"]'));
  expect(selected).toEqual(expect.arrayContaining([req.path + '/nested/a.md', req.path + '/nested/b.json', 'bob/2026-10-22-other/old.md']));
});

it('leaves the view tree in single-preview mode without checkboxes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ tree })));
  await render(React.createElement(FileTreeSidebar, { workspaceId: 'ws', selectedReq: req, onSelectFile: vi.fn() }));
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(container.querySelector('.rh-knowledge-selection')).toBeNull();
});

it('does not apply a previous requirement tree after selection changes', async () => {
  let release;
  vi.stubGlobal('fetch', vi.fn(url => url.includes('requirementId=old') ? new Promise(resolve => { release = resolve; }) : Promise.resolve(response({ tree }))));
  await render(React.createElement(FileTreeSidebar, { workspaceId: 'ws', selectedReq: { id: 'old', path: 'old' }, onSelectFile: vi.fn() }));
  await render(React.createElement(FileTreeSidebar, { workspaceId: 'ws', selectedReq: req, onSelectFile: vi.fn() }));
  await act(async () => release(response({ tree: [{ type: 'file', name: 'wrong.md', path: 'wrong.md' }] })));
  expect(container.textContent).not.toContain('wrong.md'); expect(container.textContent).toContain('nested');
});

it('searches knowledge without session calls, handles IME, and opens real source provenance', async () => {
  const source = { workspaceId: 'other', workspaceTitle: '其他工作区', relativePath: req.path + '/requirement.md', startLine: 2, endLine: 5, status: 'active' };
  const openSource = vi.fn();
  const fetchMock = vi.fn(async url => response(url.includes('/search?') ? { hits: [{ id: 'entry', workspaceId: 'other', workspaceTitle: '其他工作区', title: '订单规则', snippet: '审核后发货', sources: [source] }], knowledgeReady: true, hasMore: false } : url.includes('/entries/') ? { id: 'entry', title: '订单规则', body: '已审核订单允许发货', tags: [], version: 1, sources: [source], versions: [] } : { ready: true }));
  vi.stubGlobal('fetch', fetchMock);
  await render(React.createElement(SearchPanel, { workspaceId: 'ws', onOpenSource: openSource }));
  const input = container.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '审核');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  });
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/search?'))).toBe(false);
  await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(container.textContent).toContain('审核后发货');
  expect(container.textContent).toContain('其他工作区');
  expect(fetchMock.mock.calls.filter(([url]) => url.includes('/search')).every(([url]) => !url.includes('workspaceId'))).toBe(true);
  await click(container.querySelector('.rh-knowledge-hit'));
  expect(container.textContent).toContain('已审核订单允许发货');
  await click([...container.querySelectorAll('button')].find(b => b.textContent.includes('requirement.md')));
  expect(openSource).toHaveBeenCalledWith(source);
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/entries/entry?workspaceId=other'))).toBe(true);
  expect(fetchMock.mock.calls.every(([url]) => !url.includes('/sessions'))).toBe(true);
});

it('keeps global search independent of workspace selection', async () => {
  let release;
  vi.stubGlobal('fetch', vi.fn(url => url.includes('/search?') ? new Promise(resolve => { release = resolve; }) : Promise.resolve(response({ ready: true }))));
  await render(React.createElement(SearchPanel, { workspaceId: 'old' }));
  const input = container.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '审核'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await render(React.createElement(SearchPanel, { workspaceId: 'new' }));
  await act(async () => release(response({ hits: [{ id: 'old', title: '旧工作区内容', sources: [] }], knowledgeReady: true })));
  expect(container.textContent).toContain('旧工作区内容');
});

it('keeps cross-requirement selection and builds without fetching or submitting a session', async () => {
  let hook;
  const fetchMock = vi.fn(async (url, options) => response(url.includes('/sessions') ? { sessions: [{ id: 's', title: '会话', isLive: true }] } : options?.method === 'POST' ? { id: 'j', status: 'completed', files: [] } : url.includes('/builds/') ? { id: 'j', status: 'completed', files: [] } : { ready: true, entryCount: 1, sourceCount: 1, latestJobId: 'j' }));
  vi.stubGlobal('fetch', fetchMock);
  function App() { hook = useKnowledge('ws'); return null; }
  await render(React.createElement(App));
  await act(async () => hook.setSelected([req.path + '/a.md', 'bob/2026-10-22-other/b.md']));
  await act(async () => hook.refresh());
  expect(hook.selected).toHaveLength(2);
  await act(async () => hook.start());
  expect(hook.selected).toHaveLength(2);
  const payload = JSON.parse(fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')[1].body);
  expect(payload.files).toHaveLength(2); expect(payload).not.toHaveProperty('sessionId');
  expect(fetchMock.mock.calls.every(([url]) => !url.includes('/sessions'))).toBe(true);
});

it('opens knowledge search as its fourth tab with Ctrl+K and no independent rail entry', async () => {
  vi.stubGlobal('fetch', vi.fn(async url => response(url.includes('/tree?') ? { tree: { developers: [{ name: 'alice', requirements: [req] }] } } : url.includes('/entries') ? { entries: [], candidates: [] } : url.includes('/sessions') ? { sessions: [] } : { ready: false })));
  await render(React.createElement(DocsViewerBody, { workspace: { id: 'ws', title: '工作区' }, docsDir: 'docs', workspaces: [], onSelectWorkspace: vi.fn(), onConfigChange: vi.fn() }));
  const button = text => [...container.querySelectorAll('.rh-rail-btn')].find(b => b.textContent === text);
  expect(button('工作台')).toBeUndefined();
  expect(button('知识库')).toBeTruthy(); expect(button('搜索')).toBeUndefined();
  await click(button('知识库'));
  expect(container.querySelector('.rh-file-tree-sidebar')).toBeTruthy();
  expect(button('知识库').className).toContain('active'); expect(button('查看')).toBeUndefined();
  expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['查看文档', '文档入库', '会话入库', '搜索']);
  expect(container.querySelector('.rh-file-tree-sidebar')).toBeTruthy();
  expect(container.querySelector('.rh-knowledge-selection')).toBeNull();
  await click([...container.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === '文档入库'));
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true })));
  expect(container.querySelector('.rh-file-tree-sidebar').classList.contains('collapsed')).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true })));
  expect(container.querySelector('.rh-knowledge-selection')).toBeTruthy();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
  expect(button('知识库').className).toContain('active');
  expect(container.querySelector('#knowledge-tab-search').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(container.querySelector('input[type="search"]'));
  expect(container.querySelector('.rh-file-tree-sidebar')).toBeNull();
});
