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
it('shows preparation before the POST responds, follows real file counts and then hands over to SSE', async () => {
  const original = fetch.getMockImplementation();
  let release;
  fetch.mockImplementation(async (url, options) => {
    if (url.includes('/phased-sync')) return new Promise(resolve => { release = resolve; });
    if (url.includes('/sync-overview')) return json({ active: { ...task(), status: 'preparing', steps: [{ phase: 'init', label: '同步检查', status: 'running', activity: { stage: 'sources', current: 12, total: 40 } }] } });
    return original(url, options);
  });
  await start();
  expect(container.textContent).toContain('正在准备同步并检查输入');
  await act(async () => new Promise(resolve => setTimeout(resolve, 1100)));
  expect(container.textContent).toContain('正在冻结代码文件… (12/40)');
  events = [{ type: 'error', error: detail.error, sync: detail }];
  await act(async () => release(await original('/phased-sync', { method: 'POST' })));
  expect(container.textContent).toContain('同步失败');
  expect(container.textContent).not.toContain('正在冻结代码文件');
  const observations = fetch.mock.calls.filter(([url]) => url.includes('/sync-overview')).length;
  await act(async () => new Promise(resolve => setTimeout(resolve, 1100)));
  expect(fetch.mock.calls.filter(([url]) => url.includes('/sync-overview'))).toHaveLength(observations);
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

it('filters the whole sync history by document type, including failed tasks', async () => {
  const original = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, ...args) => url.includes('/sync-history?') ? json({ history: [
    { ...task('failed'), id: 'req-task', docTypeName: 'REQ_ONLY' },
    { ...task('failed'), id: 'design-task', docType: 'design', docTypeName: 'DESIGN_ONLY' },
  ] }) : original(url, ...args));
  await act(async () => root.render(React.createElement(DocsViewerContext.Provider, { value: {} }, React.createElement(SyncPanel, { workspaceId: 'ws', selectedReq: req, onClose: vi.fn() }))));
  await act(async () => button('同步历史').click());
  expect(container.textContent).toContain('REQ_ONLY');
  expect(container.textContent).not.toContain('DESIGN_ONLY');
  await act(async () => button('技术方案').click());
  expect(container.textContent).toContain('DESIGN_ONLY');
  expect(container.textContent).not.toContain('REQ_ONLY');
  await act(async () => button('需求文档').click());
  expect(container.textContent).toContain('REQ_ONLY');
  expect(container.textContent).not.toContain('DESIGN_ONLY');
});

it('offers a return entry after reopening the panel and follows the running task to failure',async()=>{
 const original=fetch.getMockImplementation();detail=task();fetch.mockImplementation(async(url,...args)=>url.includes('/sync-active?')?json({active:true,sync:detail}):original(url,...args));
 await act(async()=>root.render(React.createElement(DocsViewerContext.Provider,{value:{}},React.createElement(SyncPanel,{workspaceId:'ws',selectedReq:req,onClose:vi.fn()}))));expect(button('查看当前同步进度')).toBeDefined();await act(async()=>button('查看当前同步进度').click());expect(container.textContent).toContain('同步进行中');detail=task('failed');await act(async()=>new Promise(resolve=>setTimeout(resolve,1100)));expect(container.textContent).toContain('同步失败');expect(container.textContent).toContain('fixture failure');
});
it('opens preparation again and follows its handoff to a persistent execution',async()=>{
 const original=fetch.getMockImplementation(),preparing={...task(),id:undefined,status:'preparing',notificationId:'notice',startedAt:123,steps:[{phase:'init',label:'同步检查',status:'running',activity:{stage:'sources',current:2,total:5}}]};let active=preparing;
 fetch.mockImplementation(async(url,...args)=>url.includes('/sync-active?')?json({active:true,sync:active}):url.includes('/sync-overview')?json({active}):original(url,...args));await act(async()=>root.render(React.createElement(DocsViewerContext.Provider,{value:{syncActivity:preparing}},React.createElement(SyncPanel,{workspaceId:'ws',selectedReq:req,onClose:vi.fn()}))));await act(async()=>button('查看当前同步进度').click());expect(container.textContent).toContain('正在冻结代码文件');expect(button('终止同步任务')).toBeUndefined();active={...task(),notificationId:'notice',startedAt:123};detail=task('failed');await act(async()=>new Promise(resolve=>setTimeout(resolve,1200)));await act(async()=>new Promise(resolve=>setTimeout(resolve,100)));expect(container.textContent).toContain('同步失败');expect(fetch.mock.calls.some(([url])=>url.includes('/sync-detail?id=real-task'))).toBe(true);
});
it('makes an active design execution accessible from history even with no completed records',async()=>{
 const original=fetch.getMockImplementation(),active={...task(),docType:'design',docTypeName:'技术方案'};detail=active;fetch.mockImplementation(async(url,...args)=>url.includes('/sync-history?')?json({history:[],activeSync:active}):original(url,...args));await act(async()=>root.render(React.createElement(DocsViewerContext.Provider,{value:{}},React.createElement(SyncPanel,{workspaceId:'ws',selectedReq:req,onClose:vi.fn()}))));await act(async()=>button('同步历史').click());expect(button('查看进行中的同步：技术方案')).toBeDefined();await act(async()=>button('查看进行中的同步：技术方案').click());expect(container.textContent).toContain('同步进行中');expect(container.textContent).toContain('代码差异分析');
});
it('distinguishes raw code size from complete input budgets and exposes their components', async()=>{
  const sync=task('failed');
  sync.steps[0].sourceTokens=614658;
  const step=sync.steps.find(item=>item.phase==='code_analysis');
  Object.assign(step,{totalTokens:90000,chunks:[{index:0,status:'failed',tokens:90000,inputBudget:{evidenceTokens:30000,commonTokens:10000,promptTokens:5000,reservedTokens:45000}}]});
  await act(async()=>root.render(React.createElement(DocsViewerContext.Provider,{value:{}},React.createElement(SyncPanel,{workspaceId:'ws',selectedReq:req,focusedSync:sync,onClose:vi.fn()}))));
  expect(container.textContent).toContain('代码正文估算：614.7k tokens');
  expect(container.textContent).toContain('输入预算 90.0k tokens');
  await act(async()=>[...container.querySelectorAll('.rh-sync-step-label')].find(el=>el.textContent==='代码差异分析').click());
  await act(async()=>[...container.querySelectorAll('span')].find(el=>el.textContent==='1 块').click());
  expect(container.textContent).toContain('证据读取 30.0k · 公共材料 10.0k · 提示词 5.0k · 预留 45.0k');
  expect(container.textContent).toContain('不代表代码量或实际消耗');
});
