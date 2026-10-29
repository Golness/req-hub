import { WikiService } from '../knowledge/wiki/service.js';
import { bounded, digest, fail, now } from '../knowledge/wiki/store.js';
import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig } from '../config.js';
import { json, readBody } from '../utils.js';

/** Wiki routes share one service with UI actions, operation tools, and ingestion. */
export function createWikiRoutes(knowledge,ctx,options={}) {
  const service=options.service||new WikiService({knowledge,ctx,configLoader:options.configLoader||loadConfig,runTask:options.runTask});
  const requests=new Set(),pending=new Set();let closing=false;
  let settingsWrite=Promise.resolve();
  const dispatch=async(req,res)=>{
    try{
      if(closing)fail('WIKI_CLOSED',503);
      const url=new URL(req.url,'http://localhost'),path=url.pathname.slice('/req-hub/knowledge/wiki'.length);
      const input=['POST','PUT','DELETE'].includes(req.method)?JSON.parse(await readBody(req)):Object.fromEntries(url.searchParams);
      if(!input||typeof input.workspaceId!=='string')fail('WIKI_INVALID_INPUT');
      const scope=await knowledge.scope(input.workspaceId),db=service.database();
      await knowledge.refreshSources(scope);
      const method=req.method,id=path.split('/')[2],action=path.split('/')[3];
      const limit=input.limit===undefined?30:Number(input.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('WIKI_INVALID_INPUT');
      const sessionId=req.operationExec?.agent?.session?.id||req.headers?.['x-session-id'];
      const userOnly=()=>{if(req.operationExec)fail('WIKI_USER_REQUIRED',403);};
      if(method==='GET'&&path==='/settings'){const values=await service.settings();return json(res,{values,version:digest(values)});}
      if(method==='PUT'&&path==='/settings'){
        const update=settingsWrite.catch(()=>{}).then(async()=>{
          const values=await service.settings();if(input.expectedVersion!==digest(values))fail('WIKI_VERSION_CONFLICT',409);
          if(!input.values||typeof input.values!=='object'||Array.isArray(input.values)||Object.keys(input.values).some(key=>!(key in values)))fail('WIKI_INVALID_INPUT');
          const config=await (options.configLoader||loadConfig)();await (options.configSaver||saveConfig)({...config,wiki:{...values,...input.values}});
          const saved=await service.settings();return {values:saved,version:digest(saved)};
        });settingsWrite=update;return json(res,await update);
      }
      if(method==='GET'&&path==='/index')return json(res,await service.index(scope,input.cursor||'',limit));
      if(method==='POST'&&path==='/projection'){await service.project(scope);return json(res,{status:'succeeded'});}
      if(method==='GET'&&path==='/search')return json(res,service.search(scope,input.q||'',limit,input.cursor||''));
      if(method==='GET'&&path==='/changelog'){
        const cursor=Number(input.cursor)||0;if(!Number.isSafeInteger(cursor)||cursor<0)fail('WIKI_INVALID_INPUT');return json(res,db.logs(scope.identity,cursor,limit));
      }
      if(method==='GET'&&path==='/pages')return json(res,db.pages(scope.identity,input.cursor||'',limit));
      if(method==='GET'&&path==='/scopes'){
        const items=[];for(const origin of knowledge.database().scopes()){try{await service.resolveScope(origin.id);items.push({id:origin.id,title:origin.workspace_title,workspaceId:origin.workspace_id,current:origin.id===scope.identity});}catch{}}
        return json(res,{items});
      }
      if(method==='GET'&&path.startsWith('/evidence/')&&id){
        const row=db.db.prepare('SELECT payload FROM knowledge_source_snapshots WHERE scope_id=? AND id=?').get(scope.identity,id);if(!row)fail('WIKI_NOT_FOUND',404);return json(res,JSON.parse(row.payload));
      }
      if(path.startsWith('/pages/')&&id){
        if(method==='GET'&&!action)return json(res,db.page(scope.identity,id,input.revision));
        if(method==='PUT'&&!action)return json(res,await service.editPage(scope,id,input));
        if(method==='POST'&&action==='regenerate')return json(res,await service.start(scope,{...input,kind:'regenerate',pageId:id},sessionId),202);
        if(method==='GET'&&action==='revisions'){
          db.page(scope.identity,id);const cursor=Number(input.cursor)||0;if(!Number.isSafeInteger(cursor)||cursor<0)fail('WIKI_INVALID_INPUT');
          return json(res,db.pageRows('SELECT id,version,payload FROM knowledge_wiki_revisions WHERE scope_id=? AND page_id=? AND version>? ORDER BY version',[scope.identity,id,cursor],limit,row=>{const value=JSON.parse(row.payload);return {id:row.id,version:row.version,actor:value.actor,createdAt:value.createdAt};},'version'));
        }
      }
      if(method==='GET'&&path==='/jobs'){
        const cursor=input.cursor===undefined?Number.MAX_SAFE_INTEGER:Number(input.cursor);if(!Number.isSafeInteger(cursor)||cursor<0)fail('WIKI_INVALID_INPUT');
        const batch=db.pageRows("SELECT rowid,payload FROM knowledge_jobs WHERE scope_id=? AND status!='deleted' AND rowid<? ORDER BY rowid DESC",[scope.identity,cursor],limit,row=>JSON.parse(row.payload),'rowid');
        return json(res,{...batch,outbox:db.db.prepare('SELECT * FROM knowledge_outbox WHERE scope_id=? ORDER BY sequence DESC LIMIT 100').all(scope.identity)});
      }
      if(method==='POST'&&path==='/jobs')return json(res,await service.start(scope,input,sessionId),202);
      if(path.startsWith('/jobs/')&&id){
        const job=db.job(scope.identity,id);if(!job)fail('WIKI_NOT_FOUND',404);
        if(method==='GET'&&!action)return json(res,job);
        if(method==='POST'&&action==='cancel')return json(res,service.cancel(scope,id));
        if(method==='DELETE'&&!action)return json(res,service.cancel(scope,id,true));
        if(method==='POST'&&action==='retry')return json(res,await service.start(scope,job.input,sessionId),202);
        if(method==='POST'&&action==='save')return json(res,await service.saveAnswer(scope,id,input),202);
      }
      if(method==='POST'&&path==='/backfill'){
        const cursor=input.cursor||'';
        if(input.documentIds!==undefined&&(!Array.isArray(input.documentIds)||input.documentIds.some(id=>typeof id!=='string')||new Set(input.documentIds).size!==input.documentIds.length))fail('WIKI_INVALID_INPUT');
        const batch=input.documentIds?{items:input.documentIds.map(id=>{const doc=scope.store.entry(id);if(!doc)fail('WIKI_NOT_FOUND',404);return {id:doc.id,version:doc.version};}),hasMore:false,nextCursor:null}:db.documents(scope.identity,cursor,limit);
        if(!Array.isArray(batch.items)||batch.items.length>200)fail('WIKI_INVALID_INPUT');
        db.transaction(()=>{for(const doc of batch.items)db.db.prepare("INSERT INTO knowledge_outbox(scope_id,document_id,source_version,change_type,status) VALUES (?,?,?,'backfill','pending') ON CONFLICT(scope_id,document_id,source_version) DO UPDATE SET status='pending',change_type='backfill'").run(scope.identity,doc.id,doc.version);});
        await service.consume(scope,sessionId);const events=batch.items.map(doc=>db.db.prepare('SELECT document_id,status FROM knowledge_outbox WHERE scope_id=? AND document_id=? AND source_version=?').get(scope.identity,doc.id,doc.version));return json(res,{status:events.some(event=>['pending','queued','running'].includes(event.status))?'queued':events.some(event=>event.status==='waiting_session')?'waiting_session':'completed',...batch,events});
      }
      if(method==='GET'&&path==='/candidates'){
        const cursor=Number(input.cursor)||0;if(!Number.isSafeInteger(cursor)||cursor<0)fail('WIKI_INVALID_INPUT');
        return json(res,db.pageRows("SELECT rowid,payload FROM knowledge_candidates WHERE scope_id=? AND status='pending' AND rowid>? ORDER BY rowid",[scope.identity,cursor],limit,row=>JSON.parse(row.payload),'rowid'));
      }
      if(path.startsWith('/candidates/')&&id){
        if(method==='GET'&&!action)return json(res,db.candidate(scope.identity,id));
        if(method==='PUT'&&!action){
          const candidate=db.candidate(scope.identity,id);if(candidate.status!=='pending'||candidate.version!==input.expectedVersion)fail('WIKI_VERSION_CONFLICT',409);
          bounded(input,(await service.settings()).maxResultBytes);
          if(!Array.isArray(input.pages)||input.pages.length!==candidate.pages.length||input.pages.some(page=>typeof page.body!=='string'||!page.body.trim()||typeof page.title!=='string'||!page.title.trim()))fail('WIKI_INVALID_INPUT');
          candidate.pages=candidate.pages.map((page,index)=>({...page,body:input.pages[index].body,title:input.pages[index].title}));
          if(candidate.rules!==undefined){if(typeof input.rules!=='string'||!input.rules.trim())fail('WIKI_INVALID_INPUT');candidate.rules=input.rules;}
          candidate.version++;db.transaction(()=>{const current=db.candidate(scope.identity,id);if(current.status!=='pending'||current.version!==input.expectedVersion)fail('WIKI_VERSION_CONFLICT',409);db.saveCandidate(candidate);db.append(scope.identity,'candidate_edited',{id,version:candidate.version});});return json(res,candidate);
        }
        if(method==='POST'&&action==='publish'){userOnly();if(db.candidate(scope.identity,id).inputHash!==input.inputHash)fail('WIKI_VERSION_CONFLICT',409);return json(res,await service.publish(scope,id,input.expectedVersion));}
        if(method==='POST'&&action==='reject'){
          userOnly();const candidate=db.candidate(scope.identity,id);if(candidate.version!==input.expectedVersion||candidate.status!=='pending')fail('WIKI_VERSION_CONFLICT',409);
          candidate.status='rejected';candidate.version++;db.saveCandidate(candidate);db.append(scope.identity,'candidate_rejected',{id});return json(res,candidate);
        }
      }
      if(method==='GET'&&path==='/rules')return json(res,db.rules(scope.identity));
      if(method==='PUT'&&path==='/rules'){
        const rule=db.rules(scope.identity);if(input.expectedVersion!==rule.version||typeof input.body!=='string'||!input.body.trim())fail('WIKI_VERSION_CONFLICT',409);
        bounded(input,(await service.settings()).maxResultBytes);
        const candidate={id:randomUUID(),scopeId:scope.identity,version:1,status:'pending',pages:[],summaries:[],refs:[],manifest:[],rules:input.body,ruleVersion:rule.version,ruleHash:rule.hash,createdAt:now()};db.saveCandidate(candidate);return json(res,candidate,202);
      }
      if(path.startsWith('/summaries/')&&id){
        const doc=service.source(scope,id,method==='GET'),old=db.summary(scope.identity,id);
        if(method==='GET')return json(res,{document:doc,summary:old});
        if(method==='PUT'){
          if(input.expectedVersion!==(old?.version||0)||typeof input.summary!=='string')fail('WIKI_VERSION_CONFLICT',409);
          if(!['requirement','design','cr','other'].includes(input.classification))fail('WIKI_INVALID_INPUT');
          bounded(input,(await service.settings()).maxResultBytes);
          for(const key of ['entities','concepts','decisions'])if(!Array.isArray(input[key])||input[key].length>100)fail('WIKI_INVALID_INPUT');
          const value={...old,documentId:id,sourceVersion:doc.version,summary:input.summary,classification:input.classification,entities:input.entities||[],concepts:input.concepts||[],decisions:input.decisions||[],version:(old?.version||0)+1,humanEdited:true};
          db.transaction(()=>{if((db.summary(scope.identity,id)?.version||0)!==input.expectedVersion||scope.store.entry(id)?.version!==doc.version)fail('WIKI_VERSION_CONFLICT',409);db.saveSummary(scope.identity,value);db.append(scope.identity,'summary_edited',{documentId:id,version:value.version});});return json(res,value);
        }
      }
      if(method==='PUT'&&path.startsWith('/refs/')&&id){
        userOnly();const row=db.db.prepare('SELECT payload FROM knowledge_wiki_refs WHERE scope_id=? AND id=?').get(scope.identity,id);if(!row)fail('WIKI_NOT_FOUND',404);
        const ref=JSON.parse(row.payload);if(ref.version!==input.expectedVersion||!['accepted','rejected'].includes(input.decision))fail('WIKI_VERSION_CONFLICT',409);
        ref.reviewState=input.decision;ref.version++;
        db.transaction(()=>{db.db.prepare('INSERT INTO knowledge_review_decisions VALUES (?,?,?,?) ON CONFLICT(scope_id,target_key,evidence_hash) DO UPDATE SET payload=excluded.payload').run(scope.identity,id,ref.evidenceHash,JSON.stringify({decision:input.decision,actor:'user',createdAt:now()}));db.db.prepare('UPDATE knowledge_wiki_refs SET payload=? WHERE scope_id=? AND id=?').run(JSON.stringify(ref),scope.identity,id);db.append(scope.identity,'ref_reviewed',{id,decision:input.decision});});return json(res,ref);
      }
      if(method==='POST'&&path==='/refs'){
        const from=db.page(scope.identity,input.fromPageId),to=db.page(scope.identity,input.toPageId);
        if(!['related','depends_on','contradicts','supersedes'].includes(input.refType)||from.id===to.id)fail('WIKI_INVALID_INPUT');
        const refId=digest([scope.identity,from.id,to.id,input.refType]);
        if(db.db.prepare('SELECT 1 FROM knowledge_wiki_refs WHERE scope_id=? AND id=?').get(scope.identity,refId))fail('WIKI_VERSION_CONFLICT',409);
        const evidence=from.revision.evidence,evidenceHash=digest([evidence,null]);
        const ref={id:refId,scopeId:scope.identity,fromPageId:from.id,toPageId:to.id,fromRevision:from.current_revision,toVersion:to.version,refType:input.refType,source:req.operationExec?'llm':'manual',validity:from.status==='ready'&&to.status==='ready'?'valid':'stale',reviewState:req.operationExec?'candidate':'accepted',version:1,evidence,evidenceHash};
        db.transaction(()=>{db.db.prepare('INSERT INTO knowledge_wiki_refs VALUES (?,?,?,?,?,?)').run(refId,scope.identity,from.id,to.id,input.refType,JSON.stringify(ref));if(!req.operationExec)db.db.prepare('INSERT INTO knowledge_review_decisions VALUES (?,?,?,?)').run(scope.identity,refId,evidenceHash,JSON.stringify({decision:'accepted',actor:'user',createdAt:now()}));db.append(scope.identity,'ref_added',{id:refId});});return json(res,ref,201);
      }
      if(method==='GET'&&path==='/export'){
        const pages=[];let cursor='';do{const batch=db.pages(scope.identity,cursor,100);for(const page of batch.items)pages.push(db.page(scope.identity,page.id));cursor=batch.nextCursor;}while(cursor);
        const snapshots=db.db.prepare('SELECT DISTINCT s.id,s.payload FROM knowledge_source_snapshots s JOIN knowledge_page_sources p ON p.snapshot_id=s.id JOIN knowledge_wiki_pages w ON w.current_revision=p.revision_id WHERE w.scope_id=? AND s.scope_id=?').all(scope.identity,scope.identity).map(row=>({...JSON.parse(row.payload),snapshotId:row.id}));
        return json(res,bounded({formatVersion:1,scopeId:scope.identity,rules:db.rules(scope.identity),pages,snapshots},(await service.settings()).maxResultBytes));
      }
      if(method==='POST'&&path==='/restore')return json(res,await service.restore(scope,input.backup,input.cursor??0),202);
      fail('WIKI_NOT_FOUND',404);
    }catch(error){if(!res.headersSent)json(res,{error:/^WIKI_[A-Z_]+$/.test(error.message)?error.message:'WIKI_FAILED',details:error.details||{}},error.status||500);}
  };
  const handler=(req,res)=>{requests.add(req);const task=dispatch(req,res).finally(()=>{requests.delete(req);pending.delete(task);});pending.add(task);return task;};
  return {service,routes:[{kind:'prefix',path:'/req-hub/knowledge/wiki',handler}],async dispose(){closing=true;service.beginClose();for(const req of requests)if(['POST','PUT'].includes(req.method)&&!req.readableEnded)req.destroy(new Error('WIKI_CLOSED'));await Promise.allSettled([...pending]);await service.close();}};
}
