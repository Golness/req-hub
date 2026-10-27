// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor, editorViewCtx } from '@milkdown/core';
const require = createRequire(import.meta.url);
const React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { WritingPanel, writingChanges, mergedWriting } = require('../../src/client/components/WritingPanel.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, fetchMock, requests, job;
const before = '# 订单\n\n原始规则\n\n## 验收\n\n原始验收\n';
const after = '# 订单\n\n知识库规则\n\n## 验收\n\n可验证验收\n';
beforeEach(() => {
  localStorage.clear(); requests = []; job = 0;
  localStorage.setItem('req-hub:writing:ws', JSON.stringify({ requirement: before, design: '# 技术方案草稿' }));
  window.__DSH_CTX__ = { get: () => ({ selection: { getSnapshot: () => ({ sessionId: 'parent' }) } }) };
  fetchMock = vi.fn(async (url, options) => {
    let data;
    if (url.endsWith('/options')) data = { scopes: [{ id: 'scope', workspaceId: 'other', title: '跨工作区库', entryCount: 1 }], starters: { requirement: { label: '需求文档', content: '# 需求模板' }, design: { label: '技术方案', content: '# 方案模板' } } };
    else if (url.endsWith('/optimize')) { requests.push(JSON.parse(options.body)); job++; data = { id: `job-${job}`, status: 'running' }; }
    else if (url.includes('/jobs/')) data = { status: 'completed', result: { original: requests.at(-1).content, content: after, evidence: [{ id: 'source', workspaceTitle: '跨工作区库', version: 3, sources: [{ relativePath: 'alice/orders.md' }] }] } };
    else throw new Error(url);
    return { ok: true, json: async () => data };
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; delete window.__DSH_CTX__; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent === text);
const click = async node => act(async () => node.click());
async function render() {
  await act(async () => root.render(React.createElement(WritingPanel, { workspaceId: 'ws' })));
  await act(async () => vi.waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull()));
}
it('preserves unchanged bytes and combines independent accept and reject decisions', () => {
  const parts = writingChanges('first\r\nold\r\nmiddle\r\nlast\r\n', 'first\r\nnew\r\nmiddle\r\nend\r\n');
  const changes = parts.filter(p => p.text === undefined); expect(changes).toHaveLength(2);
  changes[0].decision = 'accept'; changes[1].decision = 'reject';
  expect(mergedWriting(parts)).toBe('first\r\nnew\r\nmiddle\r\nlast\r\n');
});
it('selects global knowledge, reviews individual diffs and sends merged text into the next optimization', async () => {
  await render();
  await click(container.querySelector('input[type="checkbox"]'));
  expect(button('开始起稿').disabled).toBe(true);
  await click(button('优化'));
  expect(requests[0]).toMatchObject({ scopeIds: ['scope'], sessionId: 'parent', content: before, docType: 'requirement' });
  expect(container.textContent).toContain('alice/orders.md');
  expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('false');
  await click(button('合并此处'));
  await click(button('保留原文'));
  expect(container.querySelector('[aria-label="优化差异"]')).toBeNull();
  expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');
  expect(JSON.parse(localStorage.getItem('req-hub:writing:ws')).requirement).toBe('# 订单\n\n知识库规则\n\n## 验收\n\n原始验收\n');
  await click(button('优化'));
  expect(requests[1].content).toContain('知识库规则'); expect(requests[1].content).toContain('原始验收');
  await click(button('合并全部剩余建议'));
  expect(JSON.parse(localStorage.getItem('req-hub:writing:ws')).requirement).toBe(after);
});
it('keeps the two document types independent and retains drafts on optimization failure', async () => {
  await render();
  await click(container.querySelector('.rh-select-trigger'));
  await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === '技术方案'));
  expect(container.querySelector('.ProseMirror').textContent).toContain('技术方案草稿');
  fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: '没有可用会话' }) }));
  await click(button('优化'));
  expect(container.textContent).toContain('没有可用会话');
  expect(JSON.parse(localStorage.getItem('req-hub:writing:ws')).requirement).toBe(before);
  expect(container.querySelector('.ProseMirror').textContent).toContain('技术方案草稿');
  expect(button('优化').disabled).toBe(false);
});
it('supports blank or starter text without writing any existing document', async () => {
  localStorage.clear(); await render();
  await click(container.querySelectorAll('.rh-select-trigger')[1]);
  await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === '需求文档'));
  await click(button('开始起稿'));
  expect(container.querySelector('.ProseMirror').textContent).toContain('需求模板');
  expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
});
it('allows a new blank draft to be edited immediately and persists it without starting from a template', async () => {
  localStorage.clear();
  const make = vi.spyOn(Editor, 'make');
  await render();
  const editorRoot = container.querySelector('.rh-milkdown-editor');
  const editable = container.querySelector('.ProseMirror');
  expect(editorRoot.hidden).toBe(false);
  expect(editable.getAttribute('contenteditable')).toBe('true');
  expect(button('优化').disabled).toBe(true);
  await act(async () => {
    make.mock.results[0].value.action(ctx => {
      const view = ctx.get(editorViewCtx);
      view.focus();
      view.dispatch(view.state.tr.insertText('直接编写需求正文', 1));
    });
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  expect(JSON.parse(localStorage.getItem('req-hub:writing:ws')).requirement).toContain('直接编写需求正文');
  expect(document.activeElement).toBe(editable);
  expect(button('优化').disabled).toBe(false);
  expect(button('下载 Markdown').disabled).toBe(false);
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
