// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { TaskReportsPanel } = require('../../src/client/components/TaskReportsPanel.js');
const { SyncScheduleSettings } = require('../../src/client/components/SyncScheduleSettings.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const response = (data, ok = true) => ({ ok, json: async () => data });
const button = (text) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
const click = (node) => act(async () => node.click());
const mount = (element) => act(async () => root.render(element));
it('shows workspace groups and DSH/Codex labels with source, history and artifact navigation', async () => {
  const task = { id: 'sync', docType: 'design', status: 'completed' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const query = new URL(String(url), 'http://localhost').searchParams;
      if (!query.has('id'))
        return response({
          items: [
            {
              id: query.get('kind'),
              day: '2026-11-04',
              status: 'completed',
              startedAt: '2026-11-04T03:00:00Z',
            },
          ],
        });
      return response({
        id: query.get('id'),
        day: '2026-11-04',
        status: 'completed',
        workspaces: [
          {
            id: 'ws',
            title: 'Workspace',
            items:
              query.get('id') === 'knowledge'
                ? [
                    {
                      key: 'one',
                      kind: 'session',
                      title: 'DSH session',
                      source: 'dsh',
                      documentId: 'dsh-doc',
                      status: 'published',
                    },
                    {
                      key: 'two',
                      kind: 'session',
                      title: 'Codex session',
                      source: 'codex',
                      documentId: 'codex-doc',
                      status: 'published',
                    },
                  ]
                : [
                    {
                      key: 'branch',
                      branch: 'feature/alice/2026-11-03-topic',
                      status: 'completed',
                      tasks: [task],
                    },
                  ],
          },
        ],
      });
    }),
  );
  const onNavigate = vi.fn();
  await mount(React.createElement(TaskReportsPanel, { onNavigate }));
  await click(button('报告详情'));
  expect(container.textContent).toContain('Workspace');
  expect([...container.querySelectorAll('.badge')].map((node) => node.textContent)).toEqual([
    'DSH',
    'Codex',
  ]);
  await click(
    [...container.querySelectorAll('button')].filter((node) => node.textContent === '来源')[1],
  );
  expect(onNavigate).toHaveBeenLastCalledWith({
    kind: 'knowledge',
    workspaceId: 'ws',
    documentId: 'codex-doc',
  });
  const tabs = container.querySelectorAll('[role="tab"]');
  await act(async () =>
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tabs[1]);
  await click(button('报告详情'));
  await click(
    [...container.querySelectorAll('button')].find((node) => node.textContent.includes('历史')),
  );
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'sync', workspaceId: 'ws', task });
  await click(button('产物'));
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'document', workspaceId: 'ws', task });
});
it('shows a localized reason for a skipped workspace without an error alert', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const query = new URL(String(url), 'http://localhost').searchParams;
      if (!query.has('id')) {
        return response({
          items: [
            {
              id: 'sync',
              day: '2026-11-14',
              status: 'completed',
              startedAt: '2026-11-14T00:00:00Z',
            },
          ],
        });
      }
      return response({
        id: 'sync',
        day: '2026-11-14',
        status: 'completed',
        workspaces: [
          {
            id: 'blank',
            title: 'blank',
            items: [
              {
                key: 'workspace',
                kind: 'workspace',
                status: 'skipped',
                reason: 'SYNC_WORKSPACE_NOT_REPOSITORY',
              },
            ],
          },
        ],
      });
    }),
  );
  await mount(React.createElement(TaskReportsPanel, {}));
  await click(button('报告详情'));
  expect(container.textContent).toContain('该工作区不是 Git 仓库');
  expect(container.textContent).not.toContain('SYNC_WORKSPACE_NOT_REPOSITORY');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('retains report data and displays a refresh error', async () => {
  const fetch = vi.fn(async () =>
    response({ items: [{ id: 'run', day: '2026-11-04', status: 'completed' }] }),
  );
  vi.stubGlobal('fetch', fetch);
  await mount(React.createElement(TaskReportsPanel, {}));
  fetch.mockResolvedValueOnce(response({ error: 'REPORT_FAILED' }, false));
  await click(button('刷新'));
  expect(container.textContent).toContain('2026-11-04');
  expect(container.querySelector('[role="alert"]').textContent).toBe('REPORT_FAILED');
});
it('saves the T-x schedule without writing the shared username', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const fetch = vi.fn(async () =>
    response({ defaultUsername: 'alice', sync: { baseBranch: 'main', dailyOffsetDays: 1 } }),
  );
  vi.stubGlobal('fetch', fetch);
  await mount(React.createElement(SyncScheduleSettings));
  await click(container.querySelector('[role="switch"]'));
  const offset = container.querySelector('input[type="number"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      offset,
      '2',
    );
    offset.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button('保存'));
  const body = JSON.parse(
    fetch.mock.calls.find(([, options]) => options?.method === 'POST')[1].body,
  );
  expect(body).toEqual({
    sync: {
      dailyUpdateEnabled: true,
      dailyUpdateTime: '03:00',
      dailyOffsetDays: 2,
      larkPushEnabled: false,
    },
  });
  const notice = container.querySelector('[role="status"]');
  expect(notice.textContent).toBe('已保存');
  expect(notice.parentElement).toBe(button('保存').parentElement);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(notice.textContent).toBe('');
});

it('keeps schedule settings compact and exposes details through accessible help icons', async () => {
  const fetch = vi.fn(async () => response({ defaultUsername: 'alice', sync: {} }));
  vi.stubGlobal('fetch', fetch);
  await mount(React.createElement(SyncScheduleSettings));
  const toggle = container.querySelector('[role="switch"]');
  const hour = container.querySelector('[aria-label="小时"]');
  const minute = container.querySelector('[aria-label="分钟"]');
  const zone = container.querySelector('[aria-label="时区"]');
  expect(toggle.textContent).toContain('已关闭');
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(hour.disabled).toBe(true);
  expect(zone).toBeNull();
  expect(container.textContent).toContain('在「设置 → 通用」中统一修改');
  expect(container.querySelector('input[type="number"]').disabled).toBe(true);
  expect(container.textContent).not.toContain('星号代表需求名称');
  expect(container.textContent).not.toContain('将如何同步');
  const help = container.querySelector('[aria-label="提前天数说明"]');
  expect(container.querySelectorAll('button[aria-label$="说明"]')).toHaveLength(4);
  await act(async () => help.focus());
  const tooltip = document.querySelector('[role="tooltip"]');
  expect(tooltip.textContent).toContain('生成分支名时使用的日期偏移天数');
  expect(tooltip.textContent).toContain('feature/alice/yyyy-MM-dd-*');
  expect(help.getAttribute('aria-describedby')).toBe(tooltip.id);
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await act(async () => help.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(true);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await click(toggle);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(toggle.textContent).toContain('已启用');
  expect(hour.disabled).toBe(false);
  await click(hour);
  await click(document.querySelector('[role="menuitem"][data-value="09"]'));
  await click(minute);
  await click(document.querySelector('[role="menuitem"][data-value="45"]'));
  expect(hour.textContent).toContain('09');
  expect(minute.textContent).toContain('45');
  await click(button('保存'));
  expect(
    JSON.parse(fetch.mock.calls.find(([, options]) => options?.method === 'POST')[1].body).sync,
  ).toMatchObject({
    dailyUpdateEnabled: true,
    dailyUpdateTime: '09:45',
  });
  const offset = container.querySelector('input[type="number"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      offset,
      '',
    );
    offset.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('保存').disabled).toBe(true);
  await click(toggle);
  expect(hour.disabled).toBe(true);
  expect(offset.value).toBe('1');
  await click(button('保存'));
  const saves = fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(JSON.parse(saves[1][1].body).sync).toMatchObject({
    dailyUpdateEnabled: false,
    dailyUpdateTime: '09:45',
  });
});

it('exposes and saves the scheduled Lark push switch independently', async () => {
  const fetch = vi.fn(async (_url, options) =>
    options?.method === 'POST'
      ? response({ synced: true })
      : response({
          defaultUsername: 'alice',
          sync: {
            dailyUpdateEnabled: true,
            dailyUpdateTime: '03:00',
            dailyOffsetDays: 1,
            larkPushEnabled: false,
          },
        }),
  );
  vi.stubGlobal('fetch', fetch);
  await mount(React.createElement(SyncScheduleSettings));
  const switches = [...container.querySelectorAll('[role="switch"]')];
  expect(switches).toHaveLength(2);
  const push = switches.find((node) => node.getAttribute('aria-label') === '推送飞书');
  expect(push).toBeTruthy();
  expect(push.getAttribute('aria-checked')).toBe('false');
  expect(push.textContent).toContain('已关闭');
  expect(container.querySelector('[aria-label="推送飞书说明"]')).toBeTruthy();
  await click(push);
  expect(push.getAttribute('aria-checked')).toBe('true');
  await click(button('保存'));
  const body = JSON.parse(
    fetch.mock.calls.find(([, options]) => options?.method === 'POST')[1].body,
  );
  expect(body.sync.larkPushEnabled).toBe(true);
  expect(body.sync.dailyUpdateEnabled).toBe(true);
});
