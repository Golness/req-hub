import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { defaultSyncBaseBranch, listSyncCommits } from '../../src/server/sync-branches.js';
import { prepareCommitSync, beginCommitSync } from '../../src/server/sync-engine.js';
import { updateSyncProgress, completeSync, getSyncHistory } from '../../src/server/sync-state.js';
import { closeSyncStorages } from '../../src/server/sync-storage.js';
import { createSyncRoutes } from '../../src/server/routes/sync-routes.js';
let repo, base, first, middle, last;
const requirementId = '2026-10-23-commit-picker', branch = `feature/dev/${requirementId}`;
const git = (...args) => execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function commit(file, content, subject) { await writeFile(join(repo,file),content);git('add',file);git('commit','-m',subject);return git('rev-parse','HEAD'); }
beforeEach(async()=>{
 repo=await mkdtemp(join(tmpdir(),'req-hub-commits-'));git('init','-b','main');git('config','user.name','Test');git('config','user.email','test@example.test');
 vi.stubEnv('DSH_HOME',join(repo,'.test-dsh'));
 base=await commit('base.js','BASE','base');git('switch','-c',branch);
 first=await commit('first.js','FIRST_SELECTED','first');middle=await commit('middle.js','MIDDLE_NOT_SELECTED','middle');last=await commit('last.js','LAST_SELECTED','last');
});
afterEach(async()=>{closeSyncStorages();vi.unstubAllEnvs();await rm(repo,{recursive:true,force:true});});
async function get(path) {
 const routes=createSyncRoutes({list:()=>[{id:'ws',path:repo}]});
 const req={method:'GET',url:'/req-hub/'+path},res={body:'',status:200,writeHead(status){this.status=status;},end(body){this.body+=body||'';}};
 try { await routes.find(r=>r.path==='/req-hub/'+path.split('?')[0]).handler(req,res); } finally { await routes.dispose(); }
 return {status:res.status,data:JSON.parse(res.body)};
}

it('prefers main, falls back to master, and returns a manual-entry hint when both are absent',async()=>{
 git('branch','master',base);expect(await defaultSyncBaseBranch(repo)).toBe('main');
 let info=await get(`sync-branch-info?workspaceId=ws&requirementId=${requirementId}`);expect(info.data.baseBranch).toBe('main');
 git('branch','-m','main','trunk');expect(await defaultSyncBaseBranch(repo)).toBe('master');
 info=await get(`sync-branch-info?workspaceId=ws&requirementId=${requirementId}`);expect(info.data.baseBranch).toBe('master');
 git('branch','-D','master');expect(await defaultSyncBaseBranch(repo)).toBeNull();
 info=await get(`sync-branch-info?workspaceId=ws&requirementId=${requirementId}`);expect(info.data.baseBranch).toBeNull();expect(info.data.baseBranchHint).toContain('手动填写');
});
it('lists only commits reachable from target and absent from base, preserving order and metadata',async()=>{
 git('switch','main');const baseOnly=await commit('upstream.js','UPSTREAM_ONLY','base only');git('switch',branch);
 const list=await listSyncCommits(repo,branch,'main');expect(list.commits.map(c=>c.hash)).toEqual([first,middle,last]);expect(list.commits.map(c=>c.hash)).not.toContain(baseOnly);
 expect(list.commits[2]).toMatchObject({shortHash:last.slice(0,8),parent:middle,subject:'last',author:'Test'});
 const response=await get(`sync-commits?workspaceId=ws&requirementId=${requirementId}&baseBranch=main`);expect(response.status).toBe(200);expect(response.data.commits).toHaveLength(3);
 expect((await get(`sync-commits?workspaceId=ws&requirementId=${requirementId}&baseBranch=missing`)).status).toBe(400);
});
it('uses selected commits own parent diffs and never includes a skipped commit or workspace edits',async()=>{
 await writeFile(join(repo,'dirty.js'),'DIRTY_NOT_SELECTED');
 const result=await prepareCommitSync(repo,requirementId,'requirement',[],{baseBranch:'main',commitHashes:[last,first],includeWorkingChanges:false});
 expect(result.commits.map(c=>c.hash)).toEqual([first,last]);expect(result.codeDiff).toContain('FIRST_SELECTED');expect(result.codeDiff).toContain('LAST_SELECTED');expect(result.codeDiff).not.toMatch(/MIDDLE_NOT_SELECTED|DIRTY_NOT_SELECTED/);
 expect(result.sourceSnapshots.map(s=>s.file).sort()).toEqual(['first.js','last.js']);
 expect(result.sourceSnapshots.find(s=>s.file==='last.js').commitChanges[0]).toMatchObject({parent:middle,commitHash:last,base:null,target:'LAST_SELECTED'});
 expect(result.uncommittedChanges.hasChanges).toBe(false);expect(await readFile(join(repo,'dirty.js'),'utf8')).toBe('DIRTY_NOT_SELECTED');
});
it('does not interpret an explicitly empty selection as all commits',async()=>{
 const result=await prepareCommitSync(repo,requirementId,'requirement',[],{baseBranch:'main',commitHashes:[],includeWorkingChanges:false});
 expect(result.commits).toEqual([]);expect(result.codeDiff).toBe('');expect(result.sourceSnapshots).toEqual([]);
});
it('rejects out-of-range, malformed, or stale commit selections',async()=>{
 const options={baseBranch:'main',includeWorkingChanges:false};
 await expect(prepareCommitSync(repo,requirementId,'requirement',[],{...options,commitHashes:[base]})).rejects.toThrow('COMMIT_OUT_OF_RANGE');
 await expect(prepareCommitSync(repo,requirementId,'requirement',[],{...options,commitHashes:'all'})).rejects.toThrow('COMMIT_SELECTION_INVALID');
 await expect(prepareCommitSync(repo,requirementId,'requirement',[],{...options,commitHashes:[first],branchTip:first})).rejects.toThrow('COMMIT_LIST_CHANGED');
 await expect(prepareCommitSync(repo,requirementId,'requirement',[],{...options,commitHashes:[first],baseCommit:last})).rejects.toThrow('COMMIT_LIST_CHANGED');
});
it('records partial selections independently and leaves unselected commits available for later sync',async()=>{
 const reqDir=join(repo,'docs',requirementId);await mkdir(reqDir,{recursive:true});
 const fields={workspaceId:randomUUID(),requirementId,docType:'requirement',baseBranch:'main',includeWorkingChanges:false};
 const a=await beginCommitSync(repo,reqDir,{...fields,commitHashes:[first]});
 await updateSyncProgress(a.sync.id,{status:'completed'},fields.workspaceId,requirementId);await completeSync(a.sync.id,fields.workspaceId,requirementId);
 const b=await beginCommitSync(repo,reqDir,{...fields,commitHashes:[last]});expect(b.skipped).not.toBe(true);expect(b.sync.id).not.toBe(a.sync.id);expect(b.commits.map(c=>c.hash)).toEqual([last]);
 await updateSyncProgress(b.sync.id,{status:'completed'},fields.workspaceId,requirementId);await completeSync(b.sync.id,fields.workspaceId,requirementId);
 expect((await beginCommitSync(repo,reqDir,{...fields,commitHashes:[first]})).skipped).toBe(true);
 const history=await getSyncHistory(fields.workspaceId,requirementId);
 expect((await prepareCommitSync(repo,requirementId,'requirement',history,{baseBranch:'main'})).skipped).not.toBe(true);
 expect(history.map(h=>h.selectedCommitHashes)).toEqual([[last],[first]]);
});
