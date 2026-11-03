// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { SyncHistoryRecords } = require('../../src/client/components/SyncHistoryRecords.js');
const { act } = React;
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
it('keeps navigation independent from both deletion scopes and preserves task identity', async () => {
  const onSelect = vi.fn();
  const onDeleted = vi.fn();
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
  vi.stubGlobal('fetch', fetch);
  const sync = {
    id: 'attempt',
    taskId: 'group',
    snapshotDir: 'snapshot',
    docTypeName: '技术方案',
    status: 'completed',
    startedAt: 1000,
    steps: [{ status: 'completed' }, { status: 'skipped' }],
  };
  await act(async () =>
    root.render(
      React.createElement(SyncHistoryRecords, {
        history: [sync],
        workspaceId: 'ws',
        requirementId: 'req',
        onSelect,
        onDeleted,
      }),
    ),
  );
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons[1].textContent).toBe('删除本次记录');
  expect(buttons[1].title).toBe('仅删除本次执行记录及中间文件，保留正式文档');
  expect(buttons[2].textContent).toBe('删除任务全部记录');
  expect(buttons[2].title).toBe('删除同一任务的全部执行记录（含重试）及中间文件，保留正式文档');
  await act(async () => buttons[0].click());
  expect(buttons[0].textContent).toBe('查看详情');
  expect(onSelect).toHaveBeenCalledWith(sync);
  onSelect.mockClear();
  await act(async () => buttons[1].click());
  await act(async () => buttons[2].click());
  expect(onSelect).not.toHaveBeenCalled();
  expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
    {
      scope: 'attempt',
      workspaceId: 'ws',
      requirementId: 'req',
      syncId: 'attempt',
      snapshotDir: 'snapshot',
    },
    {
      scope: 'task',
      workspaceId: 'ws',
      requirementId: 'req',
      syncId: 'attempt',
      snapshotDir: 'snapshot',
    },
  ]);
  expect(onDeleted.mock.calls.map(([, scope]) => scope)).toEqual(['attempt', 'task']);
  expect(container.textContent).toContain('步骤: 1/1');
});
