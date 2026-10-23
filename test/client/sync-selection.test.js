// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),React=require('react'),{createRoot}=require('react-dom/client');
const {SyncPanel}=require('../../src/client/components/SyncPanel.js');
const {DocsViewerContext}=require('../../src/client/context.js');
const {act}=React; globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let root,container,fetchMock,base='main',loadCommits;
const requirement={id:'2026-10-23-orders',path:'dev/2026-10-23-orders',developer:'dev',title:'订单',date:'2026-10-23'};
const commits=[1,2,3].map(i=>({hash:String(i).repeat(40),shortHash:String(i).repeat(8),subject:`提交 ${i}`,author:'作者',date:'2026-10-23T08:00:00Z'}));
const response=data=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data});
beforeEach(()=>{
 base='main';loadCommits=null;container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
 fetchMock=vi.fn(async(url,options)=>{
  if(url.includes('/sync-branch-info'))return response({targetBranch:'feature/dev/2026-10-23-orders',baseBranch:base,baseBranchHint:base?null:'未找到 main 或 master 分支，请手动填写基准分支。'});
  if(url.includes('/sync-commits?'))return loadCommits?loadCommits(url):response({commits,branchTip:'f'.repeat(40),baseline:'a'.repeat(40),hasUncommitted:false});
  if(url.includes('/sessions?'))return response({sessions:[]});
  if(options?.method==='POST')return response({skipped:true,message:'已同步'});
  return response({active:false});
 });vi.stubGlobal('fetch',fetchMock);
});
afterEach(async()=>{await act(async()=>root.unmount());document.body.innerHTML='';vi.unstubAllGlobals();vi.restoreAllMocks();});
const button=text=>[...container.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
async function open(){await act(async()=>root.render(React.createElement(DocsViewerContext.Provider,{value:{refreshTree:vi.fn()}},React.createElement(SyncPanel,{workspaceId:'ws',selectedReq:requirement,onClose:vi.fn()}))));await act(async()=>button('同步需求文档').click());}
async function loaded(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,300));});}
async function change(input,value){await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}

it('defaults the base, selects target-only commits, filters the list and sends only checked hashes',async()=>{
 await open();await loaded();expect(container.querySelector('[aria-label="同步基准分支"]').value).toBe('main');
 expect(container.querySelectorAll('.rh-sync-commit input:checked')).toHaveLength(3);
 await change(container.querySelector('[aria-label="筛选提交"]'),'提交 2');expect(container.querySelectorAll('.rh-sync-commit')).toHaveLength(1);
 await act(async()=>container.querySelector('.rh-sync-commit input').click());await change(container.querySelector('[aria-label="筛选提交"]'),'');
 expect(container.querySelectorAll('.rh-sync-commit input:checked')).toHaveLength(2);
 await act(async()=>button('开始同步需求文档').click());
 const payload=JSON.parse(fetchMock.mock.calls.find(([,options])=>options?.method==='POST')[1].body);
 expect(payload).toMatchObject({baseBranch:'main',commitHashes:[commits[0].hash,commits[2].hash],branchTip:'f'.repeat(40),baseCommit:'a'.repeat(40)});
});
it('supports clear and select-all without interpreting zero checked commits as all',async()=>{
 await open();await loaded();await act(async()=>button('清空').click());expect(button('开始同步需求文档').disabled).toBe(true);
 await act(async()=>button('全选').click());expect(container.querySelectorAll('.rh-sync-commit input:checked')).toHaveLength(3);expect(button('开始同步需求文档').disabled).toBe(false);
});
it('uses master when supplied and requests manual input if neither default exists',async()=>{
 base='master';await open();await loaded();expect(container.querySelector('[aria-label="同步基准分支"]').value).toBe('master');
});
it('shows a manual base hint, waits for both branches and reloads commits for user input',async()=>{
 base=null;await open();expect(container.textContent).toContain('请手动填写基准分支');expect(fetchMock.mock.calls.some(([url])=>url.includes('/sync-commits?'))).toBe(false);
 expect(button('开始同步需求文档').disabled).toBe(true);await change(container.querySelector('[aria-label="同步基准分支"]'),'develop');await loaded();
 expect(fetchMock.mock.calls.some(([url])=>url.includes('baseBranch=develop'))).toBe(true);expect(container.querySelectorAll('.rh-sync-commit')).toHaveLength(3);
});
it('ignores stale commit responses after the comparison base changes',async()=>{
 let release;loadCommits=url=>url.includes('baseBranch=main')?new Promise(resolve=>{release=resolve;}):response({commits:[commits[2]],branchTip:'f'.repeat(40),baseline:'b'.repeat(40),hasUncommitted:false});
 await open();await loaded();await change(container.querySelector('[aria-label="同步基准分支"]'),'develop');expect(button('开始同步需求文档').disabled).toBe(true);await loaded();
 await act(async()=>release(response({commits:[commits[0]],branchTip:'f'.repeat(40),baseline:'a'.repeat(40),hasUncommitted:false})));
 expect(container.querySelectorAll('.rh-sync-commit')).toHaveLength(1);expect(container.querySelector('.rh-sync-commit').textContent).toContain('提交 3');
});

it('returns to the selector and shows a preflight error when branch tips changed',async()=>{
 await open();await loaded();
 fetchMock.mockImplementationOnce(async()=>({ok:false,status:409,headers:{get:()=> 'application/json'},json:async()=>({error:'COMMIT_LIST_CHANGED: 分支已更新，请刷新 commit 列表后重新选择'})}));
 await act(async()=>button('开始同步需求文档').click());
 expect(container.textContent).toContain('分支已更新');expect(container.querySelector('[aria-label="同步基准分支"]')).not.toBeNull();
});
