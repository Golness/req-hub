// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const {
  knowledgeV2Request,
  knowledgeV2ErrorText,
  useKnowledgeJobs,
} = require('../../src/client/hooks/useKnowledgeV2.js');
const { FileKnowledgeAction } = require('../../src/client/components/FileKnowledgeAction.js');
const {
  KnowledgeWorkspace,
} = require('../../src/client/components/knowledge/KnowledgeWorkspace.js');
const { ImportFilesModal } = require('../../src/client/components/knowledge/ImportFilesModal.js');
const { KnowledgeSettings } = require('../../src/client/components/knowledge/KnowledgeSettings.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Route knowledge-v2 fetch calls through a handler keyed by API path and method.
 * A handler may return { __error, status, error } to simulate a Host failure.
 */
function mockApi(handler) {
  const fetch = vi.fn(async (url, init) => {
    const parsed = new URL(String(url), 'http://localhost');
    const path = parsed.pathname.replace(/^\/req-hub\/knowledge-v2/, '');
    const method = init?.method || 'GET';
    const result = await handler(path, method, parsed, init);
    if (result && result.__error) {
      return {
        ok: false,
        status: result.status || 400,
        json: async () => ({ error: result.error }),
      };
    }
    return { ok: true, json: async () => result };
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function render(node) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

const buttonByText = (text) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === text);

function setTextarea(element, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function setInputValue(element, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

it('knowledgeV2Request builds a scoped read URL and parses JSON', async () => {
  const fetch = mockApi(async (path, method, url) => {
    expect(method).toBe('GET');
    expect(path).toBe('/pages');
    expect(url.searchParams.get('workspaceId')).toBe('ws');
    return { pages: [] };
  });
  const data = await knowledgeV2Request('/pages', 'ws', null);
  expect(data).toEqual({ pages: [] });
  expect(fetch.mock.calls[0][0]).toBe('/req-hub/knowledge-v2/pages?workspaceId=ws');
});

it('knowledgeV2Request keeps existing query parameters on reads', async () => {
  mockApi(async (path, method, url) => {
    expect(url.searchParams.get('workspaceId')).toBe('ws');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('50');
    return { items: [], total: 0 };
  });
  await knowledgeV2Request('/sources?offset=0&limit=50', 'ws', null);
});

it('knowledgeV2Request POSTs a JSON body merged with the workspace id', async () => {
  mockApi(async (path, method, url, init) => {
    expect(method).toBe('POST');
    expect(path).toBe('/jobs');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ kind: 'ingest', sourceIds: ['s1'], workspaceId: 'ws' });
    return { job: { id: 'j1' } };
  });
  const data = await knowledgeV2Request('/jobs', 'ws', { kind: 'ingest', sourceIds: ['s1'] });
  expect(data.job.id).toBe('j1');
});

it('knowledgeV2Request rejects with the Host code, details and retryable flag', async () => {
  mockApi(async () => ({
    __error: true,
    status: 409,
    error: { code: 'KB_CONFLICT', details: { sourceId: 's1' }, retryable: false },
  }));
  await expect(knowledgeV2Request('/jobs', 'ws', {})).rejects.toMatchObject({
    code: 'KB_CONFLICT',
    details: { sourceId: 's1' },
    retryable: false,
  });
});

it('knowledgeV2ErrorText localizes known codes and keeps unknown codes visible', () => {
  expect(knowledgeV2ErrorText({ code: 'KB_WORKSPACE_INVALID' })).toBe(
    '工作区无效，请重新选择工作区。',
  );
  expect(knowledgeV2ErrorText({ code: 'SOMETHING_NEW' })).toContain('SOMETHING_NEW');
  expect(knowledgeV2ErrorText(null)).toContain('UNKNOWN');
});

let latestJobs;
function JobsProbe({ workspaceId, active }) {
  latestJobs = useKnowledgeJobs(workspaceId, active);
  return null;
}

it('useKnowledgeJobs loads jobs and derives running and activeCount', async () => {
  mockApi(async (path) =>
    path === '/jobs'
      ? {
          jobs: [
            { id: 'a', status: 'running' },
            { id: 'b', status: 'completed' },
          ],
        }
      : {},
  );
  await render(React.createElement(JobsProbe, { workspaceId: 'ws', active: true }));
  expect(latestJobs.jobs).toHaveLength(2);
  expect(latestJobs.running).toBe(true);
  expect(latestJobs.activeCount).toBe(1);
});

it('useKnowledgeJobs stays idle while the surface is hidden', async () => {
  const fetch = mockApi(async () => ({ jobs: [] }));
  await render(React.createElement(JobsProbe, { workspaceId: 'ws', active: false }));
  expect(fetch).not.toHaveBeenCalled();
  expect(latestJobs.jobs).toEqual([]);
});

it('useKnowledgeJobs cancels a job then refreshes the list', async () => {
  const fetch = mockApi(async (path, method) => {
    if (path === '/jobs' && method === 'GET') {
      return { jobs: [{ id: 'a', status: 'running' }] };
    }
    if (path === '/jobs/a/cancel' && method === 'POST') {
      return { job: { id: 'a', status: 'cancelling' } };
    }
    return {};
  });
  await render(React.createElement(JobsProbe, { workspaceId: 'ws', active: true }));
  await act(async () => {
    await latestJobs.cancel('a');
  });
  expect(
    fetch.mock.calls.some(
      ([url, init]) => String(url).includes('/jobs/a/cancel') && init?.method === 'POST',
    ),
  ).toBe(true);
});

it('useKnowledgeJobs polls while a job is active and stops once terminal', async () => {
  vi.useFakeTimers();
  let calls = 0;
  mockApi(async (path) => {
    if (path === '/jobs') {
      calls += 1;
      return { jobs: [{ id: 'a', status: calls < 2 ? 'running' : 'completed' }] };
    }
    return {};
  });
  await render(React.createElement(JobsProbe, { workspaceId: 'ws', active: true }));
  expect(calls).toBe(1);
  await act(async () => {
    vi.advanceTimersByTime(1500);
  });
  expect(calls).toBe(2);
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  expect(calls).toBe(2);
});

const ACTION_PATH = 'alice/2026-10-23-orders/rules.md';

function actionApi(state, overrides = {}) {
  return mockApi(async (path, method, url, init) => {
    if (path === '/jobs') {
      return { jobs: [] };
    }
    if (path === '/source-state') {
      expect(url.searchParams.get('path')).toBe(ACTION_PATH);
      return state;
    }
    if (overrides[path]) {
      return overrides[path](method, url, init);
    }
    return {};
  });
}

const renderAction = (props = {}) =>
  render(
    React.createElement(FileKnowledgeAction, { workspaceId: 'ws', path: ACTION_PATH, ...props }),
  );

it('FileKnowledgeAction imports a missing source and posts the saved file', async () => {
  const fetch = actionApi(
    { state: 'missing' },
    {
      '/sources/files': (method, url, init) => {
        expect(method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.files).toEqual([{ relativePath: ACTION_PATH }]);
        expect(body.ingest).toBe(true);
        return { results: [{ status: 'saved' }], job: { id: 'j1' } };
      },
    },
  );
  await renderAction();
  const button = buttonByText('加入知识库');
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(
    fetch.mock.calls.some(
      ([url, init]) => String(url).includes('/sources/files') && init?.method === 'POST',
    ),
  ).toBe(true);
});

it('FileKnowledgeAction queues a Wiki update for a saved source', async () => {
  const fetch = actionApi(
    { state: 'saved', sourceId: 's1' },
    {
      '/jobs': (method, url, init) => {
        if (method === 'POST') {
          expect(JSON.parse(init.body)).toMatchObject({ kind: 'ingest', sourceIds: ['s1'] });
          return { job: { id: 'j2' } };
        }
        return { jobs: [] };
      },
    },
  );
  await renderAction();
  const button = buttonByText('更新 Wiki');
  await act(async () => button.click());
  expect(
    fetch.mock.calls.some(
      ([url, init]) => String(url).endsWith('/jobs') && init?.method === 'POST',
    ),
  ).toBe(true);
});

it('FileKnowledgeAction offers re-import for a stale source', async () => {
  actionApi({ state: 'stale', sourceId: 's1' });
  await renderAction();
  expect(buttonByText('更新知识库资料')).toBeTruthy();
});

it('FileKnowledgeAction shows a compiled status instead of an action', async () => {
  actionApi({ state: 'compiled', sourceId: 's1' });
  await renderAction();
  const status = container.querySelector('[role="status"]');
  expect(status.textContent).toBe('已编译');
  expect(buttonByText('加入知识库')).toBeUndefined();
});

it('FileKnowledgeAction shows an active compile without a conflicting action', async () => {
  actionApi({ state: 'compiling', sourceId: 's1', jobId: 'j1' });
  await renderAction();
  expect(container.querySelector('[role="status"]').textContent).toBe('编译中');
  expect(buttonByText('更新 Wiki')).toBeUndefined();
  expect(buttonByText('重试编译')).toBeUndefined();
});

it('FileKnowledgeAction exposes the failure reason and retries compilation', async () => {
  const fetch = actionApi(
    {
      state: 'failed',
      sourceId: 's1',
      jobId: 'j1',
      error: { code: 'KB_INTERNAL', details: {}, retryable: true },
    },
    {
      '/jobs': (method, url, init) => {
        if (method === 'POST') {
          expect(JSON.parse(init.body)).toMatchObject({ kind: 'ingest', sourceIds: ['s1'] });
          return { id: 'j2', status: 'queued' };
        }
        return { jobs: [] };
      },
    },
  );
  await renderAction();
  const status = container.querySelector('[role="status"]');
  expect(status.textContent).toBe('编译失败');
  expect(status.title).toBe('知识库内部错误，请重试。');
  const retry = buttonByText('重试编译');
  expect(retry.disabled).toBe(false);
  await act(async () => retry.click());
  expect(
    fetch.mock.calls.some(
      ([url, init]) => String(url).endsWith('/jobs') && init?.method === 'POST',
    ),
  ).toBe(true);
});

it('FileKnowledgeAction blocks ingest while the document is dirty', async () => {
  actionApi({ state: 'missing' });
  await renderAction({ dirty: true });
  const button = buttonByText('加入知识库');
  expect(button.disabled).toBe(true);
  expect(button.title).toBe('请先保存文档，再入库。');
});

it('FileKnowledgeAction surfaces a retry control when the state request fails', async () => {
  mockApi(async (path) => {
    if (path === '/jobs') {
      return { jobs: [] };
    }
    if (path === '/source-state') {
      return { __error: true, status: 500, error: { code: 'KB_INTERNAL' } };
    }
    return {};
  });
  await renderAction();
  expect(buttonByText('重试入库状态')).toBeTruthy();
});

function workspaceApi() {
  return mockApi(async (path) => {
    if (path === '/jobs') {
      return { jobs: [] };
    }
    if (path === '/pages') {
      return { generationId: null, pages: [], publishedAt: null };
    }
    if (path.startsWith('/sources')) {
      return { items: [], total: 0 };
    }
    if (path === '/settings') {
      return {
        values: {
          autoManage: false,
          autoManageDelayMs: 30000,
          dailyUpdateEnabled: false,
          dailyImportConversations: false,
          dailyUpdateTime: '02:00',
          larkPushEnabled: false,
        },
        version: 'settings-v1',
        schedule: { state: 'idle', lastRunAt: null },
      };
    }
    if (path === '/rules') {
      return { purpose: '', schema: '', language: 'auto' };
    }
    return {};
  });
}

let changeTab;
function WorkspaceHarness({ initial = 'wiki' }) {
  const [tab, setTab] = React.useState(initial);
  changeTab = setTab;
  return React.createElement(KnowledgeWorkspace, {
    workspaceId: 'ws',
    tab,
    onTabChange: setTab,
    active: true,
  });
}

it('KnowledgeWorkspace renders the four v2 tabs and an empty Wiki', async () => {
  workspaceApi();
  await render(React.createElement(WorkspaceHarness));
  const tablist = container.querySelector('[role="tablist"][aria-label="知识库功能"]');
  expect([...tablist.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
    'Wiki',
    '资料',
    '问答',
    '检查',
  ]);
  expect(container.textContent).toContain('Wiki 尚未生成');
});

it('KnowledgeWorkspace keeps a visited query panel mounted across tab switches', async () => {
  workspaceApi();
  await render(React.createElement(WorkspaceHarness));
  await act(async () => changeTab('query'));
  const textarea = container.querySelector('textarea');
  await act(async () => setTextarea(textarea, '订单状态有哪些？'));
  expect(textarea.value).toBe('订单状态有哪些？');
  await act(async () => changeTab('wiki'));
  // The query pane stays mounted (hidden) so its draft survives the switch.
  const hiddenTextarea = container.querySelector('textarea');
  expect(hiddenTextarea).not.toBeNull();
  expect(hiddenTextarea.value).toBe('订单状态有哪些？');
  await act(async () => changeTab('query'));
  expect(container.querySelector('textarea').value).toBe('订单状态有哪些？');
});

it('KnowledgeWorkspace leaves settings to the settings feature and falls back to Wiki', async () => {
  workspaceApi();
  await render(React.createElement(WorkspaceHarness));
  expect(container.querySelector('button[aria-label="设置"]')).toBeNull();
  expect(container.textContent).not.toContain('用途说明');
  expect(container.textContent).not.toContain('清空知识库');
  await act(async () => changeTab('settings'));
  expect(container.querySelector('[role="tab"][aria-selected="true"]').textContent).toBe('Wiki');
});

it('KnowledgeSettings saves synchronization settings with their expected version', async () => {
  const fetch = workspaceApi();
  await render(React.createElement(KnowledgeSettings, { workspaceId: 'ws' }));
  const autoManage = [...container.querySelectorAll('input[type="checkbox"]')].find(
    (node) => node.parentElement.textContent === '保存后自动整理',
  );
  expect(autoManage).toBeTruthy();
  await act(async () => autoManage.click());
  await act(async () => buttonByText('保存').click());
  const call = fetch.mock.calls.find(
    ([url, init]) => String(url).includes('/knowledge-v2/settings') && init?.method === 'POST',
  );
  expect(call).toBeTruthy();
  const body = JSON.parse(call[1].body);
  expect(body.workspaceId).toBe('ws');
  expect(body.expectedVersion).toBe('settings-v1');
  expect(body.values.autoManage).toBe(true);
  expect(Object.keys(body.values).sort()).toEqual([
    'autoManage',
    'autoManageDelayMs',
    'dailyImportConversations',
    'dailyUpdateEnabled',
    'dailyUpdateTime',
    'larkPushEnabled',
  ]);
});

it('KnowledgeSettings exposes the scheduled Lark push toggle with help text', async () => {
  const fetch = workspaceApi();
  await render(React.createElement(KnowledgeSettings, { workspaceId: 'ws' }));
  const push = [...container.querySelectorAll('input[type="checkbox"]')].find((node) =>
    node.parentElement.textContent.includes('推送飞书'),
  );
  expect(push).toBeTruthy();
  expect(push.checked).toBe(false);
  expect(container.textContent).toContain('每日更新产出的 Wiki 页面会推送到工作区绑定的飞书目录');
  await act(async () => push.click());
  await act(async () => buttonByText('保存').click());
  const call = fetch.mock.calls.find(
    ([url, init]) => String(url).includes('/knowledge-v2/settings') && init?.method === 'POST',
  );
  expect(JSON.parse(call[1].body).values.larkPushEnabled).toBe(true);
});

it('KnowledgeWorkspace opens the tasks drawer from the header', async () => {
  workspaceApi();
  await render(React.createElement(WorkspaceHarness));
  await act(async () => buttonByText('任务').click());
  // The drawer is a Modal rendered through a portal on document.body.
  expect(document.body.textContent).toContain('知识库任务');
  expect(document.body.textContent).toContain('暂无任务');
});

it('ImportFilesModal lists candidates, blocks imported files, and posts the selection', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => 'test-request-key' });
  const fetch = mockApi(async (path, method) => {
    if (path === '/sources/files/candidates') {
      return {
        items: [
          { relativePath: 'alice/a.md', state: 'new' },
          { relativePath: 'alice/b.md', state: 'imported' },
        ],
        total: 2,
        truncated: false,
        batchLimit: 100,
      };
    }
    if (path === '/sources/files' && method === 'POST') {
      return {
        results: [{ relativePath: 'alice/a.md', status: 'saved' }],
        saved: 1,
        skipped: 0,
        failed: 0,
      };
    }
    return {};
  });
  await render(
    React.createElement(ImportFilesModal, {
      open: true,
      workspaceId: 'ws',
      docsDir: 'docs',
      onClose: () => {},
      onImported: () => {},
      onOpenTasks: () => {},
    }),
  );
  const dialog = document.querySelector('[data-rh-modal]');
  expect(dialog.textContent).toContain('alice/a.md');
  expect(dialog.textContent).toContain('未导入');
  expect(dialog.textContent).toContain('已导入');
  expect(dialog.querySelector('input[aria-label="alice/b.md"]').disabled).toBe(true);

  const selectAll = [...dialog.querySelectorAll('button')].find(
    (node) => node.textContent === '全选当前可导入项',
  );
  await act(async () => selectAll.click());
  expect(dialog.querySelector('input[aria-label="alice/a.md"]').checked).toBe(true);

  const submit = [...dialog.querySelectorAll('button')].find((node) => node.textContent === '导入');
  await act(async () => submit.click());
  const call = fetch.mock.calls.find(
    ([url, init]) =>
      String(url) === '/req-hub/knowledge-v2/sources/files' && init?.method === 'POST',
  );
  expect(call).toBeTruthy();
  const body = JSON.parse(call[1].body);
  expect(body.files).toEqual([{ relativePath: 'alice/a.md' }]);
  expect(body.workspaceId).toBe('ws');
  expect(body.ingest).toBe(true);
  expect(dialog.querySelector('input[aria-label="alice/a.md"]').disabled).toBe(true);
});

it('ImportFilesModal shows the search root and filters only after submitting the search', async () => {
  mockApi(async (path) => {
    if (path === '/sources/files/candidates') {
      return {
        items: [
          { relativePath: 'alice/a.md', state: 'new' },
          { relativePath: 'alice/b.md', state: 'imported' },
          { relativePath: 'bob/c.md', state: 'new' },
          { relativePath: 'bob/d.md', state: 'changed' },
        ],
        total: 4,
        truncated: false,
        batchLimit: 100,
        base: { workspace: 'demo-ws', path: 'D:/repo/demo/docs' },
      };
    }
    return {};
  });
  await render(
    React.createElement(ImportFilesModal, {
      open: true,
      workspaceId: 'ws',
      docsDir: 'docs',
      onClose: () => {},
      onImported: () => {},
      onOpenTasks: () => {},
    }),
  );
  const dialog = document.querySelector('[data-rh-modal]');
  const buttonByLabel = (label) =>
    [...dialog.querySelectorAll('button')].find((node) => node.textContent === label);
  expect(dialog.textContent).toContain('demo-ws / D:/repo/demo/docs');
  expect(dialog.textContent).not.toContain('从 docs 中选择');
  expect(dialog.textContent).not.toContain('仅显示 .md');
  expect(dialog.textContent).toContain('共 4 个文件 · 可导入 3 个 · 已选 0 个');

  const searchInput = dialog.querySelector('input[aria-label="搜索文件"]');
  await act(async () => setInputValue(searchInput, 'bob'));
  expect(dialog.textContent).toContain('共 4 个文件 · 可导入 3 个 · 已选 0 个');
  expect(dialog.textContent).toContain('alice/a.md');
  expect(dialog.textContent).toContain('bob/c.md');

  await act(async () => buttonByLabel('搜索').click());
  expect(dialog.textContent).toContain('共 2 个文件 · 可导入 2 个 · 已选 0 个');
  expect(dialog.textContent).not.toContain('alice/a.md');
  expect(dialog.textContent).toContain('bob/c.md');

  await act(async () => dialog.querySelector('[aria-label="状态筛选"]').click());
  const imported = document.body.querySelector('button[data-value="imported"]');
  expect(imported).toBeTruthy();
  await act(async () => imported.click());
  expect(dialog.textContent).toContain('共 0 个文件 · 可导入 0 个 · 已选 0 个');
  expect(dialog.textContent).toContain('无匹配文件');

  await act(async () => setInputValue(searchInput, ''));
  await act(async () => buttonByLabel('搜索').click());
  expect(dialog.textContent).toContain('共 1 个文件 · 可导入 0 个 · 已选 0 个');
  expect(dialog.textContent).toContain('alice/b.md');
});

it('ImportFilesModal uses the shared action bar and one toolbar control size', async () => {
  mockApi(async (path) => {
    if (path === '/sources/files/candidates') {
      return {
        items: [{ relativePath: 'alice/a.md', state: 'new' }],
        total: 1,
        truncated: false,
        batchLimit: 100,
        base: { workspace: 'demo-ws', path: 'D:/repo/demo/docs' },
      };
    }
    return {};
  });
  await render(
    React.createElement(ImportFilesModal, {
      open: true,
      workspaceId: 'ws',
      docsDir: 'docs',
      onClose: () => {},
      onImported: () => {},
      onOpenTasks: () => {},
    }),
  );
  const dialog = document.querySelector('[data-rh-modal]');
  const bar = dialog.querySelector('[data-rh-action-bar]');
  expect(bar).toBeTruthy();
  expect(bar.textContent).toContain('导入并整理');
  expect(bar.textContent).toContain('导入');
  expect(dialog.querySelector('[data-rh-paged-inset="true"]')).toBeTruthy();
  const toolbar = dialog.querySelector('form[role="search"]').parentElement;
  const sized = [...toolbar.querySelectorAll('[data-rh-size]')];
  expect(sized.length).toBeGreaterThan(0);
  expect(new Set(sized.map((node) => node.getAttribute('data-rh-size')))).toEqual(new Set(['sm']));
});
