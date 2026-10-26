import{it,expect,beforeEach,afterEach}from'vitest';import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,utimesSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{SyncStorage}from'../../src/server/sync-storage.js';import{SyncArtifacts}from'../../src/server/sync-artifacts.js';
let root,store,scope,workspace;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'reqhub-cas-'));workspace={id:'ws',path:join(root,'project')};mkdirSync(workspace.path);store=new SyncStorage(join(root,'sync'));scope=store.bind(workspace,'req',workspace.path);store.retire(scope);});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
const start=(taskId='selection')=>{const task={workspaceId:'ws',requirementId:'req',taskId,status:'running',startedAt:Date.now()};store.start(scope,task);return task;};
const finish=task=>{task.status='failed';store.save(task);};
it('deduplicates exact UTF-8 bytes across attempts and does not collect a live reference',()=>{
 const first=start();store.putEvidence(first,'doc','中文\r\n😀');finish(first);const second=start();store.putEvidence(second,'doc','中文\r\n😀');expect(store.usage(scope.workspaceKey).objectCount).toBe(1);store.remove(first);store.cleanup(first);expect(store.collect(scope.workspaceKey,0).objects).toBe(0);expect(store.readEvidence(second,'doc')).toBe('中文\r\n😀');store.remove(second);expect(store.collect(scope.workspaceKey,0).objects).toBe(1);
});
it('deduplicates source versions, reconstructs exact JSON and lossless composite fragments',async()=>{
 const task=start(),artifacts=await new SyncArtifacts(store.attemptRoot(task),{storage:store,task}).init();const value={file:'src/a.js',base:'相同内容',target:'相同内容',final:'不同内容'};await artifacts.putJSON('source',value);expect(await artifacts.read('source')).toBe(JSON.stringify(value));expect(store.usage(scope.workspaceKey).objectCount).toBe(2);
 await artifacts.put('full','头部\r\n一二三😀\n尾部');await artifacts.putSegments('part',['标签\n',{sourceId:'full',start:4,end:9}],'标签\n'+(await artifacts.read('full')).slice(4,9));expect(await artifacts.read('part')).toBe('标签\n'+(await artifacts.read('full')).slice(4,9));const metadata={source:'full',start:4,end:9,part:1};const rendered=JSON.stringify({...metadata,text:(await artifacts.read('full')).slice(4,9)});await artifacts.putFragment('fragment','full',metadata,rendered);expect(await artifacts.read('fragment')).toBe(rendered);finish(task);
});
it('isolates identical workspace IDs at different paths and preserves identity when renamed',()=>{
 const other=join(root,'other');mkdirSync(other);const second=store.bind({id:'ws',path:other},'req',other);expect(second.workspaceKey).not.toBe(scope.workspaceKey);expect(store.bind({...workspace,title:'renamed'},'req',workspace.path).workspaceKey).toBe(scope.workspaceKey);
});
it('authorizes artifact IDs by execution and fences writes after deletion',()=>{
 const old=start();store.putEvidence(old,'doc','OLD');const artifact=store.artifact(old,'doc.md',{logicalId:'doc'});finish(old);const next=start();expect(()=>store.readArtifact(next,artifact.artifactId)).toThrow('NOT_FOUND');expect(store.readArtifact(old,artifact.artifactId).text).toBe('OLD');store.remove(old);expect(()=>store.readArtifact(old,artifact.artifactId)).toThrow('NOT_FOUND');expect(()=>store.putEvidence(old,'late','LATE')).toThrow('REVOKED');expect(()=>store.file(next,'../x')).toThrow('NAME');finish(next);
});
it('serializes independent database owners and prevents foreign active deletion',()=>{
 const task=start(),other=new SyncStorage(store.root);
 try{expect(()=>other.start(scope,{status:'running'})).toThrow('BUSY');expect(()=>other.remove(task)).toThrow('BUSY');expect(other.state(scope).activeSync.id).toBe(task.id);store.heartbeat();expect(other.live(task)).toBe(true);}finally{other.close();}finish(task);
});
it('retains all retries and removes an entire task without removing another selection',()=>{
 const one=start();finish(one);const two=start();finish(two);const three=start('other');finish(three);const removed=store.remove(one,{wholeTask:true});expect(removed.map(task=>task.id)).toEqual([one.id,two.id]);expect(store.state(scope).history.map(task=>task.id)).toEqual([three.id]);
});
it('uses opt-in retention and protects the latest successful document baseline',()=>{
 const one=start();one.status='completed';one.publishState='state_committed';one.docType='requirement';store.save(one);const two=start();two.status='completed';two.publishState='state_committed';two.docType='requirement';store.save(two);const failed=start();failed.startedAt=1;finish(failed);expect(store.prune(scope.workspaceKey)).toEqual([]);expect(store.prune(scope.workspaceKey,{retainedAttempts:1}).map(task=>task.id)).toContain(one.id);expect(store.state(scope).history.some(task=>task.id===two.id)).toBe(true);
});
it('collects crash orphans only after the grace period and counts bytes once',()=>{
 const task=start();store.putEvidence(task,'a','ACTIVE');const orphan=store.objectPath(scope.workspaceKey,'a'.repeat(64));mkdirSync(join(orphan,'..'),{recursive:true});writeFileSync(orphan,'ORPHAN');expect(store.collect(scope.workspaceKey).objects).toBe(0);utimesSync(orphan,new Date(0),new Date(0));expect(store.collect(scope.workspaceKey).bytes).toBe(6);expect(existsSync(orphan)).toBe(false);expect(store.usage(scope.workspaceKey).objectBytes).toBe(6);finish(task);
});
it('rejects symbolic storage objects instead of following external targets',()=>{
 const task=start();store.putEvidence(task,'a','SAFE');const row=store.db.prepare('SELECT hash FROM objects').get(),path=store.objectPath(scope.workspaceKey,row.hash),external=join(root,'external');writeFileSync(external,'SAFE');rmSync(path);symlinkSync(root,path,'junction');expect(()=>store.readEvidence(task,'a')).toThrow('LINK');expect(()=>store.collect(scope.workspaceKey,0)).toThrow('LINK');expect(readFileSync(external,'utf8')).toBe('SAFE');finish(task);
});
