import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { randomUUID } from 'node:crypto';
import { loadState, setActiveSync, getSyncHistory, getActiveSync, updateSyncProgress, completeSync, removeSyncTask, getSyncScope, abortSync, setAbortController, deleteAbortController } from '../../src/server/sync-state.js';
let root, workspaceId, requirementId;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'reqhub-state-'));workspaceId=randomUUID();requirementId='req';});
afterEach(async()=>{deleteAbortController(workspaceId,requirementId);await rm(root,{recursive:true,force:true});});
const task=()=>({workspaceId,requirementId,status:'running',startedAt:Date.now(),taskId:'same-selection'});
it('persists every attempt and never overwrites a failed execution on retry',async()=>{
 const old=task();await setActiveSync(old,root);await updateSyncProgress(old.id,{status:'failed'});await completeSync(old.id);
 const next=task();await setActiveSync(next,root);expect(next.id).not.toBe(old.id);await updateSyncProgress(next.id,{status:'completed'});await completeSync(next.id);
 const history=await getSyncHistory(workspaceId,requirementId);expect(history).toHaveLength(2);expect(history.map(item=>item.taskId)).toEqual(['same-selection','same-selection']);
 await loadState(workspaceId,requirementId,root);expect(await getSyncHistory(workspaceId,requirementId)).toHaveLength(2);
});
it('keeps cancelling tasks reserved until their owner finishes',async()=>{
 const current=task(),controller=new AbortController();await setActiveSync(current,root);setAbortController(workspaceId,requirementId,controller,current.id);
 await abortSync(current.id,workspaceId,requirementId);expect(controller.signal.aborted).toBe(true);expect((await getActiveSync(workspaceId,requirementId)).status).toBe('cancelling');
 await expect(setActiveSync(task(),root)).rejects.toThrow('BUSY');await completeSync(current.id,workspaceId,requirementId,current.snapshotDir);expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('aborted');
});
it('revokes deleted executions before late callbacks and allows a fresh attempt',async()=>{
 const old=task();await setActiveSync(old,root);await removeSyncTask(old);const next=task();await setActiveSync(next,root);await updateSyncProgress(old.id,{status:'completed'});await completeSync(old.id);
 expect((await getActiveSync(workspaceId,requirementId)).id).toBe(next.id);expect(await getSyncHistory(workspaceId,requirementId)).toHaveLength(0);await removeSyncTask(next);
});
it('retires old sync records without parsing them or touching formal documents',async()=>{
 await mkdir(join(root,'sync-logs','v2'),{recursive:true});await writeFile(join(root,'sync-logs','v2','.sync-state.json'),'invalid old data');await writeFile(join(root,'requirement.md'),'USER');
 const state=await loadState(workspaceId,requirementId,root);expect(state.history).toEqual([]);await expect(access(join(root,'sync-logs'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(root,'requirement.md'),'utf8')).toBe('USER');
});
it('rejects junction retirement and leaves its target untouched',async()=>{
 const external=await mkdtemp(join(tmpdir(),'reqhub-outside-'));
 try{await writeFile(join(external,'keep'),'KEEP');await symlink(external,join(root,'sync-logs'),'junction');await expect(loadState(workspaceId,requirementId,root)).rejects.toThrow('LINK');expect(await readFile(join(external,'keep'),'utf8')).toBe('KEEP');}finally{await rm(join(root,'sync-logs'),{force:true});await rm(external,{recursive:true,force:true});}
});
it('recovers expired leases and refuses to resurrect their late writes',async()=>{
 const current=task();await setActiveSync(current,root);const scope=getSyncScope(workspaceId,requirementId);scope.store.db.prepare('UPDATE leases SET expires=0 WHERE attempt=?').run(current.id);
 await loadState(workspaceId,requirementId,root);expect(await getActiveSync(workspaceId,requirementId)).toBeNull();expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('failed');await updateSyncProgress(current.id,{status:'completed'});expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('failed');
});
