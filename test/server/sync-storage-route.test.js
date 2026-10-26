import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm,access} from 'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import{Readable}from'node:stream';import{createSyncRoutes}from'../../src/server/routes/sync-routes.js';
import{closeSyncStorages}from'../../src/server/sync-storage.js';
vi.mock('../../src/server/config.js',()=>({loadConfig:async()=>({docsDir:'docs'})}));
let root,routes;
afterEach(async()=>{await routes?.dispose();routes=null;closeSyncStorages();vi.unstubAllEnvs();if(root)await rm(root,{recursive:true,force:true});});
async function request(method,workspaceId='ws'){
 const route=routes.find(item=>item.path==='/req-hub/sync-storage'),req=method==='POST'?Readable.from([JSON.stringify({workspaceId})]):{};req.method=method;req.url='/req-hub/sync-storage?'+new URLSearchParams({workspaceId});const res={body:'',writeHead(status){this.status=status;},end(text){this.body+=text||'';}};await route.handler(req,res);return{status:res.status,data:JSON.parse(res.body)};
}
it('returns zero storage and permits safe collection before a documents directory exists',async()=>{
 root=await mkdtemp(join(tmpdir(),'reqhub-empty-stats-'));vi.stubEnv('DSH_HOME',join(root,'home'));routes=createSyncRoutes({list:()=>[{id:'ws',path:root}]});
 expect(await request('GET')).toMatchObject({status:200,data:{success:true,usage:{physicalBytes:0,objectCount:0}}});expect(await request('POST')).toMatchObject({status:200,data:{success:true,collected:{objects:0,bytes:0}}});await expect(access(join(root,'docs'))).rejects.toMatchObject({code:'ENOENT'});
});
it('reports the stable code for a workspace that no longer exists',async()=>{
 root=await mkdtemp(join(tmpdir(),'reqhub-missing-stats-'));vi.stubEnv('DSH_HOME',join(root,'home'));routes=createSyncRoutes({list:()=>[{id:'ws',path:root}]});expect(await request('GET','deleted')).toMatchObject({status:404,data:{error:'SYNC_WORKSPACE_NOT_FOUND'}});
});
