// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
const {DeleteSyncTaskButton}=require('../../src/client/components/shared/DeleteSyncTaskButton.js');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let root,container;
const task={id:'task',snapshotDir:'v2/task/attempt',workspaceId:'ws',requirementId:'req',status:'running'};
beforeEach(()=>{container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('deletes a running task directly without confirmation or termination-failure notifications',async()=>{
 const confirm=vi.spyOn(window,'confirm'),alert=vi.spyOn(window,'alert'),deleted=vi.fn();
 const fetchMock=vi.fn(async()=>({ok:true,json:async()=>({success:true})}));vi.stubGlobal('fetch',fetchMock);
 await act(async()=>root.render(React.createElement(DeleteSyncTaskButton,{task,onDeleted:deleted})));
 await act(async()=>container.querySelector('button').click());
 expect(fetchMock.mock.calls[0][0]).toBe('/req-hub/sync-delete');expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({syncId:'task',snapshotDir:'v2/task/attempt'});
 expect(deleted).toHaveBeenCalledWith(task);expect(confirm).not.toHaveBeenCalled();expect(alert).not.toHaveBeenCalled();
});
it('leaves deletion retryable after a transport error without claiming that removal succeeded',async()=>{
 const deleted=vi.fn(),alert=vi.spyOn(window,'alert');vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('network');}));
 await act(async()=>root.render(React.createElement(DeleteSyncTaskButton,{task,onDeleted:deleted})));
 await act(async()=>container.querySelector('button').click());expect(deleted).not.toHaveBeenCalled();expect(alert).not.toHaveBeenCalled();expect(container.querySelector('button').disabled).toBe(false);
});
