import {it,expect} from 'vitest';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{randomUUID}from'node:crypto';
import{setActiveSync,getSyncScope,updateSyncProgress,completeSync}from'../../src/server/sync-state.js';import{compareSyncSnapshots}from'../../src/server/sync-snapshots.js';
it.each(['requirement','design'])('compares independent %s snapshots and rejects cross-document or missing versions',async docType=>{
 const root=await mkdtemp(join(tmpdir(),'reqhub-snapshots-')),workspaceId=randomUUID(),requirementId='req',versions=[];
 try{for(const text of ['', 'NEW']){const task={workspaceId,requirementId,docType,status:'running',schemaVersion:2,startedAt:Date.now()};await setActiveSync(task,root);await writeFile(getSyncScope(workspaceId,requirementId).store.file(task,docType+'.md'),text);await updateSyncProgress(task.id,{status:'completed',publishState:'state_committed'});await completeSync(task.id);versions.push({...task});}
 expect(await compareSyncSnapshots(root,versions,versions[0].id,versions[1].id)).toMatchObject({oldContent:'',newContent:'NEW'});
 await expect(compareSyncSnapshots(root,versions,versions[0].id,versions[0].id)).rejects.toThrow();
 versions[1].docType=docType==='design'?'requirement':'design';await expect(compareSyncSnapshots(root,versions,versions[0].id,versions[1].id)).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
