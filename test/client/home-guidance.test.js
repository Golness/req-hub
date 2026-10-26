// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { DocsViewerBody } = require('../../src/client/components/DocsViewerBody.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, fetchMock;
const first = { id: '2026-10-24-orders', path: 'alice/2026-10-24-orders', title: '订单' };
const second = { id: '2026-10-24-inventory', path: 'alice/2026-10-24-inventory', title: '库存' };
const response = data => ({ ok: true, json: async () => data });
function requests({ requirements = [first], commits = [] } = {}) {
  fetchMock = vi.fn(async url => {
    if (url.includes('/tree?')) return response({ tree: { developers: requirements.length ? [{ name: 'alice', requirements }] : [] } });
    if (url.includes('/sync-commits?')) return typeof commits === 'function' ? commits(url) : response({ commits });
    if (url.includes('/writing/options')) return response({ scopes: [], starters: { requirement: { label: '需求文档', content: '# 需求' } } });
    if (url.includes('/entries')) return response({ entries: [] });
    if (url.includes('/sessions')) return response({ sessions: [] });
    return response({});
  });
  vi.stubGlobal('fetch', fetchMock);
}
beforeEach(() => { localStorage.clear(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(initialReqId = first.id, overrides = {}) {
  await act(async () => root.render(React.createElement(DocsViewerBody, { workspace: { id: 'ws', title: '工作区' }, docsDir: 'docs', workspaces: [], initialReqId, onSelectWorkspace: vi.fn(), onConfigChange: vi.fn(), ...overrides })));
}
const action = text => [...container.querySelectorAll('.rh-empty-state-actions button')].find(button => button.textContent === text);
const click = async element => act(async () => element.click());
const description = () => [...container.querySelectorAll('.rh-right-body .rh-empty-state-desc')].find(element => !element.closest('[style*="display: none"]'));

it('keeps sync progress in the shell after navigation and retains a clickable, dismissible completion notice',async()=>{
 requests();const original=fetchMock.getMockImplementation();
 const task={id:'task',snapshotDir:'v2/attempt',workspaceId:'ws',requirementId:first.id,requirementPath:first.path,docType:'requirement',docTypeName:'需求文档',status:'running',steps:[{phase:'init',label:'同步检查',status:'completed'},{phase:'code_analysis',label:'代码差异分析',status:'running',chunks:[{status:'completed'},{status:'running'}]}]};
 let overview={active:task,latest:null};
 fetchMock.mockImplementation(async(url,...args)=>url.includes('/sync-overview')?response(overview):original(url,...args));
 await render();expect(container.querySelector('.rh-statusbar').textContent).toContain('后台同步中');expect(container.querySelector('.rh-statusbar').textContent).toContain('分块 1/2');
 const rail=text=>[...container.querySelectorAll('.rh-rail-btn')].find(button=>button.textContent===text);
 await click(rail('同步'));
 expect([...container.querySelectorAll('button')].find(button=>button.textContent==='同步技术方案')).toBeUndefined();
 expect([...container.querySelectorAll('button')].find(button=>button.textContent==='查看当前同步进度')).toBeDefined();
 await click(rail('知识库'));expect(container.querySelector('.rh-statusbar').textContent).toContain('后台同步中');
 expect(fetchMock.mock.calls.some(([url])=>url.includes('/sync-abort'))).toBe(false);
 overview={active:null,latest:{...task,status:'completed',completedAt:100,steps:task.steps.map(step=>({...step,status:'completed'}))}};
 await act(async()=>window.dispatchEvent(new Event('req-hub-sync-change')));
 expect(container.querySelector('.rh-statusbar').textContent).toContain('同步完成');
 await click(container.querySelector('.rh-sync-status-link'));
 expect([...container.querySelectorAll('.rh-rail-btn.active')].some(button=>button.textContent==='同步')).toBe(true);
 expect(container.querySelector('.rh-right-body').textContent).toContain('同步完成');
 expect(container.querySelector('.rh-sync-status')).toBeNull();
 await act(async()=>window.dispatchEvent(new Event('req-hub-sync-change')));
 expect(container.querySelector('.rh-sync-status')).toBeNull();
});

it('opens a completion notice in its own workspace and does not force later workspace switches back',async()=>{
 requests({requirements:[first,second]});const original=fetchMock.getMockImplementation();
 const target={id:'other',title:'另一个工作区'},selectWorkspace=vi.fn();
 const task={id:'task',snapshotDir:'v2/other-attempt',workspaceId:'other',requirementId:second.id,requirementPath:second.path,docType:'design',docTypeName:'技术方案',status:'completed',completedAt:100,steps:[]};
 fetchMock.mockImplementation(async(url,...args)=>url.includes('/sync-overview')?response({active:null,latest:task}):original(url,...args));
 await render(first.id,{workspaces:[target],onSelectWorkspace:selectWorkspace});
 await click(container.querySelector('.rh-sync-status-link'));expect(selectWorkspace).toHaveBeenCalledWith(target);
 await render(first.id,{workspace:target,workspaces:[target],onSelectWorkspace:selectWorkspace});
 expect(container.querySelector('.rh-right-body').textContent).toContain('同步完成');
 expect(container.querySelector('.rh-right-body').textContent).toContain('技术方案');
 expect(fetchMock.mock.calls.some(([url])=>url.includes('/sync-active?workspaceId=other')&&url.includes(encodeURIComponent(second.id)))).toBe(true);
 await render(first.id,{workspaces:[target],onSelectWorkspace:selectWorkspace});expect(selectWorkspace).toHaveBeenCalledTimes(1);
});
it('removes a running task from the footer silently and immediately enables starting another task',async()=>{
 requests();const original=fetchMock.getMockImplementation(),confirm=vi.spyOn(window,'confirm'),alert=vi.spyOn(window,'alert');
 const task={id:'running-task',snapshotDir:'v2/task/attempt',workspaceId:'ws',requirementId:first.id,docType:'requirement',status:'running',steps:[]};
 let overview={active:task,latest:null};
 fetchMock.mockImplementation(async(url,...args)=>{
  if(url.includes('/sync-overview'))return response(overview);
  if(url.includes('/sync-delete')){overview={active:null,latest:null};return response({success:true});}
  return original(url,...args);
 });
 await render();await click([...container.querySelectorAll('.rh-rail-btn')].find(button=>button.textContent==='同步'));
 const start=()=>[...container.querySelectorAll('button')].find(button=>button.textContent==='同步需求文档');
 expect(start()).toBeUndefined();
 await click(container.querySelector('.rh-statusbar [aria-label="删除本次执行"]'));
 expect(container.querySelector('.rh-sync-status')).toBeNull();expect(start().disabled).toBe(false);
 expect(confirm).not.toHaveBeenCalled();expect(alert).not.toHaveBeenCalled();expect(container.querySelector('.rh-toast')).toBeNull();
});

it('guides an existing requirement to writing and knowledge instead of creating another requirement', async () => {
  requests(); await render();
  expect([...container.querySelectorAll('.rh-rail-btn')].some(button => button.textContent === '追溯')).toBe(false);
  expect(description().textContent).toContain('订单');
  expect(action('新建需求')).toBeUndefined(); expect(action('开始写作')).toBeTruthy(); expect(action('管理知识库')).toBeTruthy();
  await click(action('管理知识库'));
  expect(container.querySelector('.rh-file-tree-sidebar')).not.toBeNull();
  expect([...container.querySelectorAll('.rh-rail-btn.active')].some(button => button.textContent === '知识库')).toBe(true);
  await click(container.querySelector('[aria-label="关闭面板"]'));
  await click(action('开始写作'));
  expect(container.querySelector('.rh-writing-panel')).not.toBeNull();
  expect(container.querySelector('.rh-file-tree-sidebar')).toBeNull();
});
it('offers synchronization only after confirming commits on the selected requirement branch', async () => {
  let resolve;
  requests({ commits: () => new Promise(done => { resolve = done; }) }); await render();
  expect(action('同步文档')).toBeUndefined();
  await act(async () => resolve(response({ commits: [{ hash: 'abc' }] })));
  expect(action('同步文档')).toBeTruthy();
  expect(description().textContent).toContain('可同步的提交');
  const url = new URL(fetchMock.mock.calls.find(([url]) => url.includes('/sync-commits?'))[0], 'http://localhost');
  expect(url.searchParams.get('workspaceId')).toBe('ws'); expect(url.searchParams.get('requirementId')).toBe(first.id);
  await click(action('同步文档'));
  expect([...container.querySelectorAll('.rh-rail-btn.active')].some(button => button.textContent === '同步')).toBe(true);
});
it.each(['empty', 'failure'])('keeps writing and knowledge guidance when commit lookup returns %s', async mode => {
  requests({ commits: mode === 'failure' ? () => Promise.reject(new Error('no branch')) : [] }); await render();
  expect(action('同步文档')).toBeUndefined(); expect(action('开始写作')).toBeTruthy(); expect(action('管理知识库')).toBeTruthy();
});
it('ignores a late commit response belonging to a previous requirement', async () => {
  let resolve;
  requests({ requirements: [first, second], commits: url => url.includes(first.id) ? new Promise(done => { resolve = done; }) : response({ commits: [] }) });
  await render(first.id); await render(second.id);
  await act(async () => resolve(response({ commits: [{ hash: 'old' }] })));
  expect(description().textContent).toContain('库存'); expect(action('同步文档')).toBeUndefined();
});
it('offers selection and creation only when no requirement directory is selected', async () => {
  requests({ requirements: [] }); await render();
  expect(action('选择需求目录')).toBeTruthy(); expect(action('新建需求')).toBeTruthy(); expect(action('开始写作')).toBeUndefined();
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/sync-commits?'))).toBe(false);
});
