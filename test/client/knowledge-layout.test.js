// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { DocsViewerBody } = require('../../src/client/components/DocsViewerBody.js');
const { FileKnowledgeAction } = require('../../src/client/components/FileKnowledgeAction.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const req = { id: '2026-10-22-orders', path: 'alice/2026-10-22-orders', title: 'Orders' };
const file = req.path + '/notes.txt';
beforeEach(() => { localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const response = data => ({ ok: true, json: async () => data });
function api() {
  let indexed = false, job = null, text = 'Original document';
  const fetch = vi.fn(async (url, init) => {
    const parsed = new URL(String(url), 'http://localhost'), path = parsed.pathname;
    if (path.endsWith('/tree')) return response({ tree: { developers: [{ name: 'alice', requirements: [req] }] } });
    if (path.endsWith('/file-tree')) return response({ tree: [{ type: 'file', path: 'notes.txt', name: 'notes.txt' }] });
    if (path.endsWith('/read')) return response({ text });
    if (path.endsWith('/write')) { text = JSON.parse(init.body).content; return response({ success: true }); }
    if (path.endsWith('/source')) return response({ indexed, status: indexed ? 'active' : 'not_imported' });
    if (path.endsWith('/status')) return response({ ready: indexed, entryCount: +indexed, sourceCount: +indexed, documentCount: +indexed, latestJobId: job?.id });
    if (path.endsWith('/builds')) {
      const body = JSON.parse(init.body); indexed = true;
      job = { id: 'job-1', status: 'completed', updatedAt: 'one', counts: { completed: body.files.length }, files: body.files.map(file => ({ ...file, status: 'completed' })) };
      return response(job);
    }
    if (path.includes('/builds/')) return response(job);
    if (path.endsWith('/entries')) return response({ entries: [{ id: 'doc', title: 'Imported document', version: 1, body: 'Document body', sources: [] }, { id: 'chat', title: 'Imported chat', conversation: { title: 'Imported chat', turns: [] }, body: 'Chat body', sources: [] }] });
    if (path.endsWith('-options')) return response({ targets: [{ id: 'ws', title: 'Workspace', path: '/repo' }], sessions: [] });
    if (path.endsWith('/codex/sessions')) return response({ workspace: null, sessions: [] });
    if (path.endsWith('/sessions')) return response({ sessions: [] });
    return response({});
  });
  vi.stubGlobal('fetch', fetch); return fetch;
}
const click = async node => act(async () => node.click());
const tab = label => [...container.querySelectorAll('[role="tab"]')].find(node => node.textContent === label);
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
async function open() {
  await act(async () => root.render(React.createElement(DocsViewerBody, { workspace: { id: 'ws', title: 'Workspace' }, docsDir: 'docs', workspaces: [], initialReqId: req.id, onConfigChange() {}, onSelectWorkspace() {} })));
  await click([...container.querySelectorAll('.rh-rail-btn')].find(node => node.textContent === '知识库'));
}
it('replaces the view rail entry with three keyboard-accessible knowledge tabs and inline conversation ingestion', async () => {
  api(); await open();
  expect([...container.querySelectorAll('.rh-rail-btn')].some(node => node.textContent === '查看')).toBe(false);
  expect([...container.querySelectorAll('[role="tab"]')].map(node => node.textContent)).toEqual(['查看文档', '文档入库', '会话入库']);
  const tabs = container.querySelector('[role="tablist"]');
  expect(tabs.closest('.rh-right-panel')).toBeNull();
  expect(tabs.compareDocumentPosition(container.querySelector('.rh-file-tree-sidebar')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(tabs.compareDocumentPosition(container.querySelector('.rh-right-header')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(container.querySelector('.rh-knowledge-selection')).toBeNull();
  await click(tab('文档入库'));
  expect(container.querySelector('.rh-knowledge-selection')).not.toBeNull();
  expect(container.querySelector('.rh-result-card').textContent).toContain('Imported document');
  expect(container.querySelector('.rh-knowledge-results').textContent).not.toContain('Imported chat');
  expect(button('导入会话到知识库')).toBeUndefined();
  await act(async () => tab('文档入库').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(tab('会话入库').getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('.rh-file-tree-sidebar')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button('刷新会话')).toBeTruthy(); expect(button('选择 Codex 工作区')).toBeTruthy(); expect(button('导入所选轮次')).toBeTruthy();
});
it('ingests an unindexed viewed document next to its breadcrumb and hides the action once indexed', async () => {
  const fetch = api(); await open(); await click(container.querySelector('.rh-tree-file'));
  expect(container.querySelector('.rh-breadcrumb').textContent).toContain('notes.txt');
  expect(container.querySelector('.rh-right-header').contains(button('入库'))).toBe(true);
  expect(container.querySelector('.rh-edit-toolbar-header')).not.toBeNull();
  await click(button('入库'));
  const call = fetch.mock.calls.find(([url, init]) => String(url).endsWith('/builds') && init?.method === 'POST');
  expect(JSON.parse(call[1].body)).toMatchObject({ workspaceId: 'ws', files: [{ relativePath: file }] });
  expect(button('入库')).toBeUndefined();
  expect(container.querySelector('.rh-right-header').textContent).toContain('已入库');
});
it('preserves a source-edit draft across tabs, prevents ingesting unsaved text, and retains batch selections', async () => {
  const fetch = api(); await open(); await click(tab('文档入库'));
  await click(container.querySelector('input[aria-label="选择文件 notes.txt"]'));
  await click(container.querySelector('.rh-tree-file'));
  expect(tab('查看文档').getAttribute('aria-selected')).toBe('true');
  await click(container.querySelector('[title="编辑文件"]') || button('编辑'));
  const editor = container.querySelector('textarea.rh-text-editor');
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(editor, 'Draft text'); editor.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('入库').disabled).toBe(true);
  expect(button('入库').title).toContain('先保存');
  await click(tab('文档入库'));
  expect(container.querySelector('input[aria-label="选择文件 notes.txt"]').checked).toBe(true);
  await act(async () => container.querySelector('.rh-file-tree-sidebar input').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })));
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/write'))).toBe(false);
  await click(tab('查看文档'));
  expect(container.querySelector('textarea.rh-text-editor').value).toBe('Draft text');
  await click(container.querySelector('[title="保存文件 (Ctrl+S)"]'));
  expect(JSON.parse(fetch.mock.calls.find(([url]) => String(url).endsWith('/write'))[1].body).content).toBe('Draft text');
  expect(button('入库').disabled).toBe(false);
});
it('looks up and builds a foreign source in its own workspace rather than the visible workspace', async () => {
  const fetch = api();
  await act(async () => root.render(React.createElement(FileKnowledgeAction, { workspaceId: 'other', path: file, onChanged() {} })));
  await click(button('入库'));
  const get = fetch.mock.calls.find(([url]) => String(url).includes('/source?'));
  expect(String(get[0])).toContain('workspaceId=other');
  const post = fetch.mock.calls.find(([url, init]) => String(url).endsWith('/builds') && init?.method === 'POST');
  expect(JSON.parse(post[1].body).workspaceId).toBe('other');
});
