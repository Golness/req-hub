// @vitest-environment jsdom
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { useSyncMonitor } = require('../../src/client/hooks/useSyncMonitor.js');
const { SyncStatusBar } = require('../../src/client/components/SyncStatusBar.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, overview, monitor;
const task = { id: 'task', workspaceId: 'ws', requirementId: 'req', snapshotDir: 'attempt', docType: 'design', status: 'running', steps: [] };
function Harness() { monitor = useSyncMonitor(); return React.createElement(SyncStatusBar, { monitor, onOpen: vi.fn() }); }
beforeEach(() => {
  vi.useFakeTimers(); overview = { active: task, latest: null };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => overview })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(React.createElement(Harness)));
const refresh = () => act(async () => monitor.refresh());
it('expires terminal notifications after eight seconds despite repeated polling', async () => {
  overview = { active: null, latest: { ...task, status: 'failed', error: '长错误'.repeat(200) } };
  await render();
  expect(container.querySelector('.rh-sync-status')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(7999));
  expect(container.querySelector('.rh-sync-status')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(container.querySelector('.rh-sync-status')).toBeNull();
  await refresh(); expect(container.querySelector('.rh-sync-status')).toBeNull();
  overview = { active: null, latest: { ...task, snapshotDir: 'next-attempt', status: 'completed' } };
  await refresh(); expect(container.textContent).toContain('同步完成');
});
it('dismisses a clicked running notice without stopping monitoring, then shows the terminal result', async () => {
  await render();
  await act(async () => container.querySelector('.rh-sync-status-link').click());
  expect(container.querySelector('.rh-sync-status')).toBeNull();
  expect(monitor.active.id).toBe(task.id);
  await refresh(); expect(container.querySelector('.rh-sync-status')).toBeNull();
  overview = { active: null, latest: { ...task, status: 'completed' } };
  await refresh(); expect(container.textContent).toContain('同步完成');
  await act(async () => container.querySelector('[aria-label="关闭同步通知"]').click());
  await refresh(); expect(container.querySelector('.rh-sync-status')).toBeNull();
});
