import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm,access } from 'node:fs/promises';
import { join } from 'node:path';import { tmpdir } from 'node:os';import { randomUUID } from 'node:crypto';import { execFileSync } from 'node:child_process';
import { createSyncHarness } from './sync-v2-harness.js';
import { sessionEvents } from './session-fixture.js';
import { renderSessionDocument } from '../../src/server/session-utils.js';
import { syncSupervisor } from '../../src/server/sync-supervisor.js';
import { setActiveSync, setAbortController } from '../../src/server/sync-state.js';
vi.mock('../../src/server/config.js',()=>({loadConfig:vi.fn().mockResolvedValue({docsDir:'docs',sync:{baseBranch:'main'}})}));
vi.mock('../../src/server/doc-reader.js',()=>({findRequirementDir:async root=>join(root,'2026-10-20-route-test')}));
const {createSyncRoutes}=await import('../../src/server/routes/sync-routes.js');
const {getSyncHistory,getActiveSync,getAbortController,abortSync}=await import('../../src/server/sync-state.js');
let repo,reqDir,routes,workspaceId,harness;
const requirementId='2026-10-20-route-test';
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const source='# 标题\r\n\r\n旧规则\r\n\r\n## 无关\r\n保持  空格\r\n';
async function getRoute(path) {
 const res={body:'',writeHead(status){this.status=status;},end(text=''){this.body+=text;}};
 await routes.find(route=>route.path===path.split('?')[0]).handler({method:'GET',url:path},res);
 return { status:res.status, data:JSON.parse(res.body) };
}
async function postRoute(path,data) {
 const listeners={},req={method:'POST',url:path,on:(name,fn)=>{listeners[name]=fn;}};
 const res={body:'',writeHead(status){this.status=status;},end(text=''){this.body+=text;}};
 const done=routes.find(route=>route.path===path).handler(req,res);
 listeners.data(JSON.stringify(data));listeners.end();await done;
 return {status:res.status,data:JSON.parse(res.body)};
}
function withSessionQuery(events) {
 harness.ctx.sessionQuery={listSessions:async()=>[{header:{id:'s',cwd:repo,createdAt:1}}],readTitle:async()=>({title:'同步会话'}),readSession:async()=>({events})};
 routes=createSyncRoutes({list:()=>[{id:workspaceId,path:repo}]},{},{},{get:()=>harness.parentAgent},harness.ctx);
}
async function dispatch(data={}, responseRef) {
 const listeners={};const req={method:'POST',headers:{'x-session-id':'parent'},url:'/req-hub/phased-sync',on:(name,fn)=>{listeners[name]=fn;}};
 const res={status:200,headersSent:false,body:'',writeHead(status){this.status=status;this.headersSent=true;},write(text){this.body+=text;},end(text=''){this.body+=text;}};
 if(responseRef)responseRef.current=res;
 await routes.find(route=>route.path==='/req-hub/phased-sync').handler(req,res);
 listeners.data(JSON.stringify({workspaceId,requirementId,docType:'requirement',...data}));await listeners.end();return res;
}
beforeEach(async()=>{
 repo=await mkdtemp(join(tmpdir(),'req-hub-v2-routes-'));reqDir=join(repo,'docs',requirementId);await mkdir(reqDir,{recursive:true});
 git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.test');
 await writeFile(join(repo,'source.js'),'base');git('add','.');git('commit','-m','base');git('switch','-c','feature/dev/'+requirementId);
 await writeFile(join(repo,'source.js'),'changed');git('add','.');git('commit','-m','change');
 for(const name of ['requirement.md','design.md']) await writeFile(join(reqDir,name),source);
 workspaceId=randomUUID();harness=createSyncHarness();
 const setup=()=>createSyncRoutes({list:()=>[{id:workspaceId,path:repo}]},{},{},{get:()=>harness.parentAgent},harness.ctx);
 routes=setup();
});
afterEach(async()=>{await routes.dispose();await rm(repo,{recursive:true,force:true});});
describe('v2 sync route integration',()=>{
 it('deletes a published task and its snapshots while retaining final documents and unrelated files',async()=>{
  await dispatch();const task=(await getSyncHistory(workspaceId,requirementId))[0];
  const final=await readFile(join(reqDir,'requirement.md'),'utf8');
  const other=join(reqDir,'sync-logs/v2/unrelated');await mkdir(other,{recursive:true});await writeFile(join(other,'keep.txt'),'keep');
  await writeFile(join(reqDir,'user-source.md'),'USER_SOURCE');
  const result=await postRoute('/req-hub/sync-delete',{workspaceId,requirementId,syncId:task.id,snapshotDir:task.snapshotDir});
  expect(result.data.success).toBe(true);expect(await getSyncHistory(workspaceId,requirementId)).toHaveLength(0);
  await expect(access(join(reqDir,'sync-logs',task.snapshotDir))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toBe(final);
  expect(await readFile(join(reqDir,'design.md'),'utf8')).toBe(source);
  expect(await readFile(join(reqDir,'user-source.md'),'utf8')).toBe('USER_SOURCE');expect(await readFile(join(other,'keep.txt'),'utf8')).toBe('keep');
  expect((await getRoute('/req-hub/sync-overview')).data.latest).toBeNull();
  expect((await dispatch({docType:'design'})).body).toContain('"type":"done"');
 });
 it('deletes a running task without waiting for failed termination and never resurrects it after late disposal',async()=>{
  let started,releaseResult,releaseDispose;
  const ready=new Promise(resolve=>{started=resolve;}),result=new Promise(resolve=>{releaseResult=resolve;}),cleanup=new Promise(resolve=>{releaseDispose=resolve;});
  const original=harness.ctx.subagents.start;
  harness.ctx.subagents.start=async()=>{started();return {id:'undeletable-host-child',result,dispose:async()=>{await cleanup;throw Error('HOST_TERMINATION_FAILED');}};};
  const running=dispatch();await ready;const old=syncSupervisor.owner.task,oldAttempt=old.snapshotDir;
  const removed=await postRoute('/req-hub/sync-delete',{workspaceId,requirementId,syncId:old.id,snapshotDir:oldAttempt});
  expect(removed.data).toEqual({success:true});await running;
  expect(syncSupervisor.owner).toBeNull();expect(getAbortController(workspaceId,requirementId)).toBeUndefined();
  expect(await getActiveSync(workspaceId,requirementId)).toBeNull();expect(await getSyncHistory(workspaceId,requirementId)).toHaveLength(0);
  expect((await getRoute('/req-hub/sync-overview')).data.latest?.snapshotDir).not.toBe(oldAttempt);
  harness.ctx.subagents.start=original;
  expect((await dispatch()).body).toContain('"type":"done"');
  releaseResult({stopReason:'aborted',output:[]});releaseDispose();await new Promise(resolve=>setTimeout(resolve,30));
  const current=(await getSyncHistory(workspaceId,requirementId))[0];expect(current.status).toBe('completed');expect(current.snapshotDir).not.toBe(oldAttempt);
  expect((await getRoute('/req-hub/sync-overview')).data.latest.snapshotDir).toBe(current.snapshotDir);
  await expect(access(join(reqDir,'sync-logs',oldAttempt))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('cannot delete a newer execution using a stale attempt identifier',async()=>{
  await dispatch();const task=(await getSyncHistory(workspaceId,requirementId))[0];
  const result=await postRoute('/req-hub/sync-delete',{workspaceId,requirementId,syncId:task.id,snapshotDir:task.snapshotDir+'-stale'});
  expect(result.status).toBe(409);expect(await getSyncHistory(workspaceId,requirementId)).toHaveLength(1);
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toContain('新规则');
 });
 it('can remove a preparation lease before a persistent task exists',async()=>{
  const owner=syncSupervisor.acquire({workspaceId,requirementId,docType:'requirement'});
  const result=await postRoute('/req-hub/sync-delete',{workspaceId,requirementId,notificationId:owner.notificationId});
  expect(result.data.success).toBe(true);expect(owner.controller.signal.aborted).toBe(true);expect(syncSupervisor.owner).toBeNull();
  expect((await dispatch()).body).toContain('"type":"done"');
 });
 it('removes an abnormal task with missing artifact metadata without deleting source files',async()=>{
  await setActiveSync({schemaVersion:2,id:'broken',workspaceId,requirementId,status:'unknown',steps:[]},reqDir);
  expect((await postRoute('/req-hub/sync-delete',{workspaceId,requirementId,syncId:'broken'})).data.success).toBe(true);
  expect(await getActiveSync(workspaceId,requirementId)).toBeNull();expect(await getSyncHistory(workspaceId,requirementId)).toHaveLength(0);
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toBe(source);
 });
 it('continues after client disconnection and rejects overlapping document types across requirements',async()=>{
  const original=harness.ctx.subagents.start;let release,started;
  const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  harness.ctx.subagents.start=async(...args)=>{const run=await original(...args);return {...run,result:run.result.then(async result=>{started();await gate;return result;})};};
  const responseRef={};const running=dispatch({},responseRef);await ready;
  expect((await dispatch({docType:'design'})).status).toBe(409);
  expect((await dispatch({requirementId:'another',docType:'design'})).status).toBe(409);
  const overview=await getRoute('/req-hub/sync-overview');expect(overview.data.active.docType).toBe('requirement');
  responseRef.current.destroyed=true;release();await running;
  expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('completed');
  expect((await getRoute('/req-hub/sync-overview')).data).toMatchObject({active:null,latest:{status:'completed'}});
 });
 it('reclaims an ownerless task and stale aborted controller before allowing a new task',async()=>{
  const old={id:'orphan',snapshotDir:'v2/orphan',schemaVersion:2,workspaceId,requirementId,docType:'design',status:'processing',completedAt:1,steps:[{phase:'init',status:'waiting'}]};
  await setActiveSync(old,reqDir);const stale=new AbortController();stale.abort();setAbortController(workspaceId,requirementId,stale,old.id);
  const overview=await getRoute('/req-hub/sync-overview');expect(overview.data.active).toBeNull();
  expect(overview.data.latest.error).toContain('OWNER_MISSING');expect(getAbortController(workspaceId,requirementId)).toBeUndefined();
  expect((await dispatch()).body).toContain('"type":"done"');
 });
 it('releases an expired execution even if child disposal hangs, and fences its late completion from a retry',async()=>{
  let started,releaseDispose;const ready=new Promise(resolve=>{started=resolve;}),cleanup=new Promise(resolve=>{releaseDispose=resolve;});
  const original=harness.ctx.subagents.start;
  harness.ctx.subagents.start=async(_provider,request)=>{
   const result=new Promise(resolve=>request.signal.addEventListener('abort',()=>resolve({stopReason:'aborted',output:[]}),{once:true}));
   started();return {id:'stuck-child',result,dispose:()=>cleanup};
  };
  const running=dispatch();await ready;
  const old=syncSupervisor.owner.task,oldAttempt=old.snapshotDir;
  await syncSupervisor.expire(syncSupervisor.owner,'SYNC_PROGRESS_TIMEOUT: 模拟执行收尾假死');await running;
  expect(await getActiveSync(workspaceId,requirementId)).toBeNull();expect(syncSupervisor.owner).toBeNull();
  harness.ctx.subagents.start=original;
  expect((await dispatch()).body).toContain('"type":"done"');
  const current=(await getSyncHistory(workspaceId,requirementId))[0];expect(current.id).toBe(old.id);expect(current.snapshotDir).not.toBe(oldAttempt);expect(current.status).toBe('completed');
  releaseDispose();await new Promise(resolve=>setTimeout(resolve,10));
  expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('completed');
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toContain('新规则');
 });
 it('previews and persists identical labeled session text, reads file references, and versions session-only changes',async()=>{
  const events=sessionEvents({intermediate:'INTERMEDIATE_BODY',final:'FINAL_BODY'.repeat(150)});withSessionQuery(events);
  const list=await getRoute('/req-hub/sessions?workspaceId='+workspaceId);
  const selected=list.data.sessions[0];expect(selected).toMatchObject({turnCount:1,syncTurnCount:1});
  const preview=await getRoute('/req-hub/session-turns?sessionId=s&version='+selected.snapshotVersion);
  expect(preview.data.turns[0].messages.map(message=>message.kind)).toEqual(['input','intermediate','followup','final']);
  const options={sessionIds:['s'],sessionVersions:{s:selected.snapshotVersion},commitHashes:[git('rev-parse','HEAD')],includeWorkingChanges:false};
  expect((await dispatch(options)).body).toContain('"type":"done"');
  const task=(await getSyncHistory(workspaceId,requirementId))[0];expect(task.status).toBe('completed');
  const file=join(reqDir,'sync-logs',task.snapshotDir,'input/sessions/session-1.md');
  const persisted=await readFile(file,'utf8');expect(persisted).toBe(renderSessionDocument('s',preview.data.turns));
  expect(persisted).not.toContain('SECRET');expect(persisted).toContain('INTERMEDIATE_BODY');
  const turnDoc=await readFile(join(reqDir,'sync-logs',task.snapshotDir,'input/sessions/session-1-turn-1.md'),'utf8');expect(turnDoc).toBe(persisted);
  expect(task.generatedFiles.some(file=>file.fileName.endsWith('input/sessions/session-1.md'))).toBe(true);
  expect(harness.calls.some(call=>call.name==='req_hub_sync_read'&&call.args.artifactId==='session.turn.0')).toBe(true);
  expect(harness.requests.every(request=>!JSON.stringify(request.prompt).includes('INTERMEDIATE_BODY'))).toBe(true);
  expect(JSON.parse((await dispatch(options)).body).skipped).toBe(true);
  events.push(...sessionEvents({turn:2,final:'新的决定'}));
  expect((await dispatch(options)).status).toBe(409);
  expect((await getRoute('/req-hub/session-turns?sessionId=s&version='+selected.snapshotVersion)).status).toBe(409);
  const fresh=(await getRoute('/req-hub/sessions?workspaceId='+workspaceId)).data.sessions[0];
  harness=createSyncHarness({noChange:true});withSessionQuery(events);
  expect((await dispatch({...options,sessionVersions:{s:fresh.snapshotVersion}})).body).toContain('"type":"done"');
  expect(await getSyncHistory(workspaceId,requirementId)).toHaveLength(2);
 });
 it('rejects missing session versions and session read errors before spawning or reserving a task',async()=>{
  withSessionQuery(sessionEvents());
  expect((await dispatch({sessionIds:['s']})).status).toBe(409);
  harness.ctx.sessionQuery.readSession=async()=>{throw Error('READ_FAILURE');};
  expect((await dispatch({sessionIds:['s'],sessionVersions:{s:'old'}})).body).toContain('SESSION_READ_FAILED');
  expect(harness.requests).toHaveLength(0);expect(await getActiveSync(workspaceId,requirementId)).toBeNull();
 });
 it.each(['requirement','design'])('publishes validated %s bytes and successful snapshots',async docType=>{
  const response=await dispatch({docType});expect(response.body).toContain('"type":"done"');
  expect(await readFile(join(reqDir,docType+'.md'),'utf8')).toBe(source.replace('旧规则','新规则'));
  const task=(await getSyncHistory(workspaceId,requirementId))[0];expect(task).toMatchObject({schemaVersion:2,status:'completed',publishState:'state_committed'});
  expect(task.snapshotDir).toMatch(/^v2\//);
  expect(await readFile(join(reqDir,'sync-logs',task.snapshotDir,docType+'.md'),'utf8')).toBe(source.replace('旧规则','新规则'));
  expect(task.generatedFiles.some(file=>file.fileName.endsWith('validation.json'))).toBe(true);
  const repeated=await dispatch({docType});expect(JSON.parse(repeated.body).skipped).toBe(true);
 });
 it('ignores removed index flags and finishes publication without an index step',async()=>{
  const response=await dispatch({runIndex:true});
  const task=(await getSyncHistory(workspaceId,requirementId))[0];
  expect(response.body).toContain('"type":"done"');
  expect(task).toMatchObject({status:'completed',publishState:'state_committed'});
  expect(task.completedAt).toBeDefined();
  expect(task.steps.map(step=>step.phase)).toEqual(['init','code_analysis','merge','validate','publish']);
  expect(task.steps.every(step=>['completed','skipped'].includes(step.status))).toBe(true);
  expect(await getActiveSync(workspaceId,requirementId)).toBeNull();
  expect(getAbortController(workspaceId,requirementId)).toBeUndefined();
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toBe(source.replace('旧规则','新规则'));
 });
 it('publishes a document that did not exist at preflight',async()=>{
  await rm(join(reqDir,'requirement.md'));
  const response=await dispatch();expect(response.body).toContain('"type":"done"');
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toBe('# 标题\n\n新规则\n');
  expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('completed');
 });
 it('freezes staged, unstaged and untracked source inputs and filters tests',async()=>{
  await writeFile(join(repo,'source.js'),'STAGED');git('add','source.js');await writeFile(join(repo,'source.js'),'UNSTAGED');
  await writeFile(join(repo,'new.ts'),'UNTRACKED');await writeFile(join(repo,'api.test.ts'),'TEST_IGNORED');
  const response=await dispatch();expect(response.body).toContain('"type":"done"');
  const task=(await getSyncHistory(workspaceId,requirementId))[0];
  const input=await readFile(join(reqDir,'sync-logs',task.snapshotDir,'input-code.diff'),'utf8');
  expect(input).toContain('+STAGED');expect(input).toContain('+UNSTAGED');expect(input).toContain('+UNTRACKED');expect(input).not.toContain('TEST_IGNORED');
  for(const request of harness.requests) expect(JSON.stringify(request.prompt)).not.toMatch(/STAGED|UNSTAGED|UNTRACKED/);
 });
 it('publishes using checked commits only and preserves commit-scoped source artifacts',async()=>{
  const chosen=git('rev-parse','HEAD'),base=git('rev-parse','main');
  await writeFile(join(repo,'not-selected.js'),'UNSELECTED_SENTINEL');git('add','not-selected.js');git('commit','-m','unselected');
  const tip=git('rev-parse','HEAD');
  const response=await dispatch({baseBranch:'main',commitHashes:[chosen],branchTip:tip,baseCommit:base,includeWorkingChanges:false});
  expect(response.body).toContain('"type":"done"');
  const task=(await getSyncHistory(workspaceId,requirementId))[0];expect(task.selectedCommitHashes).toEqual([chosen]);
  const input=await readFile(join(reqDir,'sync-logs',task.snapshotDir,'input-code.diff'),'utf8');
  expect(input).toContain('+changed');expect(input).not.toContain('UNSELECTED_SENTINEL');
  const manifest=JSON.parse(await readFile(join(reqDir,'sync-logs',task.snapshotDir,'input/manifest.json'),'utf8'));
  expect(manifest.artifacts.some(a=>a.id==='code.0.selected-commits')).toBe(true);
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toContain('新规则');
 });
 it('does not publish when evidence coverage is incomplete',async()=>{
  harness=createSyncHarness({skipCoverage:true});routes=createSyncRoutes({list:()=>[{id:workspaceId,path:repo}]},{},{},{get:()=>harness.parentAgent},harness.ctx);
  const response=await dispatch();expect(response.body).toContain('EVIDENCE_NOT_FULLY_READ');
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toBe(source);
  expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('failed');
 });
 it('protects a live document edit made during model analysis',async()=>{
  let edited=false;harness=createSyncHarness({onStart:()=>{if(!edited){edited=true;execFileSync('node',['-e',"require('fs').writeFileSync(process.argv[1],'USER_EDIT')",join(reqDir,'requirement.md')]);}}});
  routes=createSyncRoutes({list:()=>[{id:workspaceId,path:repo}]},{},{},{get:()=>harness.parentAgent},harness.ctx);
  const response=await dispatch();expect(response.body).toContain('同步期间主文档已被修改');
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toBe('USER_EDIT');
  expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('failed');
 });
 it('does not read a legacy state or reuse an old successful commit',async()=>{
  await mkdir(join(reqDir,'sync-logs'),{recursive:true});
  await writeFile(join(reqDir,'sync-logs','.sync-state.json'),'{invalid legacy state');
  const response=await dispatch();expect(response.body).toContain('"type":"done"');
  expect(await readFile(join(reqDir,'sync-logs','.sync-state.json'),'utf8')).toBe('{invalid legacy state');
 });
 it('rejects unsupported provider isolation in the first step before spawning',async()=>{
  harness.ctx.subagents.getProvider=()=>({capabilities:{toolFilter:false}});
  const response=await dispatch();expect(response.body).toContain('CAPABILITY_UNSUPPORTED');expect(harness.requests).toHaveLength(0);
  const task=(await getSyncHistory(workspaceId,requirementId))[0];expect(task.steps[0].status).toBe('failed');
  expect(task.status).toBe('failed');expect(task.completedAt).toBeDefined();
  expect(task.steps.every(step=>!['running','queued','pending'].includes(step.status))).toBe(true);
  expect(await getActiveSync(workspaceId,requirementId)).toBeNull();expect(getAbortController(workspaceId,requirementId)).toBeUndefined();
 });
 it('ignores the removed analysis option and finishes at publication without creating metadata',async()=>{
  const response=await dispatch({runAnalysis:true});
  const task=(await getSyncHistory(workspaceId,requirementId))[0];
  expect(task.status).toBe('completed');expect(task.publishState).toBe('state_committed');
  expect(task.steps.some(step=>step.phase==='analysis')).toBe(false);
  expect(task.steps.some(step=>step.phase==='index')).toBe(false);
  expect(task.steps.every(step=>!['pending','running','queued'].includes(step.status))).toBe(true);
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toContain('新规则');
  expect(response.body).toContain('"status":"completed"');
  expect(task.steps.at(-1).phase).toBe('publish');
  await expect(readFile(join(reqDir,'.meta.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(JSON.parse((await dispatch()).body).skipped).toBe(true);
 });
 it('persists all failed chunk statuses and closes later phases after a DSH child failure',async()=>{
  harness.ctx.subagents.start=async()=>({id:'failed-child',result:Promise.resolve({stopReason:'error',output:[],diagnostic:'MODEL_FAILURE'}),dispose:async()=>{}});
  const response=await dispatch();expect(response.body).toContain('MODEL_FAILURE');
  const task=(await getSyncHistory(workspaceId,requirementId))[0];
  expect(task.status).toBe('failed');expect(task.steps.find(step=>step.phase==='code_analysis').chunks[0].status).toBe('failed');
  expect(task.steps.every(step=>!['pending','running','queued'].includes(step.status))).toBe(true);
  expect(await readFile(join(reqDir,'requirement.md'),'utf8')).toBe(source);
 });
 it('archives aborted only after the child run settles and cannot leave running steps behind',async()=>{
  const original=harness.ctx.subagents.start;
  harness.ctx.subagents.start=async(provider,request)=>{
   const run=await original(provider,request);
   // The test wrapper owns the handle until it publishes it back to start().
   void run.result.catch(()=>{});
   const active=await getActiveSync(workspaceId,requirementId);
   await abortSync(active.id,workspaceId,requirementId);
   expect((await getActiveSync(workspaceId,requirementId)).status).toBe('cancelling');
   expect(await getSyncHistory(workspaceId,requirementId)).toHaveLength(0);
   return run;
  };
  await dispatch();const task=(await getSyncHistory(workspaceId,requirementId))[0];
  expect(task.status).toBe('aborted');expect(task.completedAt).toBeDefined();
  expect(task.steps.every(step=>!['pending','running','queued'].includes(step.status))).toBe(true);
  expect(getAbortController(workspaceId,requirementId)).toBeUndefined();
 });
 it('waits for in-flight DSH children to dispose before completing plugin unload',async()=>{
  let started, releaseDispose, disposingChild;
  const published=new Promise(resolve=>{started=resolve;});
  const childDisposing=new Promise(resolve=>{disposingChild=resolve;});
  const cleanup=new Promise(resolve=>{releaseDispose=resolve;});
  harness.ctx.subagents.start=async(_provider,request)=>{
   const result=new Promise(resolve=>request.signal.addEventListener('abort',()=>resolve({stopReason:'aborted',output:[]}),{once:true}));
   started(); return {id:'unload-child',result,dispose:async()=>{disposingChild();await cleanup;}};
  };
  const running=dispatch();await published;
  let unloaded=false;const unload=routes.dispose().then(()=>{unloaded=true;});
  await childDisposing;expect(unloaded).toBe(false);
  expect((await getActiveSync(workspaceId,requirementId)).status).toBe('cancelling');
  releaseDispose();await running;await unload;
  expect((await getSyncHistory(workspaceId,requirementId))[0].status).toBe('aborted');
  expect(getAbortController(workspaceId,requirementId)).toBeUndefined();
 });
});
