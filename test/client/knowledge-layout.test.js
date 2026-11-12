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
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => 'test-request-key' };
  }
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const response = (data) => ({ ok: true, json: async () => data });

/** Mock the Host routes used by the file viewer and the knowledge-v2 workspace. */
function api() {
  let text = 'Original document';
  let sourceState = 'missing';
  const fetch = vi.fn(async (url, init) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    if (path.startsWith('/req-hub/knowledge-v2')) {
      const tail = path.slice('/req-hub/knowledge-v2'.length);
      if (tail === '/pages') return response({ pages: [], sources: [], generationId: null });
      if (tail === '/jobs') return response({ jobs: [] });
      if (tail.startsWith('/sources?')) return response({ items: [], total: 0 });
      if (tail === '/sources/sessions') return response({ sources: [], adapters: [] });
      if (tail.startsWith('/source-state')) {
        return response({ state: sourceState, sourceId: sourceState === 'missing' ? null : 'src-1' });
      }
      if (tail === '/sources/files' && init?.method === 'POST') {
        sourceState = 'saved';
        return response({ results: [{ status: 'saved', sourceId: 'src-1' }], job: { id: 'job-1' } });
      }
      if (tail === '/rules') return response({ purpose: '', schema: '', language: 'zh' });
      if (tail === '/settings') {
        return response({ values: {}, version: 'v1', schedule: { state: 'idle' } });
      }
      if (tail === '/lint') return response({ findings: [] });
      if (tail === '/query') return response({ answer: '', citations: [] });
      return response({});
    }
    if (path.endsWith('/tree'))
      return response({ tree: { developers: [{ name: 'alice', requirements: [req] }] } });
    if (path.endsWith('/file-tree'))
      return response({ tree: [{ type: 'file', path: 'notes.txt', name: 'notes.txt' }] });
    if (path.endsWith('/read')) return response({ text });
    if (path.endsWith('/write')) {
      text = JSON.parse(init.body).content;
      return response({ success: true });
    }
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
const button = (text) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === text);
const rail = (label) =>
  [...container.querySelectorAll('.rh-rail-btn')].find((node) =>
    [...node.querySelectorAll('.rh-rail-label')].some((span) => span.textContent === label),
  );
async function renderBody(overrides = {}) {
  await act(async () =>
    root.render(
      React.createElement(DocsViewerBody, {
        workspace: { id: 'ws', title: 'Workspace' },
        docsDir: 'docs',
        workspaces: [],
        initialReqId: req.id,
        onConfigChange() {},
        onSelectWorkspace() {},
        ...overrides,
      }),
    ),
  );
}
const flush = () => act(async () => {});

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
  await renderBody();
  const create = () => rail('新建');
  expect(create().getAttribute('aria-disabled')).toBe('true');
  await click(create());
  expect(document.querySelector('[role="dialog"]').textContent).toContain('请先更换工作区');
  expect(document.querySelector('[role="dialog"]').textContent).toContain(req.path);
  expect(rail('文件')).toBeTruthy();
  expect(rail('知识库')).toBeTruthy();
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

it('keeps file viewing and the knowledge workspace as independent rail entries', async () => {
  api();
  await renderBody();
  const files = rail('文件');
  const knowledge = rail('知识库');
  expect(files).toBeTruthy();
  expect(knowledge).toBeTruthy();
  await click(knowledge);
  const tabs = container.querySelector('[role="tablist"][aria-label="知识库功能"]');
  expect(tabs).not.toBeNull();
  expect([...tabs.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
    'Wiki',
    '资料',
    '问答',
    '检查',
  ]);
  expect(container.querySelector('#files-tree')).toBeNull();
  await click(files);
  expect(container.querySelector('#files-tree')).not.toBeNull();
  expect(container.querySelector('.rh-tree-file')).toBeTruthy();
  await click(container.querySelector('.rh-tree-file'));
  expect(container.querySelector('.rh-breadcrumb').textContent).toContain('notes.txt');
  await flush();
  expect(container.textContent).toContain('Original document');
  expect(button('加入知识库')).toBeTruthy();
  expect(container.querySelector('[role="tablist"][aria-label="知识库功能"]')).not.toBeNull();
});

it('imports the viewed text file through the knowledge-v2 API', async () => {
  const fetch = api();
  await renderBody();
  await click(rail('文件'));
  await click(container.querySelector('.rh-tree-file'));
  await flush();
  await click(button('加入知识库'));
  await flush();
  const post = fetch.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/req-hub/knowledge-v2/sources/files') && init?.method === 'POST',
  );
  expect(post).toBeTruthy();
  expect(JSON.parse(post[1].body)).toMatchObject({
    workspaceId: 'ws',
    files: [{ relativePath: file }],
    ingest: true,
  });
});

it('scopes the file knowledge action to its owning workspace rather than the visible one', async () => {
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
  await flush();
  const stateCall = fetch.mock.calls.find(([url]) => String(url).includes('/source-state?'));
  expect(stateCall).toBeTruthy();
  expect(new URL(String(stateCall[0]), 'http://localhost').searchParams.get('workspaceId')).toBe(
    'other',
  );
  await click(button('加入知识库'));
  await flush();
  const post = fetch.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/req-hub/knowledge-v2/sources/files') && init?.method === 'POST',
  );
  expect(JSON.parse(post[1].body).workspaceId).toBe('other');
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
