// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  React = require('react'),
  { act } = React;
const { createRoot } = require('react-dom/client');
const { DocsViewerBody } = require('../../src/client/components/DocsViewerBody.js');
const { FileKnowledgeAction } = require('../../src/client/components/FileKnowledgeAction.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const req = { id: '2026-10-22-orders', path: 'alice/2026-10-22-orders', title: 'Orders' };
const file = req.path + '/notes.txt';
beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const response = (data) => ({ ok: true, json: async () => data });
function api() {
  let indexed = false,
    job = null,
    text = 'Original document';
  const fetch = vi.fn(async (url, init) => {
    const parsed = new URL(String(url), 'http://localhost'),
      path = parsed.pathname;
    if (path.endsWith('/knowledge/wiki/events')) return response({ items: [] });
    if (path.endsWith('/tree'))
      return response({ tree: { developers: [{ name: 'alice', requirements: [req] }] } });
    if (path.endsWith('/file-tree'))
      return response({ tree: [{ type: 'file', path: 'notes.txt', name: 'notes.txt' }] });
    if (path.endsWith('/read')) return response({ text });
    if (path.endsWith('/write')) {
      text = JSON.parse(init.body).content;
      return response({ success: true });
    }
    if (path.endsWith('/source'))
      return response({ indexed, status: indexed ? 'active' : 'not_imported' });
    if (path.endsWith('/status'))
      return response({
        ready: indexed,
        entryCount: +indexed,
        sourceCount: +indexed,
        documentCount: +indexed,
        latestJobId: job?.id,
      });
    if (path.endsWith('/builds')) {
      const body = JSON.parse(init.body);
      indexed = true;
      job = {
        id: 'job-1',
        status: 'completed',
        updatedAt: 'one',
        counts: { completed: body.files.length },
        files: body.files.map((file) => ({ ...file, status: 'completed' })),
      };
      return response(job);
    }
    if (path.includes('/builds/')) return response(job);
    if (path.endsWith('/entries'))
      return response({
        entries: [
          { id: 'doc', title: 'Imported document', version: 1, body: 'Document body', sources: [] },
          {
            id: 'chat',
            title: 'Imported chat',
            conversation: { title: 'Imported chat', turns: [] },
            body: 'Chat body',
            sources: [],
          },
        ],
      });
    if (path.endsWith('-options'))
      return response({ workspace: { id: 'ws', title: 'Workspace', path: '/repo' }, sessions: [] });
    if (path.endsWith('/codex/sessions')) return response({ workspace: null, sessions: [] });
    if (path.endsWith('/sessions')) return response({ sessions: [] });
    return response({});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const click = async (node) => act(async () => node.click());
const tab = (label) =>
  [...container.querySelectorAll('[role="tab"], nav[aria-label="知识库功能"] button')].find(
    (node) => node.textContent === label,
  );
async function selectTab(label) {
  if (!tab(label)) await click(tab('来源'));
  await click(tab(label));
}
const button = (text) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === text);
async function open() {
  await act(async () =>
    root.render(
      React.createElement(DocsViewerBody, {
        workspace: { id: 'ws', title: 'Workspace' },
        docsDir: 'docs',
        workspaces: [],
        initialReqId: req.id,
        onConfigChange() {},
        onSelectWorkspace() {},
      }),
    ),
  );
  await click(
    [...container.querySelectorAll('.rh-rail-btn')].find((node) => node.textContent === '知识库'),
  );
}
it.each(['main', 'master'])(
  'clears the old requirement and opens creation when locating %s',
  async (branch) => {
    const fallback = api();
    const fetch = vi.fn(async (url, init) => {
      const path = new URL(String(url), 'http://localhost').pathname;
      if (path.endsWith('/session-info')) return response({ session: { cwd: '/repo' } });
      if (path.endsWith('/git-branch')) return response({ branch });
      if (path.endsWith('/create-status'))
        return response({ branch, canUpdateMain: true, existingRequirement: null });
      return fallback(url, init);
    });
    vi.stubGlobal('fetch', fetch);
    window.__DSH_CTX__ = {
      get: (name) =>
        name === 'uiWorkspace'
          ? { selection: { getSnapshot: () => ({ sessionId: 'session' }) } }
          : null,
    };
    try {
      const workspace = { id: 'ws', title: 'Workspace', path: '/repo' };
      await act(async () =>
        root.render(
          React.createElement(DocsViewerBody, {
            workspace,
            docsDir: 'docs',
            workspaces: [workspace],
            initialReqId: req.id,
            onConfigChange() {},
            onSelectWorkspace() {},
          }),
        ),
      );
      expect(container.querySelector('.rh-topbar').textContent).toContain('Orders');
      await click(container.querySelector('button[aria-label="定位到当前会话需求"]'));
      expect(container.querySelector('.rh-topbar').textContent).not.toContain('Orders');
      expect(container.querySelector('.rh-open-directory')).toBeNull();
      expect(container.textContent).toContain('创建需求目录');
      expect(container.querySelector('.rh-file-tree-sidebar')).toBeNull();
      const writes = fetch.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/config') && init?.method === 'POST',
      );
      expect(writes.map(([, init]) => JSON.parse(init.body))).toContainEqual({
        workspaceId: 'ws',
        developerName: null,
        requirementId: null,
      });
      expect(fetch.mock.calls.some(([url]) => /create-dir|delete/.test(String(url)))).toBe(false);
    } finally {
      delete window.__DSH_CTX__;
    }
  },
);
it('keeps creation visibly unavailable and explains it in a modal without leaving the current panel', async () => {
  const fallback = api();
  let existing = true;
  const fetch = vi.fn(async (url, init) =>
    String(url).includes('/create-status')
      ? response({ branch: 'feature/alice/' + req.id, existingRequirement: existing ? req : null })
      : fallback(url, init),
  );
  vi.stubGlobal('fetch', fetch);
  await open();
  const create = () =>
    [...container.querySelectorAll('.rh-rail-btn')].find((node) => node.textContent === '新建');
  expect(create().getAttribute('aria-disabled')).toBe('true');
  await click(create());
  expect(document.querySelector('[role="dialog"]').textContent).toContain('请先更换工作区');
  expect(document.querySelector('[role="dialog"]').textContent).toContain(req.path);
  expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  expect(container.querySelector('input[name="developer"]')).toBeNull();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  existing = false;
  await click(create());
  expect(create().getAttribute('aria-disabled')).toBeNull();
  expect(container.textContent).toContain('创建需求目录');
});
it('exposes document viewing directly and keeps source workflows accessible', async () => {
  api();
  await open();
  expect([...container.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
    '查看文档',
    'Wiki',
    '来源',
    '待审阅',
    '维护',
  ]);
  expect(tab('Wiki').getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('.rh-file-tree-sidebar')).toBeNull();
  await click(tab('查看文档'));
  expect(tab('查看文档').getAttribute('aria-selected')).toBe('true');
  expect(tab('来源').getAttribute('aria-selected')).toBe('false');
  expect(container.querySelector('#knowledge-content').getAttribute('aria-labelledby')).toBe('knowledge-tab-documents');
  expect(container.querySelector('nav[aria-label="知识库功能"]')).toBeNull();
  await click(container.querySelector('.rh-tree-file'));
  expect(container.querySelector('.rh-breadcrumb').textContent).toContain('notes.txt');
  expect(container.querySelector('#knowledge-content').textContent).toContain('Original document');
  await selectTab('来源');
  const sourceNavigation = container.querySelector('nav[aria-label="知识库功能"]');
  const primaryStrip = tab('来源').closest('[role="tablist"]').parentElement;
  expect(primaryStrip.nextElementSibling).toBe(sourceNavigation);
  expect([...sourceNavigation.querySelectorAll('button')].map(node => node.textContent)).toEqual([
    '文档入库', '会话入库', '索引', '搜索',
  ]);
  expect(sourceNavigation.nextElementSibling.contains(container.querySelector('#knowledge-file-tree'))).toBe(true);
  expect(container.querySelector('.rh-right-header')).toBeNull();
  expect(container.querySelector('.rh-right-panel nav[aria-label="知识库功能"]')).toBeNull();
  expect(container.querySelector('.rh-knowledge-selection')).not.toBeNull();
  expect(container.querySelector('.rh-result-card').textContent).toContain('Imported document');
  expect(container.querySelector('.rh-knowledge-results').textContent).not.toContain(
    'Imported chat',
  );
  await selectTab('会话入库');
  expect(container.querySelector('nav[aria-label="知识库功能"]')).toBe(sourceNavigation);
  expect(tab('来源').getAttribute('aria-selected')).toBe('true');
  expect(container.querySelector('.rh-file-tree-sidebar')).toBeNull();
  expect(button('刷新会话')).toBeTruthy();
  await selectTab('搜索');
  expect(tab('搜索').getAttribute('aria-current')).toBe('page');
  await selectTab('查看文档');
  expect(container.querySelector('.rh-file-tree-sidebar')).not.toBeNull();
  await act(async () =>
    tab('来源').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(tab('待审阅').getAttribute('aria-selected')).toBe('true');
});
it('ingests an unindexed viewed document next to its breadcrumb and hides the action once indexed', async () => {
  const fetch = api();
  await open();
  await selectTab('查看文档');
  await click(container.querySelector('.rh-tree-file'));
  expect(container.querySelector('.rh-breadcrumb').textContent).toContain('notes.txt');
  expect(container.querySelector('.rh-breadcrumb').parentElement.contains(button('入库'))).toBe(true);
  expect(container.querySelector('.rh-edit-toolbar-header')).not.toBeNull();
  await click(button('入库'));
  const call = fetch.mock.calls.find(
    ([url, init]) => String(url).endsWith('/builds') && init?.method === 'POST',
  );
  expect(JSON.parse(call[1].body)).toMatchObject({
    workspaceId: 'ws',
    files: [{ relativePath: file }],
  });
  expect(button('入库')).toBeUndefined();
  expect(container.querySelector('.rh-breadcrumb').parentElement.textContent).toContain('已入库');
});
it('always exposes the file tree switch in both document tabs and shares it with Ctrl+T', async () => {
  api();
  await open();
  for (const name of ['查看文档', '文档入库']) {
    await selectTab(name);
    const toggle = () => container.querySelector('button[aria-controls="knowledge-file-tree"]');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await click(toggle());
    expect(toggle().getAttribute('aria-label')).toBe('展开文件树');
    expect(toggle().classList.contains('rh-file-tree-toggle')).toBe(true);
    expect(toggle().querySelector('svg')).toBeTruthy();
    expect(container.querySelector('#knowledge-file-tree').classList.contains('collapsed')).toBe(
      true,
    );
    await click(toggle());
    expect(container.querySelector('.rh-tree-file')).toBeTruthy();
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }),
      ),
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    await click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  }
  await selectTab('搜索');
  expect(container.querySelector('button[aria-controls="knowledge-file-tree"]')).toBeNull();
});
it('preserves a source-edit draft across tabs, prevents ingesting unsaved text, and retains batch selections', async () => {
  const fetch = api();
  await open();
  await selectTab('文档入库');
  await click(container.querySelector('input[aria-label="选择文件 notes.txt"]'));
  await click(container.querySelector('.rh-tree-file'));
  expect(tab('查看文档').getAttribute('aria-selected')).toBe('true');
  await click(container.querySelector('[title="编辑文件"]') || button('编辑'));
  const editor = container.querySelector('textarea.rh-text-editor');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
      editor,
      'Draft text',
    );
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('入库').disabled).toBe(true);
  expect(button('入库').title).toContain('先保存');
  await selectTab('Wiki');
  await selectTab('查看文档');
  expect(container.querySelector('textarea.rh-text-editor').value).toBe('Draft text');
  await selectTab('文档入库');
  expect(container.querySelector('input[aria-label="选择文件 notes.txt"]').checked).toBe(true);
  await act(async () =>
    container
      .querySelector('.rh-file-tree-sidebar input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })),
  );
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/write'))).toBe(false);
  await selectTab('查看文档');
  expect(container.querySelector('textarea.rh-text-editor').value).toBe('Draft text');
  await click(container.querySelector('[title="保存文件 (Ctrl+S)"]'));
  expect(
    JSON.parse(fetch.mock.calls.find(([url]) => String(url).endsWith('/write'))[1].body).content,
  ).toBe('Draft text');
  expect(button('入库').disabled).toBe(false);
});
it('looks up and builds a foreign source in its own workspace rather than the visible workspace', async () => {
  const fetch = api();
  await act(async () =>
    root.render(
      React.createElement(FileKnowledgeAction, {
        workspaceId: 'other',
        path: file,
        onChanged() {},
      }),
    ),
  );
  await click(button('入库'));
  const get = fetch.mock.calls.find(([url]) => String(url).includes('/source?'));
  expect(String(get[0])).toContain('workspaceId=other');
  const post = fetch.mock.calls.find(
    ([url, init]) => String(url).endsWith('/builds') && init?.method === 'POST',
  );
  expect(JSON.parse(post[1].body).workspaceId).toBe('other');
});

it('places close, secondary navigation and batch ingest in their owning rows', async () => {
  api();
  await open();
  const primaryStrip = tab('Wiki').closest('[role="tablist"]').parentElement;
  const close = primaryStrip.lastElementChild;
  expect(close.tagName).toBe('BUTTON');
  expect(close.textContent).toBe('关闭');
  expect(container.querySelector('.rh-right-header')).toBeNull();
  await click(tab('来源'));
  const selection = container.querySelector('.rh-knowledge-selection');
  const summary = selection.querySelector('[role="status"]').parentElement;
  const ingest = [...summary.querySelectorAll('button')].find(node => node.textContent.startsWith('入库'));
  expect(ingest.disabled).toBe(true);
  expect(summary.lastElementChild).toBe(ingest);
  await click(container.querySelector('input[aria-label="选择文件 notes.txt"]'));
  expect(ingest.disabled).toBe(false);
  expect(ingest.textContent).toContain('1');
  expect(container.querySelector('.rh-right-panel').contains(ingest)).toBe(false);
  await click(tab('维护'));
  const maintenance = container.querySelector('nav[aria-label="知识库功能"]');
  expect(primaryStrip.nextElementSibling).toBe(maintenance);
  expect(maintenance.querySelectorAll('button')).toHaveLength(5);
  expect(maintenance.textContent).toContain('Wiki 运行事件');
  expect(container.querySelector('.rh-right-panel nav[aria-label="知识库功能"]')).toBeNull();
  for (const button of maintenance.querySelectorAll('button')) {
    await click(button);
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('.rh-right-header')).toBeNull();
  }
  await click(close);
  expect(container.querySelector('#knowledge-tab-documents')).toBeNull();
});

it('refreshes the open creation page when locating again after a branch change', async () => {
  const fallback = api();
  let branch = 'test';
  let selection = 'session';
  const fetch = vi.fn(async (url, init) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    if (path.endsWith('/session-info')) return response({ session: { cwd: '/repo' } });
    if (path.endsWith('/git-branch')) return response({ branch });
    if (path.endsWith('/create-status')) return response({ branch, canUpdateMain: branch === 'main', existingRequirement: null });
    return fallback(url, init);
  });
  vi.stubGlobal('fetch', fetch);
  window.__DSH_CTX__ = { get: name => name === 'uiWorkspace'
    ? { selection: { getSnapshot: () => ({ sessionId: selection }) } } : null };
  try {
    const workspace = { id: 'ws', title: 'Workspace', path: '/repo' };
    await act(async () => root.render(React.createElement(DocsViewerBody, {
      workspace, workspaces: [workspace], docsDir: 'docs', onConfigChange() {}, onSelectWorkspace() {},
    })));
    const locate = container.querySelector('button[aria-label="定位到当前会话需求"]');
    await click(locate);
    expect([...container.querySelectorAll('code')].some(node => node.textContent === 'test')).toBe(true);
    branch = 'main';
    selection = 'new-session';
    await click(locate);
    expect([...container.querySelectorAll('code')].some(node => node.textContent === 'main')).toBe(true);
    expect([...container.querySelectorAll('code')].some(node => node.textContent === 'test')).toBe(false);
    const calls = fetch.mock.calls.filter(([url]) => /\/(session-info|git-branch|create-status)\?/.test(String(url)));
    expect(calls.every(([, init]) => init.cache === 'no-store')).toBe(true);
    expect(calls.filter(([url]) => String(url).includes('/git-branch?'))).toHaveLength(2);
    expect(calls.filter(([url]) => String(url).includes('/session-info?')).at(-1)[0]).toContain('new-session');
  } finally {
    delete window.__DSH_CTX__;
  }
});
it('ignores a superseded branch response after another locate click', async () => {
  const fallback = api();
  let resolveOld;
  let oldSignal;
  let branchReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    if (path.endsWith('/session-info')) return response({ session: { cwd: '/repo' } });
    if (path.endsWith('/git-branch')) {
      if (branchReads++ === 0) {
        oldSignal = init.signal;
        return new Promise(resolve => { resolveOld = resolve; });
      }
      return response({ branch: 'main' });
    }
    if (path.endsWith('/create-status')) return response({ branch: 'main', canUpdateMain: true });
    return fallback(url, init);
  }));
  window.__DSH_CTX__ = { get: name => name === 'uiWorkspace'
    ? { selection: { getSnapshot: () => ({ sessionId: 'session' }) } } : null };
  try {
    const workspace = { id: 'ws', title: 'Workspace', path: '/repo' };
    await act(async () => root.render(React.createElement(DocsViewerBody, {
      workspace, workspaces: [workspace], docsDir: 'docs', onConfigChange() {}, onSelectWorkspace() {},
    })));
    const locate = container.querySelector('button[aria-label="定位到当前会话需求"]');
    await click(locate);
    await click(locate);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld(response({ branch: 'test' })));
    expect([...container.querySelectorAll('code')].some(node => node.textContent === 'main')).toBe(true);
    expect([...container.querySelectorAll('code')].some(node => node.textContent === 'test')).toBe(false);
  } finally {
    delete window.__DSH_CTX__;
  }
});

it.each([false, true])('does not locate an unrelated workspace or fallback session (selected=%s)', async selected => {
  const fallback = api();
  const fetch = vi.fn(async (url, init) => {
    if (String(url).includes('/session-info?')) return response({ session: { cwd: '/other/repo' } });
    return fallback(url, init);
  });
  vi.stubGlobal('fetch', fetch);
  window.__DSH_CTX__ = { get: name => name === 'uiWorkspace'
    ? { selection: { getSnapshot: () => ({ sessionId: selected ? 'session' : undefined }) } }
    : { list: { getSnapshot: () => ({ ids: ['old-session'] }) } } };
  try {
    const workspace = { id: 'ws', path: 'repo', title: 'Workspace' };
    await act(async () => root.render(React.createElement(DocsViewerBody, {
      workspace, workspaces: [workspace], docsDir: 'docs', onConfigChange() {}, onSelectWorkspace() {},
    })));
    await click(container.querySelector('button[aria-label="定位到当前会话需求"]'));
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/git-branch?'))).toBe(false);
    if (!selected) {
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/session-info?'))).toBe(false);
    }
  } finally {
    delete window.__DSH_CTX__;
  }
});

it('keeps document tools in the knowledge sidebar and preserves editing through its drawer', async () => {
  let panelWidth = 1000;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: panelWidth, height: 600, top: 0, left: 0, bottom: 600, right: panelWidth }));
  api();
  await open();
  await selectTab('查看文档');
  await click(container.querySelector('.rh-tree-file'));
  const sidebar = container.querySelector('aside[aria-label="知识助手"]');
  expect(sidebar).not.toBeNull();
  expect(container.querySelector('.rh-preview-body').contains(sidebar)).toBe(false);
  expect(sidebar.parentElement.classList.contains('rh-file-preview-content')).toBe(true);
  expect(container.textContent).not.toContain('高级关联操作');
  await click([...sidebar.querySelectorAll('button')].find(node => node.textContent === '收起'));
  expect(container.querySelector('aside[aria-label="知识助手"]')).toBeNull();
  await click(container.querySelector('[title="编辑文件"]') || button('编辑'));
  const editor = container.querySelector('textarea.rh-text-editor');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(editor, 'Unsaved document');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
  panelWidth = 600;
  await act(async () => window.dispatchEvent(new Event('resize')));
  const trigger = button('知识助手');
  trigger.focus();
  await click(trigger);
  expect(document.querySelector('[role="dialog"][aria-label="知识助手"]')).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(container.querySelector('textarea.rh-text-editor')).toBe(editor);
  expect(editor.value).toBe('Unsaved document');
});
