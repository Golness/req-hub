import{it,expect}from'vitest';import{mkdtemp,writeFile,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{loadState,setActiveSync,getSyncScope}from'../../src/server/sync-state.js';import{hashBytes}from'../../src/server/sync-artifacts.js';
it.each(['candidate','USER_EDIT','original'])('recovers publication with live content %s without overwriting it',async live=>{
 const root=await mkdtemp(join(tmpdir(),'reqhub-recover-')),workspaceId=randomUUID(),requirementId='req';
 try{const originalHash=hashBytes(Buffer.from('original')),candidateHash=hashBytes(Buffer.from('candidate')),task={workspaceId,requirementId,docType:'requirement',schemaVersion:2,status:'running',startedAt:1,originalHash,candidateHash};await setActiveSync(task,root);const scope=getSyncScope(workspaceId,requirementId);
 await writeFile(join(root,'requirement.md'),live);await writeFile(scope.store.file(task,'requirement.md'),'candidate');await writeFile(scope.store.file(task,'validation.json'),JSON.stringify({originalHash,candidateHash}));await writeFile(scope.store.file(task,'publish-journal.json'),JSON.stringify({schemaVersion:2,docPath:join(root,'requirement.md'),stage:'document_written',originalHash,candidateHash}));scope.store.db.prepare('UPDATE leases SET expires=0 WHERE attempt=?').run(task.id);
 const state=await loadState(workspaceId,requirementId,root);expect(state.activeSync).toBeNull();expect(state.history[0].status).toBe(live==='candidate'?'completed':'failed');expect(await readFile(join(root,'requirement.md'),'utf8')).toBe(live);
 }finally{await rm(root,{recursive:true,force:true});}
});
