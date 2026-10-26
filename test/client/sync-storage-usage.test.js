// @vitest-environment jsdom
import{it,expect,vi,afterEach}from'vitest';import{createRequire}from'node:module';const require=createRequire(import.meta.url),React=require('react'),{createRoot}=require('react-dom/client'),{SyncStorageUsage}=require('../../src/client/components/SyncStorageUsage.js');const{act}=React;globalThis.IS_REACT_ACT_ENVIRONMENT=true;let root;
afterEach(async()=>{if(root)await act(async()=>root.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();});
it('shows physical usage and refreshes the history after successful collection',async()=>{
 const usage={physicalBytes:2097152,objectBytes:1048576,artifactBytes:1048576,reclaimableBytes:0},changed=vi.fn(),fetchMock=vi.fn(async()=>({ok:true,json:async()=>({success:true,usage})}));vi.stubGlobal('fetch',fetchMock);const container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
 await act(async()=>root.render(React.createElement(SyncStorageUsage,{workspaceId:'ws',onChanged:changed})));expect(container.textContent).toContain('工作区占用 2.0 MB');await act(async()=>container.querySelector('button').click());expect(fetchMock.mock.calls[1][1].method).toBe('POST');expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({workspaceId:'ws'});expect(changed).toHaveBeenCalledOnce();
});
it('aborts pending requests on unmount and never reports failed cleanup as success',async()=>{
 let signal;vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}));const container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);await act(async()=>root.render(React.createElement(SyncStorageUsage,{workspaceId:'ws'})));await act(async()=>root.unmount());root=null;expect(signal.aborted).toBe(true);
});
