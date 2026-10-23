import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir}from'node:os';import{join}from'node:path';
import {SyncArtifacts,hashBytes}from'../../src/server/sync-artifacts.js';
import {installSyncTools,assertSyncCapabilities,OUTPUT_LIMIT}from'../../src/server/sync-controlled-tools.js';
import {indexDocument}from'../../src/server/sync-document-validator.js';
import{createSyncHarness}from'./sync-v2-harness.js';
async function fixture(action){const root=await mkdtemp(join(tmpdir(),'req-hub-tool-scope-'));try{const h=createSyncHarness(),store=await new SyncArtifacts(join(root,'input')).init(),installation=installSyncTools(h.ctx);await action({root,h,store,installation});}finally{await rm(root,{recursive:true,force:true});}}
async function bind(h,runtime,extra=''){for(const hook of h.hooks.get('llm/stream')) for await(const _ of hook({sessionId:runtime.id,messages:[{role:'user',content:[{type:'text',text:'REQHUB_SYNC_V2='+runtime.id+extra}]}],tools:[{name:'req_hub_sync_read'}]},async function*(){})) {}}
const call=(h,runtime,name,args)=>h.definitions.get(name).execute(args,{name,agent:{session:{id:runtime.id}},signal:new AbortController().signal});
describe('sync v2 controlled evidence access',()=>{
 it('keeps a bounded 12KB output contract',()=>expect(OUTPUT_LIMIT).toBe(12000));
 it('denies a normal agent access to the sync artifact tools',async()=>fixture(async({h})=>{
  await expect(h.definitions.get('req_hub_sync_read').execute({artifactId:'secret'},{agent:{session:{id:'other'}}})).rejects.toThrow('DENIED');
 }));
 it('checks actual LLM messages before sending an oversized request',async()=>fixture(async({h,store,installation})=>{
  const runtime=installation.create({store,allowed:[],required:[],outputs:{}});
  await expect(bind(h,runtime,'x'.repeat(150000))).rejects.toThrow('BUDGET');runtime.close();
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
 it('uses the declared block and rolls back an edit to another authorized block',async()=>fixture(async({root,h,store,installation})=>{
  const originalBytes=Buffer.from('# 标题\n\n旧规则\n\n## 其他\n另一个\n'),blocks=indexDocument(originalBytes),candidatePath=join(root,'candidate.md');await writeFile(candidatePath,originalBytes);
  const changes=blocks.filter(b=>b.type==='paragraph').map(b=>({blockId:b.id}));
  const runtime=installation.create({store,allowed:[],required:[],outputs:{},candidatePath,originalBytes,fileName:'requirement.md',changes,blocks});await bind(h,runtime);
  await expect(call(h,runtime,'req_hub_sync_edit',{blockId:changes[0].blockId,expectedHash:hashBytes(originalBytes),oldText:'另一个',newText:'BAD'})).rejects.toThrow('BLOCK_MISMATCH');
  expect(await readFile(candidatePath)).toEqual(originalBytes);runtime.close();
 }));
 it('fails preflight rather than falling back to unrestricted tools',()=>{const{ctx}=createSyncHarness();ctx.subagents.getProvider=()=>({capabilities:{toolFilter:false}});expect(()=>assertSyncCapabilities(ctx)).toThrow('CAPABILITY_UNSUPPORTED');});
});
