import { describe,it,expect,vi,beforeEach,afterEach } from 'vitest';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';import { tmpdir } from 'node:os';import { randomUUID } from 'node:crypto';import { execFileSync } from 'node:child_process';
import { createSyncHarness } from './sync-v2-harness.js';
vi.mock('../../src/server/config.js',()=>({loadConfig:vi.fn().mockResolvedValue({docsDir:'docs',sync:{baseBranch:'main'}})}));
vi.mock('../../src/server/doc-reader.js',()=>({findRequirementDir:async root=>join(root,'2026-10-20-route-test')}));
const {createSyncRoutes}=await import('../../src/server/routes/sync-routes.js');
const {getSyncHistory}=await import('../../src/server/sync-state.js');
let repo,reqDir,routes,workspaceId,harness;
const requirementId='2026-10-20-route-test';
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const source='# 标题\r\n\r\n旧规则\r\n\r\n## 无关\r\n保持  空格\r\n';
async function dispatch(data={}) {
 const listeners={};const req={method:'POST',headers:{'x-session-id':'parent'},url:'/req-hub/phased-sync',on:(name,fn)=>{listeners[name]=fn;}};
 const res={status:200,headersSent:false,body:'',writeHead(status){this.status=status;this.headersSent=true;},write(text){this.body+=text;},end(text=''){this.body+=text;}};
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
afterEach(async()=>{await rm(repo,{recursive:true,force:true});});
describe('v2 sync route integration',()=>{
 it.each(['requirement','design'])('publishes validated %s bytes and successful snapshots',async docType=>{
  const response=await dispatch({docType});expect(response.body).toContain('"type":"done"');
  expect(await readFile(join(reqDir,docType+'.md'),'utf8')).toBe(source.replace('旧规则','新规则'));
  const task=(await getSyncHistory(workspaceId,requirementId))[0];expect(task).toMatchObject({schemaVersion:2,status:'completed',publishState:'state_committed'});
  expect(task.snapshotDir).toMatch(/^v2\//);
  expect(await readFile(join(reqDir,'sync-logs',task.snapshotDir,docType+'.md'),'utf8')).toBe(source.replace('旧规则','新规则'));
  expect(task.generatedFiles.some(file=>file.fileName.endsWith('validation.json'))).toBe(true);
  const repeated=await dispatch({docType});expect(JSON.parse(repeated.body).skipped).toBe(true);
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
 });
});
