// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { WikiEvents } = require('../../src/client/components/WikiEvents.js');
const { WikiSaveStatus } = require('../../src/client/components/WikiSaveStatus.js');
const { LogPanel } = require('../../src/client/components/LogPanel.js');
const { WikiUpdateAction } = require('../../src/client/components/WikiUpdateAction.js');
const { SessionSelectionContext } = require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, fetch;
const response = (value) => ({ ok: true, json: async () => value });
const event = (sequence, stage = 'running') => ({
  sequence,
  stage,
  job_id: 'task',
  level: 'info',
  created_at: '2026-11-02T01:00:00Z',
  detail: { jobId: 'task', index: sequence },
});
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetch = vi.fn(async () => response({ items: [] }));
  vi.stubGlobal('fetch', fetch);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (Component, props) =>
  act(async () => {
    root.render(
      React.createElement(
        SessionSelectionContext.Provider,
        { value: () => 'parent' },
        React.createElement(Component, props),
      ),
    );
  });
const click = async (label) =>
  act(async () => {
    [...container.querySelectorAll('button')].find((node) => node.textContent === label).click();
  });
it('catches up across multiple event pages and retains history after refresh errors', async () => {
  let failed = false;
  fetch.mockImplementation(async (url) => {
    const query = new URL(url, 'http://localhost').searchParams;
    if (query.has('before')) {
      return response({ items: [event(1)], hasMore: false });
    }
    if (!query.has('after')) {
      return response({ items: [event(3), event(2)], hasMore: true, nextCursor: 2 });
    }
    if (query.get('after') === '3') {
      return response({ items: [event(4)], hasMore: true, nextCursor: 4 });
    }
    if (query.get('after') === '4') {
      return response({ items: [event(5)], hasMore: false });
    }
    if (!failed) {
      failed = true;
      throw new Error('NETWORK_DOWN');
    }
    return response({ items: [event(6, 'failed')], hasMore: false });
  });
  await render(WikiEvents, { workspaceId: 'ws' });
  await click('加载更早事件');
  expect(container.querySelectorAll('li')).toHaveLength(3);
  await act(async () => vi.advanceTimersByTimeAsync(2100));
  expect(container.querySelectorAll('li')).toHaveLength(5);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.textContent).toContain('NETWORK_DOWN');
  expect(container.querySelectorAll('li')).toHaveLength(5);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.textContent).not.toContain('NETWORK_DOWN');
  expect(container.querySelectorAll('li')).toHaveLength(6);
});
it('filters on the server and aborts event requests when closed', async () => {
  await render(WikiEvents, { workspaceId: 'ws', jobId: 'task' });
  expect(new URL(fetch.mock.calls[0][0], 'http://localhost').searchParams.get('jobId')).toBe(
    'task',
  );
  const signal = fetch.mock.calls[0][1].signal;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  const calls = fetch.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(fetch).toHaveBeenCalledTimes(calls);
});
it('shows failed Wiki processing independently from saved documents and links to events', async () => {
  const open = vi.fn();
  fetch.mockResolvedValueOnce(response({ processingStatus: 'running' }));
  fetch.mockResolvedValueOnce(
    response({
      processingStatus: 'failed',
      error: {
        code: 'WIKI_EXECUTION_FAILED',
      },
    }),
  );
  await render(WikiSaveStatus, {
    workspaceId: 'ws',
    receipt: { state: 'saved', documentId: 'doc', processingStatus: 'queued' },
    onOpenEvents: open,
  });
  expect(container.textContent).toContain('文档已保存 · Wiki：处理中');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.textContent).toContain('文档已保存 · Wiki：失败');
  expect(container.textContent).toContain('WIKI_EXECUTION_FAILED');
  await click('查看 Wiki 运行事件');
  expect(open).toHaveBeenCalledOnce();
  const count = fetch.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(fetch).toHaveBeenCalledTimes(count);
});
it('exposes persisted Wiki history in a separate log view', async () => {
  await render(LogPanel, { workspaceId: 'ws' });
  expect(container.querySelector('[role="tablist"][aria-label="日志分类"]')).not.toBeNull();
  expect(container.querySelector('#log-tab-application').className).toBe('rh-workbench-tab');
  await click('Wiki 运行事件');
  expect(container.querySelector('#log-tab-wiki').getAttribute('aria-selected')).toBe('true');
  expect(fetch.mock.calls.some(([url]) => url.includes('/knowledge/wiki/events?'))).toBe(true);
  expect(container.querySelector('section[aria-label="Wiki 运行事件"]')).not.toBeNull();
});

it('shows a primary update action with the pending count and starts only on click', async () => {
  const changed = vi.fn();
  const open = vi.fn();
  let requested = false;
  fetch.mockImplementation(async (_url, options) => {
    if (options?.method === 'POST') {
      requested = true;
      return response({ pendingCount: 3, queuedCount: 3, running: true });
    }
    return response({ pendingCount: requested ? 1 : 3, queuedCount: 0, running: false });
  });
  await render(WikiUpdateAction, { workspaceId: 'ws', onUpdated: changed, onOpenEvents: open });
  expect(container.textContent).toContain('3 篇文档待更新');
  expect(fetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  const update = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '更新 Wiki（3）',
  );
  expect(update.disabled).toBe(false);
  await click('更新 Wiki（3）');
  expect(container.textContent).toContain('正在更新 Wiki…');
  expect(
    [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '正在更新 Wiki…',
    ).disabled,
  ).toBe(true);
  const post = fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(JSON.parse(post[1].body)).toEqual({ workspaceId: 'ws' });
  expect(post[1].headers['x-session-id']).toBe('parent');
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(container.textContent).toContain('1 篇文档待更新');
  expect(changed).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  await click('查看 Wiki 运行事件');
  expect(open).toHaveBeenCalledOnce();
});
it('retains pending counts on status failures and aborts reads when the update bar closes', async () => {
  fetch.mockResolvedValueOnce(response({ pendingCount: 2, queuedCount: 0, running: false }));
  fetch.mockRejectedValueOnce(new Error('NETWORK_DOWN'));
  await render(WikiUpdateAction, { workspaceId: 'ws' });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(container.textContent).toContain('2 篇文档待更新');
  expect(container.textContent).toContain('NETWORK_DOWN');
  const signal = fetch.mock.calls[0][1].signal;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  const count = fetch.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(fetch).toHaveBeenCalledTimes(count);
});
it('does not poll or start generation for a saved source awaiting a manual update', async () => {
  fetch.mockResolvedValue(response({ processingStatus: 'needs_update' }));
  await render(WikiSaveStatus, {
    workspaceId: 'ws',
    receipt: {
      documentId: 'source',
      processingStatus: 'needs_update',
      state: 'saved',
    },
  });
  expect(container.textContent).toContain('待更新（尚未调用模型）');
  const count = fetch.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(fetch).toHaveBeenCalledTimes(count);
});
