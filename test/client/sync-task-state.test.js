// @vitest-environment jsdom
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), React = require('react');
const { createRoot } = require('react-dom/client'), { act } = React;
const { SyncPanel } = require('../../src/client/components/SyncPanel.js');
const { DocsViewerContext } = require('../../src/client/context.js');
const model = require('../../src/shared/sync-task.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, events, detail, postJson;
const req = { id: '2026-10-24-orders', path: 'dev/2026-10-24-orders', developer: 'dev' };
const json = data => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
function task(status = 'running') {
  const t = { id: 'real-task', workspaceId: 'ws', requirementId: req.id, status: 'running', docType: 'requirement', docTypeName: '需求文档', startedAt: Date.now(), steps: model.createSyncSteps(), generatedFiles: [] };
  if (status === 'failed') model.finishSyncTask(t, { status, phase: 'init', error: 'CAPABILITY_UNSUPPORTED: fixture failure' });
  if (status === 'aborted') model.finishSyncTask(t, { status });
  if (status === 'cancelling') model.updateSyncTask(t, { type: 'cancel' });
  return t;
}
beforeEach(() => {
  events = []; detail = task('failed'); postJson = null;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.includes('/sync-detail?')) return json({ sync: detail });
    if (url.includes('/sync-branch-info')) return json({ targetBranch: 'feature/orders', baseBranch: 'main' });
    if (url.includes('/sync-commits?')) return json({ commits: [{ hash: 'a'.repeat(40), shortHash: 'aaaa', subject: 'code', date: '2026-10-24' }], baseline: 'b'.repeat(40), branchTip: 'c'.repeat(40) });
    if (url.includes('/sessions?')) return json({ sessions: [] });
    if (options?.method === 'POST') {
      if (postJson) return json(postJson);
      return { ok: true, headers: { get: () => 'text/event-stream' }, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map(event => 'data: ' + JSON.stringify(event)).join('\n\n'))); controller.close();
      } }) };
    }
    return json({ active: false });
  }));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const button = text => [...container.querySelectorAll('button')].find(el => el.textContent.trim() === text);
async function start() {
  await act(async () => root.render(React.createElement(DocsViewerContext.Provider, { value: { refreshTree: vi.fn() } }, React.createElement(SyncPanel, { workspaceId: 'ws', selectedReq: req, onClose: vi.fn() }))));
  await act(async () => button('同步需求文档').click());
  await act(async () => new Promise(resolve => setTimeout(resolve, 300)));
  await act(async () => button('开始同步需求文档').click());
}
it('renders a server failure as a terminal task even when the error is the final SSE line', async () => {
  events = [{ type: 'sync_started', syncId: 'real-task' }, { type: 'state', sync: task() }, { type: 'error', error: detail.error, sync: detail }];
  await start();
  expect(container.textContent).toContain('同步失败'); expect(container.textContent).toContain('fixture failure');
  expect(container.textContent).not.toContain('同步进行中'); expect(button('终止同步任务')).toBeUndefined();
});
it('recovers authoritative failure state after a stream disconnect instead of leaving the task running', async () => {
  events = [{ type: 'sync_started', syncId: 'real-task' }, { type: 'state', sync: task() }];
  await start(); expect(container.textContent).toContain('同步失败'); expect(button('终止同步任务')).toBeUndefined();
});
it('keeps cancellation visible until the server confirms that the task ended', async () => {
  postJson = { active: true, sync: task('cancelling') }; detail = task('aborted');
  await start(); expect(container.textContent).toContain('正在终止'); expect(button('终止同步任务')).toBeUndefined();
  await act(async () => new Promise(resolve => setTimeout(resolve, 1100)));
  expect(container.textContent).toContain('已终止'); expect(container.textContent).not.toContain('正在终止');
});
