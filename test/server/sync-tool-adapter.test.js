import {bindOwnedSession} from '../../src/server/delegation-context.js';
import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir}from'node:os';import{join}from'node:path';
import {SyncArtifacts,hashBytes}from'../../src/server/sync-artifacts.js';
import {installSyncTools,assertSyncCapabilities,OUTPUT_LIMIT}from'../../src/server/sync-controlled-tools.js';
import {indexDocument}from'../../src/server/sync-document-validator.js';
import{createSyncHarness}from'./sync-v2-harness.js';
async function fixture(action){const root=await mkdtemp(join(tmpdir(),'req-hub-tool-scope-'));try{const h=createSyncHarness(),store=await new SyncArtifacts(join(root,'input')).init(),installation=installSyncTools(h.ctx);await action({root,h,store,installation});}finally{await rm(root,{recursive:true,force:true});}}
async function bind(h,runtime,extra=''){bindOwnedSession(runtime,runtime.id);for(const hook of h.hooks.get('llm/stream')) for await(const _ of hook({sessionId:runtime.id,messages:[{role:'user',content:[{type:'text',text:'REQHUB_SYNC_V2='+runtime.id+extra}]}],tools:[{name:'req_hub_sync_read'}]},async function*(){})) {}}
const call=(h,runtime,name,args)=>h.definitions.get(name).execute(args,{name,agent:{session:{id:runtime.id}},signal:new AbortController().signal});
describe('sync v2 controlled evidence access',()=>{
 it('keeps a bounded 12KB output contract',()=>expect(OUTPUT_LIMIT).toBe(12000));
 it('denies a normal agent access to the sync artifact tools',async()=>fixture(async({h})=>{
  await expect(h.definitions.get('req_hub_sync_read').execute({artifactId:'secret'},{agent:{session:{id:'other'}}})).rejects.toThrow('DENIED');
 }));
 it('checks actual LLM messages before sending an oversized request',async()=>fixture(async({h,store,installation})=>{
  const runtime=installation.create({store,allowed:[],required:[],outputs:{}});
  await expect(bind(h,runtime,'x'.repeat(450000))).rejects.toThrow('BUDGET');runtime.close();
 }));
 it('requires contiguous full reads and verifies artifact hashes',async()=>fixture(async({root,h,store,installation})=>{
  await store.put('evidence','abcdef');const runtime=installation.create({store,allowed:['evidence'],required:['evidence'],outputs:{}});await bind(h,runtime);
  await expect(call(h,runtime,'req_hub_sync_read',{artifactId:'evidence',offset:2,limit:2})).rejects.toThrow('GAP');
  await call(h,runtime,'req_hub_sync_read',{artifactId:'evidence',offset:0,limit:2});await expect(runtime.assertCoverage()).rejects.toThrow('NOT_FULLY_READ');
  await call(h,runtime,'req_hub_sync_read',{artifactId:'evidence',offset:2,limit:8});await runtime.assertCoverage();
  await writeFile(join(root,'input',store.entries.get('evidence').file),'changed');
  await expect(call(h,runtime,'req_hub_sync_read',{artifactId:'evidence',offset:0,limit:8})).rejects.toThrow('HASH_MISMATCH');runtime.close();
 }));
 it('refuses a read before returning bytes that exceed the running budget',async()=>fixture(async({h,store,installation})=>{
  await store.put('evidence','x'.repeat(8000));const runtime=installation.create({store,allowed:['evidence'],required:['evidence'],outputs:{}});await bind(h,runtime);runtime.contextCost=145000;
  await expect(call(h,runtime,'req_hub_sync_read',{artifactId:'evidence',offset:0,limit:8000})).rejects.toThrow('BUDGET');expect(runtime.coverage.size).toBe(0);runtime.close();
 }));
 it('bounds serialized pages and reads optional ranges without claiming skipped text was read',async()=>fixture(async({h,store,installation})=>{
  const text='"\\\n中文'.repeat(4000);await store.put('context',text);
  const runtime=installation.create({store,allowed:['context'],required:[],outputs:{},budget:{limit:150000,optionalContextTokens:25000}});await bind(h,runtime);
  const page=await call(h,runtime,'req_hub_sync_read',{artifactId:'context',offset:1000,limit:8000});
  expect(Array.from(JSON.stringify(page)).length).toBeLessThan(8192);expect(page.nextOffset).toBeLessThan(9000);
  expect(runtime.coverage.get('context')).toBe(0);
  await call(h,runtime,'req_hub_sync_read',{artifactId:'context',offset:0,limit:1000});
  expect(runtime.coverage.get('context')).toBe(page.nextOffset);
  runtime.close();
 }));
 it('stops optional context at its allowance and leaves required evidence readable',async()=>fixture(async({h,store,installation})=>{
  await store.put('required','needed');await store.put('context','x'.repeat(4000));
  const runtime=installation.create({store,allowed:['required','context'],required:['required'],outputs:{},budget:{limit:150000,optionalContextTokens:500}});await bind(h,runtime);
  await expect(call(h,runtime,'req_hub_sync_read',{artifactId:'context'})).rejects.toThrow('OPTIONAL_CONTEXT_BUDGET');
  expect(runtime.coverage.has('context')).toBe(false);
  await call(h,runtime,'req_hub_sync_read',{artifactId:'required'});await runtime.assertCoverage();runtime.close();
 }));
 it('uses the actual routed model and Host token measurement on each child request',async()=>fixture(async({h,store,installation})=>{
  const llm={resolveModelInfo:async()=>({context:{contextWindow:64000}})};
  h.ctx.get=name=>name==='llm'?llm:undefined;
  h.ctx.agents={get:()=>({session:{},ctx:{get:name=>name==='tokenMeter'?{measure:()=>({totalTokens:60000})}:undefined}})};
  const runtime=installation.create({store,allowed:[],required:[],outputs:{}});bindOwnedSession(runtime,runtime.id);
  for(const hook of h.hooks.get('llm/stream')) {
   const invoke=async()=>{for await(const _ of hook({sessionId:runtime.id,provider:'p',model:'small',maxTokens:8000,messages:[]},async function*(){})) {}};
   await expect(invoke()).rejects.toThrow('REQUEST_BUDGET');
  }
  expect(runtime.inputLimit).toBe(50400);runtime.close();
 }));
 it('does not publish evidence after owned-session pruning and ignores unrelated sessions',async()=>fixture(async({h,store,installation})=>{
  await store.put('evidence','needed');const runtime=installation.create({store,allowed:['evidence'],required:['evidence'],outputs:{}});await bind(h,runtime);
  await call(h,runtime,'req_hub_sync_read',{artifactId:'evidence'});
  for(const listener of h.hooks.get('session/event')) listener({id:'unrelated'},{type:'compaction/prune'});
  await runtime.assertCoverage();
  for(const listener of h.hooks.get('session/event')) listener({id:runtime.id},{type:'compaction/summary'});
  await expect(runtime.assertCoverage()).rejects.toThrow('EVIDENCE_COMPACTED');runtime.close();
 }));
 it('uses the declared block and rolls back an edit to another authorized block',async()=>fixture(async({root,h,store,installation})=>{
  const originalBytes=Buffer.from('# 标题\n\n旧规则\n\n## 其他\n另一个\n'),blocks=indexDocument(originalBytes),candidatePath=join(root,'candidate.md');await writeFile(candidatePath,originalBytes);
  const changes=blocks.filter(b=>b.type==='paragraph').map(b=>({blockId:b.id}));
  const runtime=installation.create({store,allowed:[],required:[],outputs:{},candidatePath,originalBytes,fileName:'requirement.md',changes,blocks});await bind(h,runtime);
  await expect(call(h,runtime,'req_hub_sync_edit',{blockId:changes[0].blockId,expectedHash:hashBytes(originalBytes),oldText:'另一个',newText:'BAD'})).rejects.toThrow('BLOCK_MISMATCH');
  expect(await readFile(candidatePath)).toEqual(originalBytes);runtime.close();
 }));
 it('fails preflight rather than falling back to unrestricted tools',()=>{const{ctx}=createSyncHarness();ctx.subagents.getProvider=()=>({capabilities:{toolFilter:false}});expect(()=>assertSyncCapabilities(ctx)).toThrow('CAPABILITY_UNSUPPORTED');});
});
