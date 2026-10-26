import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile,readFile,access,readdir,symlink,link} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {ConversationStore,hash} from '../../src/server/conversations/store.js';
import {ConversationService} from '../../src/server/conversations/service.js';
import {createConversationRoutes} from '../../src/server/routes/conversation-routes.js';
import {createOperations} from '../../src/server/operations.js';
import {withDocumentLock} from '../../src/server/sync-document-validator.js';
let root,store,library;
const turn=(number,text='content')=>({sessionId:'one',turnNumber:number,syncable:true,messages:[{role:'user',kind:'input',text:'question '+number},{role:'assistant',kind:'intermediate',text:'analysis '+number},{role:'assistant',kind:'final',text}]});
const snapshot=turns=>({sessionId:'one',version:hash(JSON.stringify(turns)),turns,turnCount:turns.length,syncTurnCount:turns.length,totalTokens:10});
const adapter=()=>({source:'dsh',instance:'profile-a',inventory:async()=>({workspaces:[{id:'project'}],sessions:[{id:'one',title:'Title',workspaceId:'project'}],warnings:[]}),snapshot:async()=>snapshot([turn(1)])});
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'rh-conv-retention-'));store=new ConversationStore(join(root,'library/conversations.sqlite'));library=new ConversationService({store,owner:'profile-a'});});
afterEach(async()=>{await library.close();await store.close();vi.useRealTimers();await rm(root,{recursive:true,force:true});});
it('shares unchanged turns across growing full versions and writes only one Markdown projection',async()=>{
 const provider=adapter(),turns=[];for(let i=1;i<=12;i++){turns.push(turn(i,'LARGE_BODY'.repeat(400)));provider.snapshot=async()=>snapshot([...turns]);await library.refresh('ws','project',provider);}
 const entry=(await library.list('ws',provider)).sessions[0],db=await store.database();expect(db.prepare('SELECT count(*) n FROM objects').get().n).toBe(12);expect(db.prepare('SELECT count(*) n FROM snapshots').get().n).toBe(12);
 expect(db.prepare('SELECT payload FROM snapshots LIMIT 1').get().payload).not.toContain('LARGE_BODY');
 const directory=join(root,'library',entry.markdownFile,'..');expect(await readdir(directory)).toEqual(['current.md']);const old=(await store.versions(entry.conversationId)).at(-1);expect((await store.project(entry.conversationId,old.version)).turns).toHaveLength(1);expect(await readFile(join(root,'library',entry.markdownFile),'utf8')).toContain('question 12');expect(await readdir(directory)).toEqual(['current.md']);
 const usage=await store.usage([entry.scopeId].filter(Boolean));expect(usage.conversations).toBe(0);
 await library.refresh('ws','project',provider);expect(db.prepare('SELECT count(*) n FROM objects').get().n).toBe(12);
});
it('prunes old unreferenced versions, preserves current and pinned data, and collects released objects',async()=>{
 const provider=adapter(),entries=[];for(let i=0;i<5;i++){provider.snapshot=async()=>snapshot([turn(1,'version '+i)]);entries.push((await library.refresh('ws','project',provider)).sessions[0]);}
 await store.pin('sync-task',[{conversationId:entries[0].conversationId,version:entries[0].snapshotVersion}]);const scope=(await store.binding('profile-a','ws','dsh')).id;
 const result=await store.maintain([scope],{retainedVersions:1,graceHours:0});expect(result.versions).toBe(3);expect((await store.versions(entries[0].conversationId)).map(row=>row.version).sort()).toEqual([entries[0].snapshotVersion,entries[4].snapshotVersion].sort());expect((await store.project(entries[0].conversationId,entries[0].snapshotVersion)).turns[0].messages.at(-1).text).toBe('version 0');
 await expect(store.remove(entries[0].conversationId)).rejects.toThrow('IN_USE');await store.unpin('sync-task',{retainedVersions:1,graceHours:0});expect((await store.versions(entries[0].conversationId))).toHaveLength(1);expect((await store.database()).prepare('SELECT count(*) n FROM objects').get().n).toBe(1);
});
it('keeps recently selected historical versions during the grace window',async()=>{
 const provider=adapter(),first=(await library.refresh('ws','project',provider)).sessions[0];provider.snapshot=async()=>snapshot([turn(1,'NEW')]);await library.refresh('ws','project',provider);const scope=(await store.binding('profile-a','ws','dsh')).id;await store.maintain([scope],{retainedVersions:1});expect(await store.versions(first.conversationId)).toHaveLength(2);await store.pin('selected',[{conversationId:first.conversationId,version:first.snapshotVersion}]);
});
it('expires missing sessions only after retention, never deletes pinned content, and clears missing age on return',async()=>{
 const provider=adapter(),first=(await library.refresh('ws','project',provider)).sessions[0],frozen=await library.snapshot('ws','one',provider);await store.pin('task',[frozen]);const inventory=provider.inventory;provider.inventory=async()=>({workspaces:[{id:'project'}],sessions:[],warnings:[]});await library.refresh('ws','project',provider);const db=await store.database(),scope=(await store.binding('profile-a','ws','dsh')).id;db.prepare('UPDATE conversations SET missing_at=0').run();await store.maintain([scope],{graceHours:0});expect(await store.versions(first.conversationId)).toHaveLength(1);provider.inventory=inventory;await library.refresh('ws','project',provider);expect((await store.find(scope,'one')).missing_at).toBeNull();await store.unpin('task');provider.inventory=async()=>({workspaces:[{id:'project'}],sessions:[],warnings:[]});await library.refresh('ws','project',provider);db.prepare('UPDATE conversations SET missing_at=0').run();await store.maintain([scope],{graceHours:0});expect(await store.versions(first.conversationId)).toHaveLength(0);await expect(access(join(root,'library',first.markdownFile))).rejects.toMatchObject({code:'ENOENT'});
});
it('bounds refresh job history independently of source workspace access',async()=>{
 library.policy=async()=>({retainedJobs:2});const provider=adapter();for(const project of ['old','new','new','new']){provider.inventory=async()=>({workspaces:[{id:project}],sessions:[{id:'one',workspaceId:project}],warnings:[]});await library.refresh('ws',project,provider);}
 const db=await store.database();expect(db.prepare('SELECT count(*) n FROM jobs').get().n).toBe(2);expect((await library.accessible('ws',[provider]))).toHaveLength(2);
 db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('live','',JSON.stringify({owner:'profile-a',workspaceId:'ws',status:'running',updatedAt:'2000-01-01'}));await library.storage('ws',[provider],true);expect(db.prepare('SELECT 1 FROM jobs WHERE id=?').get('live')).toBeTruthy();
});
it('protects references held by another SQLite connection during collection',async()=>{
 const provider=adapter(),first=(await library.refresh('ws','project',provider)).sessions[0];provider.snapshot=async()=>snapshot([turn(1,'new')]);await library.refresh('ws','project',provider);const other=new ConversationStore(store.path);try{await other.pin('foreign',[{conversationId:first.conversationId,version:first.snapshotVersion}]);await library.storage('ws',[provider],true);await store.maintain([(await store.binding('profile-a','ws','dsh')).id],{retainedVersions:1,graceHours:0});expect((await other.project(first.conversationId,first.snapshotVersion)).turns[0].messages.at(-1).text).toBe('content');}finally{await other.close();}
});
it('does not commit an acquisition cancelled while waiting for a document operation',async()=>{
 const provider=adapter();await library.refresh('ws','project',provider);let release,entered;const ready=new Promise(resolve=>{entered=resolve;});const lock=withDocumentLock(store.path,()=>new Promise(resolve=>{release=resolve;entered();}));await ready;const controller=new AbortController();const pending=store.put((await store.binding('profile-a','ws','dsh')).id,{id:'never'},snapshot([turn(2)]),{signal:controller.signal});controller.abort();release();await lock;await expect(pending).rejects.toThrow();expect((await library.list('ws',provider)).sessions.map(row=>row.id)).toEqual(['one']);
});
it('exposes authenticated workspace capacity and cleanup through the shared Host operation',async()=>{
 const provider=adapter();await library.refresh('ws','project',provider);const operations=createOperations(createConversationRoutes({list:()=>[{id:'ws'},{id:'unbound'}]},library,[provider]));const stats=await operations.execute({action:'conversations-storage',query:{workspaceId:'ws'}},{});expect(stats.value.usage).toMatchObject({conversations:1,versions:1,objectCount:1});expect(stats.value.usage.objectBytes).toBeGreaterThan(0);expect((await operations.execute({action:'conversations-storage',query:{workspaceId:'unbound'}},{})).value.usage.conversations).toBe(0);expect((await operations.execute({action:'conversations-cleanup',method:'POST',body:{workspaceId:'ws'}},{})).value.success).toBe(true);expect((await operations.execute({action:'conversations-cleanup',method:'POST',body:{workspaceId:'foreign'}},{})).status).toBe(404);
});
it('clears the old schema and Markdown once without importing history or touching knowledge and sources',async()=>{
 await store.close();await mkdir(join(root,'library/documents/old/versions'),{recursive:true});await writeFile(join(root,'library/documents/old/versions/old.md'),'OLD');await writeFile(join(root,'knowledge.md'),'KNOWLEDGE');await writeFile(join(root,'source.jsonl'),'SOURCE');const old=new DatabaseSync(store.path);old.exec("CREATE TABLE scopes(id TEXT);CREATE TABLE snapshots(payload TEXT);INSERT INTO snapshots VALUES('OLD BODY');CREATE TABLE jobs(payload TEXT);PRAGMA user_version=1;");old.close();const db=await store.database();expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);expect(db.prepare('SELECT count(*) n FROM snapshots').get().n).toBe(0);await expect(access(join(root,'library/documents'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(root,'knowledge.md'),'utf8')).toBe('KNOWLEDGE');expect(await readFile(join(root,'source.jsonl'),'utf8')).toBe('SOURCE');await library.refresh('ws','project',adapter());await store.close();await store.database();expect((await store.database()).prepare('SELECT count(*) n FROM snapshots').get().n).toBe(1);
});
it('rejects an old documents junction and retries retirement after the boundary is repaired',async()=>{
 await store.close();await mkdir(join(root,'library'),{recursive:true});const old=new DatabaseSync(store.path);old.exec('PRAGMA user_version=1;');old.close();const external=join(root,'outside');await mkdir(external);await writeFile(join(external,'keep'),'KEEP');await symlink(external,join(root,'library/documents'),'junction');await expect(store.database()).rejects.toThrow('LINK');expect(await readFile(join(external,'keep'),'utf8')).toBe('KEEP');await rm(join(root,'library/documents'),{force:true});await store.database();expect((await store.database()).prepare('PRAGMA user_version').get().user_version).toBe(2);
});

it('keeps partially imported conversations accessible after cancellation and job cleanup',async()=>{
 const provider=adapter();let release,entered;const ready=new Promise(resolve=>{entered=resolve;});provider.inventory=async()=>({workspaces:[{id:'project'}],sessions:[{id:'one',workspaceId:'project'},{id:'two',workspaceId:'project'}],warnings:[]});provider.snapshot=async session=>{if(session.id==='two')await new Promise(resolve=>{release=resolve;entered();});return snapshot([turn(1)]);};
 const pending=library.refresh('ws','project',provider);await ready;library.cancel('ws');release();await expect(pending).rejects.toThrow('CANCELLED');const db=await store.database();db.exec('DELETE FROM jobs');expect((await library.accessible('ws',[provider])).map(row=>row.id)).toEqual(['one']);expect((await library.list('ws',provider)).workspace).toBeNull();
});
it('runs scheduled maintenance and releases its timer on shutdown',async()=>{
 vi.useFakeTimers();const provider=adapter();await library.refresh('ws','project',provider);const maintain=vi.spyOn(store,'maintain');await vi.advanceTimersByTimeAsync(15*60000);expect(maintain).toHaveBeenCalled();await library.close();const count=maintain.mock.calls.length;await vi.advanceTimersByTimeAsync(30*60000);expect(maintain).toHaveBeenCalledTimes(count);vi.useRealTimers();
});
it('retires orphaned old projections even when the old database is absent',async()=>{
 await mkdir(join(root,'library/documents/old/versions'),{recursive:true});await writeFile(join(root,'library/documents/old/versions/body.md'),'ORPHAN');await store.database();await expect(access(join(root,'library/documents'))).rejects.toMatchObject({code:'ENOENT'});await library.refresh('ws','project',adapter());expect((await library.list('ws',adapter())).sessions).toHaveLength(1);
});
it('rejects a hard-linked database before destructive retirement can affect its external inode',async()=>{
 await mkdir(join(root,'library'),{recursive:true});const external=join(root,'outside.sqlite'),db=new DatabaseSync(external);db.exec("CREATE TABLE snapshots(payload TEXT);INSERT INTO snapshots VALUES('KEEP');PRAGMA user_version=1;");db.close();await link(external,store.path);await expect(store.database()).rejects.toThrow('LINK');const verify=new DatabaseSync(external);try{expect(verify.prepare('SELECT payload FROM snapshots').get().payload).toBe('KEEP');}finally{verify.close();}
});
