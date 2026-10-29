// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Editor, editorViewCtx } from '@milkdown/core';
const require = createRequire(import.meta.url);
const React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { DiffReviewProvider } = require('../../src/client/components/shared/DiffReviewPage.js');
const { SessionSelectionContext } = require('../../src/client/context.js');
const { WritingPanel, writingChanges, mergedWriting, writingDraftKey } = require('../../src/client/components/WritingPanel.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, fetchMock, requests, job;
const before = '# 订单\n\n原始规则\n\n## 验收\n\n原始验收\n';
const after = '# 订单\n\n知识库规则\n\n## 验收\n\n可验证验收\n';
beforeEach(() => {
  localStorage.clear(); requests = []; job = 0;
  localStorage.setItem(writingDraftKey('ws'), JSON.stringify({ requirement: before, design: '# 技术方案草稿' }));
  window.__DSH_CTX__ = { get: () => ({ selection: { getSnapshot: () => ({ sessionId: 'parent' }) } }) };
  fetchMock = vi.fn(async (url, options) => {
    let data;
    if (url.includes('/jobs?')) data = { jobs: [] };
    else if (url.endsWith('/options')) data = { scopes: [{ id: 'scope', workspaceId: 'other', title: '跨工作区库', entryCount: 1 }], starters: { requirement: { label: '需求文档', content: '# 需求模板' }, design: { label: '技术方案', content: '# 方案模板' } } };
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
async function render(props = {}) {
  await act(async () => root.render(React.createElement(SessionSelectionContext.Provider, { value: () => 'parent' }, React.createElement(WritingPanel, { workspaceId: 'ws', ...props }))));
  await act(async () => vi.waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull()));
}
it('saves to the selected directory and sends overwrite consent only after confirmation', async () => {
  const saved = [], onSaved = vi.fn(), original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options) => {
    if (!url.endsWith('/save')) return original(url, options);
    const input = JSON.parse(options.body); saved.push(input);
    return input.expectedVersion ? { ok: true, status: 200, json: async () => ({ path: 'alice/2026-10-23-orders/requirement.md' }) }
      : { ok: false, status: 409, json: async () => ({ error: 'WRITING_FILE_EXISTS', details: { version: 'existing-version', filename: 'requirement.md' } }) };
  });
  localStorage.setItem(writingDraftKey('ws', 'alice/2026-10-23-orders'), JSON.stringify({ requirement: before }));
  await render({ requirement: { id: '2026-10-23-orders', path: 'alice/2026-10-23-orders' }, onSaved });
  expect(button('下载 Markdown')).toBeUndefined(); await click(button('保存'));
  expect(document.querySelector('[role=dialog]').textContent).toContain('requirement.md');
  expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ workspaceId: 'ws', requirementPath: 'alice/2026-10-23-orders', content: before, docType: 'requirement' });
  const modalButton = text => [...document.querySelectorAll('[role=dialog] button')].find(node => node.textContent === text);
  await click(modalButton('否')); expect(onSaved).not.toHaveBeenCalled(); expect(saved).toHaveLength(1);
  await click(button('保存')); await click(modalButton('是'));
  expect(saved.at(-1).expectedVersion).toBe('existing-version'); expect(onSaved).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role=dialog]')).toBeNull();
});
it('keeps the draft editable with visible status while cancellation waits for the child', async () => {
  let cancelled = false, finished = false;
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options) => {
    if (url.includes('/jobs/')) {
      if (url.endsWith('/cancel')) cancelled = true;
      return { ok: true, json: async () => ({ status: finished ? 'cancelled' : cancelled ? 'cancelling' : 'running' }) };
    }
    return original(url, options);
  });
  await render(); await click(button('优化')); await click(button('取消'));
  expect(button('取消中').disabled).toBe(true);
  expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');
  expect(container.textContent).toContain('等待任务收尾');
  finished = true;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');
});
it('keeps the composer compact, preserves multiline instructions and hides it during execution', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options) => url.includes('/jobs/') ? { ok: true, json: async () => ({ status: 'running', activity: { stage: 'reading' } }) } : original(url, options));
  await render();
  let input = container.querySelector('textarea');
  expect(input.rows).toBe(1);
  await click(button('展开输入'));
  expect(input.rows).toBe(4);
  const instruction = '第一行\n第二行';
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, instruction);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button('收起输入'));
  expect(input.rows).toBe(1); expect(input.value).toBe(instruction);
  await click(button('优化'));
  expect(requests.at(-1).instruction).toBe(instruction);
  expect(container.querySelector('textarea')).toBeNull();
  expect(button('取消')).toBeDefined();
  await click(button('优化要求'));
  input = container.querySelector('textarea');
  expect(input.rows).toBe(4); expect(input.value).toBe(instruction); expect(input.disabled).toBe(true);
  await click(button('收起输入')); expect(container.querySelector('textarea')).toBeNull();
  expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');
});
it('preserves unchanged bytes and combines independent accept and reject decisions', () => {
  const parts = writingChanges('first\r\nold\r\nmiddle\r\nlast\r\n', 'first\r\nnew\r\nmiddle\r\nend\r\n');
  const changes = parts.filter(p => p.text === undefined); expect(changes).toHaveLength(2);
  changes[0].decision = 'accept'; changes[1].decision = 'reject';
  expect(mergedWriting(parts)).toBe('first\r\nnew\r\nmiddle\r\nlast\r\n');
});
it('identifies the changed reference on terminal validation failure', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options) => url.includes('/jobs/') ? { ok: true, json: async () => ({ status: 'failed', error: 'ENHANCEMENT_INPUT_CHANGED', errorDetails: { workspaceTitle: '跨工作区库', sources: [{ relativePath: 'alice/orders.md', status: 'stale' }] } }) } : original(url, options));
  await render(); await click(button('优化'));
  const alert = [...container.querySelectorAll('[role=alert]')].find(node => node.textContent.includes('AI 运行期间'));
  expect(alert).toBeDefined();
  expect(alert.textContent).toContain('跨工作区库 · alice/orders.md');
  expect(alert.textContent).not.toContain('检查所选版本、范围或服务状态');
  expect(button('优化').disabled).toBe(false);
});
it('explains invalid knowledge before AI starts and reports skipped references during a task', async () => {
  const original = fetchMock.getMockImplementation(); let rejected = true;
  fetchMock.mockImplementation(async (url, options) => {
    if (url.endsWith('/optimize') && rejected) return { ok: false, status: 409, json: async () => ({ error: 'WRITING_KNOWLEDGE_STALE', details: { workspaceTitle: '跨工作区库', sources: [{ relativePath: 'alice/orders.md' }] } }) };
    if (url.includes('/jobs/')) return { ok: true, json: async () => ({ status: 'running', excludedSourceCount: 2 }) };
    return original(url, options);
  });
  await render(); await click(button('优化'));
  const alert = [...container.querySelectorAll('[role=alert]')].find(node => node.textContent.includes('尚未启动 AI'));
  expect(alert).toBeDefined(); expect(alert.textContent).toContain('alice/orders.md');
  rejected = false; await click(button('优化'));
  expect(container.textContent).toContain('已排除 2 份失效资料');
});
it('selects global knowledge, reviews individual diffs and sends merged text into the next optimization', async () => {
  await render();
  await click(container.querySelector('input[type="checkbox"]'));
  expect(button('开始起稿').disabled).toBe(true);
  await click(button('优化'));
  expect(requests[0]).toMatchObject({ scopeIds: ['scope'], sessionId: 'parent', content: before, docType: 'requirement' });
  expect(container.textContent).toContain('alice/orders.md');
  expect(container.querySelector('[aria-label="差异审阅"]')).not.toBeNull();
  expect(container.querySelector('.ProseMirror')).toBeNull();
  await click(button('采用此项'));
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toBe(before);
  await click([...container.querySelectorAll('button')].filter(node => node.textContent === '保留原文')[1]);
  await act(async () => vi.waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull()));
  expect(container.querySelector('[aria-label="差异审阅"]')).toBeNull();
  expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toBe('# 订单\n\n知识库规则\n\n## 验收\n\n原始验收\n');
  await click(button('优化'));
  expect(requests[1].content).toContain('知识库规则'); expect(requests[1].content).toContain('原始验收');
  await click(button('全部采用'));
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toBe(after);
});
it('keeps the two document types independent and retains drafts on optimization failure', async () => {
  await render();
  await click(container.querySelector('.rh-select-trigger'));
  await click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === '技术方案'));
  expect(container.querySelector('.ProseMirror').textContent).toContain('技术方案草稿');
  fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: '没有可用会话' }) }));
  await click(button('优化'));
  expect(container.textContent).toContain('没有可用会话');
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toBe(before);
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
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toContain('直接编写需求正文');
  expect(document.activeElement).toBe(editable);
  expect(button('优化').disabled).toBe(false);
  expect(button('保存').disabled).toBe(false);
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it('defaults to the current workspace and retains explicit empty and cross-workspace selections', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options) => url.endsWith('/options') ? { ok: true, json: async () => ({ scopes: [
    { id: 'own', workspaceId: 'ws', title: 'Current', entryCount: 2 }, { id: 'scope', workspaceId: 'other', title: 'Other', entryCount: 1 }
  ], starters: {} }) } : original(url, options));
  await render();
  const checkboxes = () => container.querySelectorAll('.rh-writing-scope input');
  expect([...checkboxes()].map(node => node.checked)).toEqual([true, false]);
  await click(checkboxes()[0]);
  expect(JSON.parse(localStorage.getItem('req-hub:writing-scopes:ws'))).toEqual([]);
  await render({ workspaceId: 'other' });
  expect([...checkboxes()].map(node => node.checked)).toEqual([false, true]);
  await render();
  expect([...checkboxes()].map(node => node.checked)).toEqual([false, false]);
  await click(checkboxes()[1]);
  await render({ workspaceId: 'other' }); await render();
  expect([...checkboxes()].map(node => node.checked)).toEqual([false, true]);
  expect(JSON.parse(localStorage.getItem('req-hub:writing-scopes:ws'))).toEqual(['scope']);
});
it('retains pending review decisions on return without changing the draft', async () => {
  await render(); await click(button('优化'));
  await click(button('采用此项')); await click(button('返回'));
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toBe(before);
  await click(button('继续审阅差异'));
  expect(container.querySelector('button[aria-pressed="true"]').textContent).toBe('采用此项');
  expect(button('完成并返回')).toBeUndefined();
  await click(button('全部保留原文'));
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toBe(before);
});

it('does not overwrite edits made while the AI analyzes a frozen draft', async () => {
  let finished = false;
  const original = fetchMock.getMockImplementation(), make = vi.spyOn(Editor, 'make');
  fetchMock.mockImplementation(async (url, options) => url.includes('/jobs/') && !finished ? { ok: true, json: async () => ({ id: 'job-1', status: 'running', createdAt: Date.now(), activity: { stage: 'working' } }) } : original(url, options));
  await act(async () => root.render(React.createElement(DiffReviewProvider, null,
    React.createElement(SessionSelectionContext.Provider, { value: () => 'parent' }, React.createElement(WritingPanel, { workspaceId: 'ws' })))));
  await act(async () => vi.waitFor(() => expect(container.querySelector('.ProseMirror')).not.toBeNull()));
  await click(button('优化'));
  expect(container.textContent).toContain('AI 正在分析');
  expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');
  await act(async () => {
    make.mock.results[0].value.action(ctx => { const view = ctx.get(editorViewCtx); view.dispatch(view.state.tr.insertText('用户的新内容', 1)); });
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  const edited = JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement;
  expect(edited).toContain('用户的新内容');
  finished = true;
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
  await click(button('全部采用'));
  expect(container.querySelector('[aria-label="差异审阅"] [role="alert"]').textContent).toContain('草稿已在分析后修改');
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toBe(edited);
  await click(button('返回')); await click(button('放弃本次建议'));
  expect(container.querySelector('.ProseMirror').textContent).toContain('用户的新内容');
});

it('moves the existing writing controls into the supplied header without duplicates', async () => {
  const header = document.createElement('header'); document.body.append(header);
  await render({ toolbarTarget: header });
  expect([...header.querySelectorAll('button')].some(node => node.textContent === '保存')).toBe(true);
  expect(container.querySelector('.rh-writing-panel button')?.textContent).not.toBe('保存');
  expect([...document.querySelectorAll('button')].filter(node => node.textContent === '保存')).toHaveLength(1);
  await render({ active: false, toolbarTarget: null });
  expect(header.textContent).toBe(''); header.remove();
});

it('leaves the Host job running on page exit and resumes it on return', async () => {
  let restored = false;
  const original = fetchMock.getMockImplementation();
  const running = { id: 'job-1', status: 'running', docType: 'design', workspaceId: 'ws', activity: { stage: 'waiting_model' } };
  fetchMock.mockImplementation(async (url, options) => {
    if (url.includes('/jobs?')) return { ok: true, json: async () => ({ jobs: restored ? [running] : [] }) };
    if (url.includes('/jobs/job-1') && !url.endsWith('/cancel')) return { ok: true, json: async () => running };
    return original(url, options);
  });
  await render(); await click(button('优化'));
  await act(async () => root.render(null));
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false);
  restored = true; await render();
  expect(button('优化')).toBeUndefined();
  expect(button('优化要求')).toBeDefined();
  expect(container.querySelector('textarea[aria-label="优化要求"]')).toBeNull();
  expect(container.querySelector('.ProseMirror').textContent).toContain('技术方案草稿');
  expect(requests).toHaveLength(1);
  await click(button('取消'));
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/cancel'))).toHaveLength(1);
});
it('recovers a result finished while absent and does not reopen an already merged result', async () => {
  const original = fetchMock.getMockImplementation();
  const completed = { id: 'background', status: 'completed', docType: 'design', workspaceId: 'ws', result: { original: '# 技术方案草稿', content: '# 优化后的方案', evidence: [] } };
  fetchMock.mockImplementation(async (url, options) => url.includes('/jobs?') ? { ok: true, json: async () => ({ jobs: [completed] }) } : url.endsWith('/jobs/background') ? { ok: true, json: async () => completed } : original(url, options));
  await render();
  expect(button('继续审阅差异')).toBeDefined();
  expect(container.querySelector('.ProseMirror').textContent).toContain('技术方案草稿');
  await click(button('继续审阅差异')); await click(button('全部采用'));
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).design).toBe('# 优化后的方案');
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws'))).requirement).toBe(before);
  await act(async () => root.render(null)); await render();
  expect(button('继续审阅差异')).toBeUndefined(); expect(requests).toHaveLength(0);
});

it('isolates drafts and pending AI results by requirement while keeping workspace knowledge choices', async () => {
  const first = { id: '2026-10-29-first', path: 'alice/2026-10-29-first' };
  const second = { id: '2026-10-29-second', path: 'alice/2026-10-29-second' };
  localStorage.setItem(writingDraftKey('ws', first.path), JSON.stringify({ requirement: '# First draft', design: '# First design' }));
  const original = fetchMock.getMockImplementation(); let currentJob;
  fetchMock.mockImplementation(async (url, options) => {
    if (url.includes('/jobs?')) {
      const params = new URL(url, 'http://local').searchParams;
      return { ok: true, json: async () => ({ jobs: currentJob?.requirementPath === params.get('requirementPath') ? [currentJob] : [] }) };
    }
    if (url.endsWith('/optimize')) {
      const input = JSON.parse(options.body); requests.push(input);
      currentJob = { id: 'first-job', status: 'running', docType: 'requirement', requirementPath: input.requirementPath, workspaceId: 'ws' };
      return { ok: true, json: async () => currentJob };
    }
    if (url.endsWith('/jobs/first-job')) return { ok: true, json: async () => currentJob };
    return original(url, options);
  });
  await render({ requirement: first });
  await click(container.querySelector('.rh-writing-scope input'));
  await click(button('优化'));
  expect(requests[0].requirementPath).toBe(first.path);
  await render({ requirement: second });
  expect(container.querySelector('.ProseMirror').textContent).not.toContain('First');
  expect(container.querySelector('.rh-writing-scope input').checked).toBe(true);
  expect(button('开始起稿').disabled).toBe(false);
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/cancel'))).toBe(false);
  currentJob = { ...currentJob, status: 'completed', result: { original: '# First draft', content: '# Improved first', evidence: [] } };
  await render({ requirement: first });
  expect(container.querySelector('.ProseMirror').textContent).toContain('First draft');
  await click(button('继续审阅差异')); await click(button('全部采用'));
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws', first.path))).requirement).toBe('# Improved first');
  await render({ requirement: second });
  expect(button('继续审阅差异')).toBeUndefined();
  expect(container.querySelector('.ProseMirror').textContent).not.toContain('first');
  await click(button('开始起稿'));
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws', first.path))).design).toBe('# First design');
});
it('does not reuse an unscoped old workspace draft for a new requirement or another project path', async () => {
  localStorage.setItem('req-hub:writing:ws', JSON.stringify({ requirement: '# Old workspace-wide text' }));
  const requirement = { id: '2026-10-29-new', path: 'alice/2026-10-29-new' };
  await render({ requirement });
  expect(container.querySelector('.ProseMirror').textContent).not.toContain('Old');
  await click(button('开始起稿'));
  await render({ requirement, docsDir: 'other-docs' });
  expect(container.querySelector('.ProseMirror').textContent).not.toContain('Old');
  expect(writingDraftKey('ws', requirement.path)).not.toBe(writingDraftKey('ws', requirement.path, 'other-docs'));
  expect(localStorage.getItem('req-hub:writing:ws')).toContain('Old workspace-wide text');
});

it('externalizes embedded pictures before optimizing and renders scoped file URLs', async () => {
  const requirement = { id: '2026-10-29-images', path: 'alice/2026-10-29-images' };
  const raw = '# Draft\n\n![shot](data:image/png;base64,aGVsbG8=)';
  const filename = 'a'.repeat(64) + '.png', linked = '# Draft\n\n![shot](assets/images/' + filename + ')';
  localStorage.setItem(writingDraftKey('ws', requirement.path), JSON.stringify({ requirement: raw }));
  const original = fetchMock.getMockImplementation();
  const uploads = [];
  fetchMock.mockImplementation(async (url, options) => {
    if (url.endsWith('/assets')) { uploads.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ content: linked, images: ['assets/images/' + filename] }) }; }
    return original(url, options);
  });
  await render({ requirement });
  expect(button('优化').disabled).toBe(true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  expect(uploads[0]).toMatchObject({ workspaceId: 'ws', requirementPath: requirement.path, content: raw });
  expect(JSON.parse(localStorage.getItem(writingDraftKey('ws', requirement.path))).requirement).toBe(linked);
  const image = container.querySelector('.ProseMirror img[src]');
  expect(image.getAttribute('src')).toContain('/writing/assets/' + filename);
  expect(new URL(image.src).searchParams.get('requirementPath')).toBe(requirement.path);
  await click(button('优化')); expect(requests[0].content).toBe(linked); expect(requests[0].content).not.toContain('base64');
});
