// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { TaskReportsPanel } = require('../../src/client/components/TaskReportsPanel.js');
const { DailyReportsPanel } = require('../../src/client/components/DailyReportsPanel.js');
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
});
const response = (value, ok = true) => ({ ok, json: async () => value });
const button = (label) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
const click = (node) => act(async () => node.click());
const report = () => ({
  id: 'daily',
  day: '2026-11-17',
  brief: {
    workspaceId: 'ws',
    status: 'failed',
    error: 'DAILY_MODEL_DISABLED',
    summary: 'Earlier summary',
    path: 'daily-reports/2026-11-17-summary.md',
  },
  timeZone: 'Asia/Shanghai',
  enabled: true,
  scanErrors: [],
  nextOffset: null,
  groups: [
    {
      id: 'group',
      workspaceId: 'ws',
      workspaceTitle: 'Workspace',
      group: 'author/2026-11-17-change',
      count: 1,
      added: 1,
      changed: 0,
      nextFileOffset: null,
      digest: 'version',
      files: [
        {
          id: 'file',
          path: 'requirement.md',
          version: 'frozen-hash',
          size: 30,
          change: 'new',
          sources: ['writing'],
        },
      ],
    },
  ],
});

it('uses all three tabs with End, Home and cyclic arrow navigation without querying legacy daily kind', async () => {
  const fetch = vi.fn(async (url) =>
    response(String(url).includes('daily-reports') ? report() : { items: [] }),
  );
  vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(React.createElement(TaskReportsPanel)));
  const tabs = container.querySelectorAll('[role="tab"]');
  expect(tabs).toHaveLength(3);
  await act(async () =>
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tabs[2]);
  expect(container.textContent).toContain('每日总简报');
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(fetch.mock.calls.some(([url]) => String(url).includes('kind=daily'))).toBe(false);
  await act(async () =>
    tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  await act(async () =>
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })),
  );
  expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  await act(async () =>
    tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })),
  );
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
});

it('keeps content on refresh errors, retries the authorized group and opens the actual brief', async () => {
  const onNavigate = vi.fn();
  const fetch = vi.fn(async (_url, options) =>
    response(options?.method === 'POST' ? { queued: true } : report()),
  );
  vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(React.createElement(DailyReportsPanel, { onNavigate })));
  expect(container.textContent).toContain('Earlier summary');
  await click(button('展开文件清单与版本'));
  expect(document.querySelector('[role="dialog"]').textContent).toContain('写作产物');
  expect(document.querySelector('[role="dialog"]').textContent).toContain('frozen-hash');
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(container.textContent).toContain('AI 已关闭');
  await click(button('查看简报文件'));
  expect(onNavigate).toHaveBeenCalledWith({
    kind: 'file',
    workspaceId: 'ws',
    path: report().brief.path,
  });
  await click(button('重试简报'));
  expect(
    JSON.parse(fetch.mock.calls.find(([, options]) => options?.method === 'POST')[1].body),
  ).toEqual({ day: '2026-11-17', id: 'daily' });
  fetch.mockResolvedValueOnce(response({ error: 'DAILY_FAILED' }, false));
  await click(button('刷新'));
  expect(container.textContent).toContain('Earlier summary');
  expect(container.querySelector('[role="alert"]').textContent).toContain('日报读取失败');
});

it('selects report dates with the shared themed calendar and preserves calendar date values', async () => {
  const fetch = vi.fn(async () => response(report()));
  vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(React.createElement(DailyReportsPanel)));
  expect(container.querySelector('input[type="date"]')).toBeNull();
  const trigger = container.querySelector('[aria-haspopup="dialog"]');
  expect(trigger.getAttribute('aria-label')).toContain('文件日期');
  await click(trigger);
  expect(document.querySelector('[role="dialog"]').parentElement).toBe(document.body);
  await click(document.querySelector('[aria-label="2026-11-16"]'));
  expect(
    fetch.mock.calls.some(
      ([url]) => new URL(String(url), 'http://localhost').searchParams.get('day') === '2026-11-16',
    ),
  ).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('distinguishes disabled collection, empty dates and pending briefs from success', async () => {
  const fetch = vi.fn(async () => response({ ...report(), enabled: false, groups: [] }));
  vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(React.createElement(DailyReportsPanel)));
  expect(container.textContent).toContain('自动简报已关闭');
  expect(container.textContent).toContain('尚未收集到文件');
  fetch.mockResolvedValueOnce(
    response({ ...report(), brief: null, groups: [{ ...report().groups[0], group: '' }] }),
  );
  await click(button('刷新'));
  expect(container.textContent).not.toContain('公共资料');
  expect(container.textContent).toContain('等待每天 08:00 生成');
  expect(container.textContent).not.toContain('简报已完成');
});

it('shows one daily status and diagnostic action regardless of the number of source groups', async () => {
  const value = report();
  value.groups.push({ ...value.groups[0], id: 'other', workspaceTitle: 'Other workspace' });
  value.brief = {
    status: 'failed',
    error: 'KB_TOOL_FAILED',
    errorDetails: { cause: 'KB_EVIDENCE_NOT_FULLY_READ', unreadRequiredCount: 1 },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(value)),
  );
  await act(async () => root.render(React.createElement(DailyReportsPanel)));
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.textContent).not.toContain('Other workspace');
  expect(container.textContent).toContain('简报工具校验失败');
  expect(container.textContent).not.toContain('知识编译');
  await click(button('查看简报失败详情'));
  expect(document.querySelector('[role="dialog"]').textContent).toContain(
    'KB_EVIDENCE_NOT_FULLY_READ',
  );
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  value.brief.status = 'running';
  await click(button('刷新'));
  expect(container.textContent).toContain('正在生成简报');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button('查看简报失败详情')).toBeUndefined();
});

it('renders model HTML as inert text and does not silently combine changed file pages', async () => {
  const value = report();
  value.brief.summary = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(value)),
  );
  await act(async () => root.render(React.createElement(DailyReportsPanel)));
  expect(container.querySelector('script, img')).toBeNull();
  expect(container.textContent).toContain('<script>');
});

it('explains current-file reads and unavailable originals without promising historical copies', async () => {
  const value = report();
  value.brief.reads = [{ fileState: 'updated_since_collection' }, { fileState: 'unavailable' }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(value)),
  );
  await act(async () => root.render(React.createElement(DailyReportsPanel)));
  expect(container.textContent).toContain('从原文件读取');
  expect(container.textContent).toContain('部分原文件已删除或无法读取');
});
