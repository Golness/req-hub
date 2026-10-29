// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),React=require('react'),{act}=React;
const {createRoot}=require('react-dom/client');
const {WikiPanel}=require('../../src/client/components/WikiPanel.js');
const {WikiSettings}=require('../../src/client/components/WikiSettings.js');
const {SessionSelectionContext}=require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let root,container,fetch;
const response=value=>({ok:true,json:async()=>value});
beforeEach(()=>{
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  fetch=vi.fn(async url=>{
    const path=new URL(url,'http://localhost').pathname;
    if(path.endsWith('/jobs')||path.endsWith('/candidates'))return response({items:[]});
    if(path.endsWith('/pages'))return response({items:[{id:'page',title:'Topic',page_type:'concept',version:2,status:'ready'}]});
    if(path.endsWith('/pages/page/revisions'))return response({items:[{id:'old',version:1,createdAt:'yesterday'}]});
    if(path.endsWith('/pages/page'))return response({id:'page',title:'Topic',body:'<script>window.secret=1</script>',version:2,revision:{version:String(url).includes('revision=old')?1:2,evidence:[]},refs:[]});
    if(path.endsWith('/scopes'))return response({items:[{id:'scope',title:'Workspace',current:true}]});
    return response({items:[]});
  });vi.stubGlobal('fetch',fetch);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
const click=async label=>act(async()=>[...container.querySelectorAll('button')].find(node=>node.textContent===label).click());
const render=async tab=>act(async()=>root.render(React.createElement(SessionSelectionContext.Provider,{value:()=> 'parent'},React.createElement(WikiPanel,{workspaceId:'ws',tab}))));
it('renders generated content as text and prevents saving a historical revision',async()=>{
  await render('wiki');await click('查看详情');
  expect(container.querySelector('script')).toBeNull();expect(window.secret).toBeUndefined();
  expect(container.querySelector('textarea').value).toContain('<script>');
  await click('历史版本');const version=[...container.querySelectorAll('button')].find(node=>node.textContent.startsWith('v1'));
  await act(async()=>version.click());
  expect(container.textContent).toContain('正在查看历史版本 v1');
  expect([...container.querySelectorAll('button')].some(node=>node.textContent==='保存修改')).toBe(false);
  await click('返回当前版本');expect(container.textContent).not.toContain('正在查看历史版本');
});
it('passes the selected knowledge scope and actual parent session to a query',async()=>{
  await render('query');await click('提问');
  const call=fetch.mock.calls.find(([,init])=>init?.method==='POST');
  expect(JSON.parse(call[1].body)).toMatchObject({kind:'query',scopeIds:['scope'],workspaceId:'ws'});
  expect(call[1].headers['x-session-id']).toBe('parent');
});
it('aborts outstanding reads when the panel is unloaded',async()=>{
  let signal;fetch.mockImplementation((_url,init)=>{signal=init.signal;return new Promise(()=>{});});
  await render('index');expect(signal.aborted).toBe(false);
  await act(async()=>root.render(null));expect(signal.aborted).toBe(true);
});
it('loads Wiki settings on expansion and submits their concurrency version',async()=>{
  fetch.mockImplementation(async(_url,init)=>response(init?.method==='PUT'?{values:{autoManage:false},version:'next'}:{values:{autoManage:true},version:'original'}));
  await act(async()=>root.render(React.createElement(WikiSettings,{workspaceId:'ws'})));
  expect(fetch).not.toHaveBeenCalled();
  const details=container.querySelector('details');await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});
  await act(async()=>container.querySelector('input[type="checkbox"]').click());await click('保存');
  const call=fetch.mock.calls.find(([,init])=>init?.method==='PUT');
  expect(JSON.parse(call[1].body)).toMatchObject({expectedVersion:'original',values:{autoManage:false}});
});
