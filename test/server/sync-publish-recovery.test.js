import {it,expect}from'vitest';import{mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{loadState}from'../../src/server/sync-state.js';import{hashBytes}from'../../src/server/sync-artifacts.js';
it.each(['running','completed'].flatMap(status=>['candidate','USER_EDIT','original'].map(live=>({status,live}))))('recovers an unarchived $status task with current content $live without overwriting it',async ({status,live})=>{
 const root=await mkdtemp(join(tmpdir(),'req-hub-publish-recover-'));
 try{
  const snapshotDir='v2/task/attempt',syncDir=join(root,'sync-logs',snapshotDir);await mkdir(syncDir,{recursive:true});
  const originalHash=hashBytes(Buffer.from('original')),candidateHash=hashBytes(Buffer.from('candidate'));
  await writeFile(join(root,'requirement.md'),live);await writeFile(join(syncDir,'requirement.md'),'candidate');
  await writeFile(join(syncDir,'validation.json'),JSON.stringify({originalHash,candidateHash}));
  await writeFile(join(syncDir,'publish-journal.json'),JSON.stringify({schemaVersion:2,stage:'document_written',originalHash,candidateHash}));
  await writeFile(join(root,'sync-logs','v2','.sync-state.json'),JSON.stringify({schemaVersion:2,activeSync:{schemaVersion:2,id:'task',docType:'requirement',status,startedAt:1,snapshotDir,originalHash,candidateHash},history:[]}));
  const state=await loadState(randomUUID(),randomUUID(),root);
  expect(state.activeSync).toBeNull();expect(state.history[0].status).toBe(live==='candidate'?'completed':'failed');
 }finally{await rm(root,{recursive:true,force:true});}
});
