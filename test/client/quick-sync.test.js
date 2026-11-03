// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { SyncPanel } = require('../../src/client/components/SyncPanel.js');
const { DocsViewerContext } = require('../../src/client/context.js');
const { act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const branch = 'feature/dev/2026-11-02-orders';
const requirement = {
  id: '2026-11-02-orders',
  path: 'dev/2026-11-02-orders',
  developer: 'dev',
  title: 'orders',
};
let root, container, exists, posts, terminal, release, fetchMock;
const json = (data, status = 200) => ({
  ok: status < 400,
  status,
  headers: { get: () => 'application/json' },
  json: async () => data,
});
const button = (text) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === text);
const click = async (node) => act(async () => node.click());
const waitForCommits = async () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
async function open() {
  await act(async () =>
    root.render(
      React.createElement(
        DocsViewerContext.Provider,
        { value: { refreshTree: vi.fn() } },
        React.createElement(SyncPanel, { workspaceId: 'ws', onClose: vi.fn() }),
      ),
    ),
  );
}
async function enterBranch(value = branch) {
  const input = container.querySelector('[aria-label="功能分支"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 230));
  });
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (node) => node.textContent === value,
  );
  if (option) {
    await click(option);
  }
}
function stream(docType) {
  let emitted = false;
  return {
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => {
          if (emitted) {
            return { done: true };
          }
          emitted = true;
          await new Promise((resolve) => {
            release = resolve;
          });
          const sync = {
            id: `${terminal === 'completed' ? 'design' : docType}-task`,
            workspaceId: 'ws',
            requirementId: requirement.id,
            docType: terminal === 'completed' ? 'design' : docType,
            docTypeName: terminal === 'completed' ? '技术方案' : '需求文档',
            status: terminal,
            steps: [],
            generatedFiles: [],
          };
          return {
            done: false,
            value: new TextEncoder().encode(
              `data: ${JSON.stringify(
                terminal === 'deleted'
                  ? { type: 'deleted' }
                  : {
                      type: 'done',
                      sync,
                      quickSync: { id: 'quick-job', status: terminal, stage: sync.docType },
                    },
              )}\n\n`,
            ),
          };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}
beforeEach(() => {
  exists = true;
  posts = [];
  terminal = 'completed';
  release = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url, options) => {
    if (url.includes('/sync-branches?')) {
      return json({ branches: [branch] });
    }
    if (url.includes('/sync-branch-info')) {
      return json({ targetBranch: branch, baseBranch: 'main' });
    }
    if (url.includes('/tree?')) {
      return json({
        tree: { developers: exists ? [{ name: 'dev', requirements: [requirement] }] : [] },
      });
    }
    if (url.includes('/create-dir')) {
      exists = true;
      return json({ success: true });
    }
    if (url.includes('/sync-commits?')) {
      return json({
        commits: [
          {
            hash: 'a'.repeat(40),
            shortHash: 'aaaaaaaa',
            subject: 'orders',
            author: 'dev',
            date: '2026-11-02',
          },
        ],
        branchTip: 'b'.repeat(40),
        baseline: 'c'.repeat(40),
        hasUncommitted: false,
      });
    }
    if (url.includes('/phased-sync')) {
      const payload = JSON.parse(options.body);
      posts.push(payload);
      return payload.docType === 'requirement' ? stream(payload.docType) : json({ skipped: true });
    }
    return json({ active: false });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  release?.();
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('starts with quick sync and supports keyboard tabs without clearing the branch', async () => {
  await open();
  await enterBranch();
  const tabs = container.querySelectorAll('[role="tab"]');
  expect([...tabs].map((tab) => tab.textContent)).toEqual(['快捷同步', '自定义同步', '同步历史']);
  expect(container.querySelectorAll('button:not([role="tab"])').length).toBeGreaterThan(0);
  expect(
    [...container.querySelectorAll('button:not([role="tab"])')].some(
      (node) => node.textContent.trim() === '同步历史',
    ),
  ).toBe(false);
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  await act(async () =>
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(document.activeElement).toBe(tabs[1]);
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  await act(async () =>
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(document.activeElement).toBe(tabs[2]);
  await act(async () =>
    tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
  );
  expect(document.activeElement).toBe(tabs[1]);
  await click(tabs[0]);
  expect(container.querySelector('[aria-label="功能分支"]').value).toBe(branch);
});
it.each([true, false])(
  'reuses or creates the directory (exists=%s), submits one Host-owned sequence',
  async (initialExists) => {
    exists = initialExists;
    await open();
    await enterBranch();
    await click(button('开始快捷同步'));
    await waitForCommits();
    expect(posts.map((post) => post.docType)).toEqual(['requirement']);
    expect(posts[0]).toMatchObject({
      targetBranch: branch,
      sessionIds: [],
      sessionVersions: {},
      quick: true,
      baseBranch: 'main',
      includeWorkingChanges: false,
    });
    expect(fetchMock.mock.calls.some(([url]) => /\/sessions\?|\/conversations\//.test(url))).toBe(
      false,
    );
    const creation = fetchMock.mock.calls.find(([url]) => url.includes('/create-dir'));
    expect(Boolean(creation)).toBe(!initialExists);
    if (creation) {
      expect(JSON.parse(creation[1].body)).toMatchObject({
        developer: 'dev',
        date: '2026-11-02',
        title: 'orders',
        createBranch: false,
      });
    }
    await click(button('同步历史'));
    expect(container.querySelector('#sync-tab-history').getAttribute('aria-selected')).toBe('true');
    const historyCall = fetchMock.mock.calls.find(([url]) => url.includes('/sync-history?'));
    expect(new URL(historyCall[0], 'http://localhost').searchParams.get('requirementId')).toBe(
      requirement.id,
    );
    await click(button('自定义同步'));
    await click(button('快捷同步'));
    await act(async () => release());
    expect(posts.map((post) => post.docType)).toEqual(['requirement']);
    expect(posts).toHaveLength(1);
  },
);
it.each(['failed', 'aborted', 'deleted'])(
  'does not submit another request when the Host sequence is %s',
  async (status) => {
    terminal = status;
    await open();
    await enterBranch();
    await click(button('开始快捷同步'));
    await waitForCommits();
    await act(async () => release());
    expect(posts.map((post) => post.docType)).toEqual(['requirement']);
  },
);
it('does not submit another request after the panel unmounts', async () => {
  await open();
  await enterBranch();
  await click(button('开始快捷同步'));
  await waitForCommits();
  await act(async () => root.render(null));
  await act(async () => release());
  expect(posts).toHaveLength(1);
});
it('does not submit a second request when the Host reports the sequence already synced', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((url, options) =>
    url.includes('/phased-sync')
      ? (posts.push(JSON.parse(options.body)), json({ skipped: true }))
      : original(url, options),
  );
  await open();
  await enterBranch();
  await click(button('开始快捷同步'));
  await waitForCommits();
  expect(posts.map((post) => post.docType)).toEqual(['requirement']);
});
it('preserves input and shows creation failures without starting sync', async () => {
  exists = false;
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((url, options) =>
    url.includes('/create-dir') ? json({ error: 'CREATE_DENIED' }, 403) : original(url, options),
  );
  await open();
  await enterBranch();
  await click(button('开始快捷同步'));
  expect(container.querySelector('[role="alert"]').textContent).toBe('CREATE_DENIED');
  expect(container.querySelector('[aria-label="功能分支"]').value).toBe(branch);
  expect(posts).toEqual([]);
});

it.each([
  [
    { targetBranch: null, targetBranchError: 'SYNC_BRANCH_INVALID', baseBranch: 'main' },
    '当前工作区',
  ],
  [{ targetBranch: branch, baseBranch: null }, '没有本地 main 或 master'],
])(
  'validates branch and conventional base before creating any directory',
  async (info, message) => {
    exists = false;
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url, options) =>
      url.includes('/sync-branch-info') ? json(info) : original(url, options),
    );
    await open();
    await enterBranch();
    await click(button('开始快捷同步'));
    expect(container.querySelector('[role="alert"]').textContent).toContain(message);
    expect(
      fetchMock.mock.calls.some(([url]) => /\/tree\?|\/create-dir|\/phased-sync/.test(url)),
    ).toBe(false);
  },
);

function interruptedResponse() {
  let sent = false;
  return {
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) {
            throw new Error('NETWORK_DISCONNECTED');
          }
          sent = true;
          return {
            done: false,
            value: new TextEncoder().encode(
              'data: {"type":"sync_started","syncId":"requirement-task","quickSync":{"id":"quick-job","status":"running"}}\n\n',
            ),
          };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

function recoverTask(status) {
  return {
    id: 'requirement-task',
    workspaceId: 'ws',
    requirementId: requirement.id,
    docType: 'requirement',
    status,
    steps: [],
    generatedFiles: [],
  };
}

it('observes completion after disconnect without submitting another document', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((url, options) => {
    if (url.includes('/sync-detail?') || url.includes('/quick-sync-status?')) {
      return json({
        sync: recoverTask('completed'),
        quickSync: { id: 'quick-job', status: 'completed' },
      });
    }
    if (url.includes('/phased-sync') && JSON.parse(options.body).docType === 'requirement') {
      posts.push(JSON.parse(options.body));
      return interruptedResponse();
    }
    return original(url, options);
  });
  await open();
  await enterBranch();
  await click(button('开始快捷同步'));
  await waitForCommits();
  expect(posts.map((post) => post.docType)).toEqual(['requirement']);
});

it.each(['completed', 'failed', 'aborted', 'deleted'])(
  'observes the same Host sequence after disconnect and handles %s',
  async (status) => {
    let outcome = 'running';
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url, options) => {
      if (url.includes('/sync-detail?') || url.includes('/quick-sync-status?')) {
        expect(url).toContain('id=quick-job');
        return outcome === 'deleted'
          ? json({}, 404)
          : json({ sync: recoverTask(outcome), quickSync: { id: 'quick-job', status: outcome } });
      }
      if (url.includes('/phased-sync') && JSON.parse(options.body).docType === 'requirement') {
        posts.push(JSON.parse(options.body));
        return interruptedResponse();
      }
      return original(url, options);
    });
    await open();
    await enterBranch();
    await click(button('开始快捷同步'));
    await waitForCommits();
    expect(posts.map((post) => post.docType)).toEqual(['requirement']);
    outcome = status;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    expect(posts.map((post) => post.docType)).toEqual(
      status === 'completed' ? ['requirement'] : ['requirement'],
    );
  },
);

it('stops recovered observation on unmount without submitting another request', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((url, options) => {
    if (url.includes('/sync-detail?') || url.includes('/quick-sync-status?')) {
      return json({
        sync: recoverTask('running'),
        quickSync: { id: 'quick-job', status: 'running' },
      });
    }
    if (url.includes('/phased-sync') && JSON.parse(options.body).docType === 'requirement') {
      posts.push(JSON.parse(options.body));
      return interruptedResponse();
    }
    return original(url, options);
  });
  await open();
  await enterBranch();
  await click(button('开始快捷同步'));
  await waitForCommits();
  await act(async () => root.render(null));
  const observations = fetchMock.mock.calls.filter(
    ([url]) => url.includes('/sync-detail?') || url.includes('/quick-sync-status?'),
  ).length;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  expect(
    fetchMock.mock.calls.filter(
      ([url]) => url.includes('/sync-detail?') || url.includes('/quick-sync-status?'),
    ),
  ).toHaveLength(observations);
  expect(posts.map((post) => post.docType)).toEqual(['requirement']);
});

it('opens history details in the history tab and returns to its list', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options) =>
    url.includes('/sync-history?')
      ? json({ history: [{ ...recoverTask('completed'), docTypeName: '需求文档', startedAt: 1 }] })
      : original(url, options),
  );
  await act(async () =>
    root.render(
      React.createElement(
        DocsViewerContext.Provider,
        { value: { refreshTree: vi.fn() } },
        React.createElement(SyncPanel, {
          workspaceId: 'ws',
          selectedReq: requirement,
          onClose: vi.fn(),
        }),
      ),
    ),
  );
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/sync-history?'))).toBe(false);
  await click(button('同步历史'));
  const panel = container.querySelector('#sync-content-history');
  await click(panel.querySelector('[data-sync-record] button'));
  expect(container.querySelector('#sync-tab-history').getAttribute('aria-selected')).toBe('true');
  expect(button('返回')).toBeTruthy();
  await click(button('返回'));
  expect(panel.querySelector('[data-sync-record] button')).not.toBeNull();
  expect(button('返回')).toBeUndefined();
});

it('does not allow typed branch text to start sync before a suggestion is selected', async () => {
  await open();
  const field = container.querySelector('[aria-label="功能分支"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      field,
      branch,
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 230));
  });
  expect(button('开始快捷同步').disabled).toBe(true);
  expect(posts).toEqual([]);
  await act(async () =>
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(button('开始快捷同步').disabled).toBe(false);
  expect(posts).toEqual([]);
});
