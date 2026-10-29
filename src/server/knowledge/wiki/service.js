import { randomUUID } from 'node:crypto';
import { realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WikiStore, bounded, digest, fail, now, PAGE_TYPES } from './store.js';
import { WikiRuntime, installWikiTools, WIKI_TOOLS } from './runtime.js';
import { executeTask, prepareTaskPrompt } from '../../task-executor.js';
import { resolveSyncBudget } from '../../sync-budget.js';
import { readSource } from '../source-reader.js';
import { safeDocumentPath } from '../../safe-path.js';
import { CodeProvider, codeSnapshot } from '../enhancements/code-provider.js';
import { limits as enhancementLimits } from '../enhancements/contracts.js';
import { toFtsQuery } from '../retrieval.js';
import { withDocumentLock } from '../../sync-document-validator.js';

export const DEFAULTS = { autoManage:true,maxConcurrentJobs:2,maxWikiPagesPerScope:500,maxInputBytes:2000000,maxResultBytes:250000,maxSourceDocuments:30,maxAffectedPages:30,timeoutMs:300000,autoCrossRef:true,useGitNexusForCrossRef:true,lintOnIngest:false,smallFileThresholdBytes:512 };
const ACTIVE = new Set(['queued','running','cancelling']);
const pathKey = value => process.platform==='win32'?value.replaceAll('\\','/').toLowerCase():value;
const errorInfo = error => ({code:/^WIKI_[A-Z_]+$/.test(error.message)?error.message:'WIKI_FAILED',retryable:true});

export class WikiService {
  constructor({knowledge,ctx,configLoader,runTask=executeTask}) { Object.assign(this,{knowledge,ctx,configLoader,runTask});this.active=new Map();this.tasks=new Set();this.closed=false;this.preparing=new Set();this.preparationControllers=new Set();this.consuming=new Set(); }
  database() { if(this.closed)fail('WIKI_CLOSED',503);return this.store ||= new WikiStore(this.knowledge.database()); }
  async settings() { return {...DEFAULTS,...(await this.configLoader()).wiki}; }
  track(promise) { this.tasks.add(promise);promise.finally(()=>this.tasks.delete(promise)).catch(()=>{});return promise; }
  async parent(scope,sessionId) {
    const candidates=sessionId?[this.ctx.agents?.get(sessionId)]:this.ctx.agents?.list?.()||[];
    const root=pathKey(await realpath(scope.workspace.path));
    for(const agent of candidates){const cwd=agent?.session?.header?.cwd||agent?.options?.cwd;if(agent&&agent.status!=='stopped'&&(sessionId||!agent.session?.header?.parentSession)&&cwd&&pathKey(await realpath(cwd).catch(()=>''))===root)return agent;}
    return null;
  }
  async capture(workspaceId,path,sessionId,signal) {
    const scope=await this.knowledge.scope(workspaceId);
    const source=await readSource(scope.docsRoot,path,{signal});signal?.throwIfAborted();
    this.database();const result=scope.store.publishDocument(source,'wiki-auto-source-v1');
    await this.consume(scope,sessionId);return {documentId:result.documentId,state:'saved'};
  }
  async consume(scope,sessionId) {
    if(this.closed||this.closing||this.consuming.has(scope.identity))return;
    this.consuming.add(scope.identity);
    try {
      const database=this.database(),settings=await this.settings();
      for(const event of database.outbox(scope.identity)){
        if(!settings.autoManage&&event.change_type!=='backfill'){database.eventState(event.sequence,'skipped');database.append(scope.identity,'auto_skipped',{documentId:event.document_id,reason:'disabled'});continue;}
        const entry=scope.store.entry(event.document_id);
        if(!entry||entry.version!==event.source_version){database.eventState(event.sequence,'superseded');continue;}
        if(!await this.parent(scope,sessionId)){database.eventState(event.sequence,'waiting_session');continue;}
        try{const job=await this.start(scope,{kind:'ingest',documentIds:[entry.id]},sessionId,event.sequence);const status=database.job(scope.identity,job.id).status;database.eventState(event.sequence,ACTIVE.has(status)?'queued':status);database.append(scope.identity,'source_queued',{documentId:entry.id,jobId:job.id});}
        catch(error){if(error.message==='WIKI_BUSY')break;database.eventState(event.sequence,'failed');database.append(scope.identity,'auto_failed',{documentId:entry.id,error:errorInfo(error)});}
      }
    } finally {this.consuming.delete(scope.identity);}
  }
  async resume() {
    if(this.closed)return;
    for(const origin of this.knowledge.database().scopes()){
      const scope=await this.knowledge.scope(origin.workspace_id).catch(()=>null);if(!scope||scope.identity!==origin.id)continue;
      this.database().db.prepare("UPDATE knowledge_outbox SET status='pending' WHERE scope_id=? AND status='waiting_session'").run(scope.identity);
      await this.consume(scope);
    }
  }
  source(scope,id,allowStale=false) {
    const entry=scope.store.entry(id);if(!entry||!allowStale&&entry.sources.some(ref=>ref.status!=='active'))fail('WIKI_SOURCE_STALE',409);
    const {versions,...doc}=entry;return {...doc,kind:'source',scopeId:scope.identity,status:entry.sources[0]?.status};
  }
  async freeze(scope,input,settings) {
    await this.knowledge.refreshSources(scope);
    const database=this.database(),rules=database.rules(scope.identity);
    let ids=input.documentIds;
    if(ids!==undefined&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length))fail('WIKI_INVALID_INPUT');
    if(ids===undefined){
      if(input.kind==='query')ids=scope.store.search(input.instruction||'',Math.min(100,settings.maxSourceDocuments)).hits.map(item=>item.id);
      else ids=scope.store.listMetadata(settings.maxSourceDocuments+1).map(item=>item.id);
    }
    if(input.kind==='query'&&Array.isArray(input.scopeIds)&&!input.scopeIds.includes(scope.identity))ids=[];
    if(ids.length>settings.maxSourceDocuments)fail('WIKI_BUDGET_EXCEEDED',413);
    const documents=ids.map(id=>this.source(scope,id,['lint','query'].includes(input.kind)));
    let pages;
    if(input.kind==='query'&&Array.isArray(input.scopeIds)&&!input.scopeIds.includes(scope.identity))pages=[];
    else if(input.pageId)pages=[database.page(scope.identity,input.pageId)];
    else if(input.kind==='ingest')pages=[];
    else if(input.kind==='query')pages=this.search(scope,input.instruction||'',settings.maxAffectedPages).items.map(row=>database.page(scope.identity,row.id));
    else pages=database.pages(scope.identity,'',settings.maxAffectedPages+1).items.map(row=>database.page(scope.identity,row.id));
    if(pages.length>settings.maxAffectedPages)fail('WIKI_BUDGET_EXCEEDED',413);
    for(const page of pages)documents.push({id:'wiki:'+page.id,version:page.version,title:page.title,body:page.body,kind:'wiki',pageId:page.id,scopeId:scope.identity,status:page.status});
    if(input.kind==='ingest'){
      const catalog=database.db.prepare('SELECT * FROM knowledge_wiki_pages WHERE scope_id=? ORDER BY id').all(scope.identity);
      for(const page of catalog)documents.push({id:'wiki:'+page.id,version:page.version,title:page.title,kind:'wiki',pageId:page.id,scopeId:scope.identity,status:page.status,optional:true,load:()=>{
        const saved=database.page(scope.identity,page.id,page.current_revision);
        return {body:saved.body,version:page.version};
      }});
    }
    if(input.scopeIds!==undefined){
      if(input.kind!=='query'||!Array.isArray(input.scopeIds)||!input.scopeIds.length||input.scopeIds.length>10||input.scopeIds.some(id=>typeof id!=='string'))fail('WIKI_SCOPE_DENIED',403);
      if(!input.scopeIds.includes(scope.identity))documents.length=0;
      for(const identity of [...new Set(input.scopeIds)].filter(id=>id!==scope.identity)){
        const selected=await this.resolveScope(identity);await this.knowledge.refreshSources(selected);
        for(const source of selected.store.search(input.instruction,settings.maxSourceDocuments).hits)documents.push(this.source(selected,source.id,true));
        for(const row of this.search(selected,input.instruction,settings.maxAffectedPages).items){const page=database.page(identity,row.id);documents.push({id:'wiki:'+page.id,version:page.version,title:page.title,body:page.body,kind:'wiki',pageId:page.id,scopeId:identity,status:page.status});}
      }
    }
    if(documents.filter(doc=>doc.kind==='source').length>settings.maxSourceDocuments||documents.filter(doc=>doc.kind==='wiki'&&!doc.optional).length>settings.maxAffectedPages)fail('WIKI_BUDGET_EXCEEDED',413);
    if(!documents.length&&input.kind!=='rules')fail('WIKI_EVIDENCE_REQUIRED',422);
    bounded({documents,input,rules},settings.maxInputBytes);
    for(const doc of documents)if(!doc.optional)doc.snapshotId=database.snapshot(scope.identity,doc);
    const index={coverage:'assigned_evidence',documents:documents.map(doc=>({id:doc.id,title:doc.title,scopeId:doc.scopeId,version:doc.version,kind:doc.kind,status:doc.status,optional:!!doc.optional}))};
    documents.unshift({id:'rules',version:rules.version,body:rules.body,kind:'rules'},{id:'index',version:rules.version,body:JSON.stringify(index),kind:'index'});
    bounded({documents,input,rules},settings.maxInputBytes);return {documents,rules};
  }
  async resolveScope(identity){const origin=this.knowledge.database().scopes().find(scope=>scope.id===identity);if(!origin)fail('WIKI_SCOPE_DENIED',403);const selected=await this.knowledge.scope(origin.workspace_id);if(selected.identity!==identity)fail('WIKI_SCOPE_DENIED',403);return selected;}
  async start(scope,input,sessionId,eventSequence) {
    input={...input,eventSequence};
    if(this.closed||this.closing)fail('WIKI_CLOSED',503);
    if(!['ingest','regenerate','query','lint','rules'].includes(input.kind)||input.instruction!==undefined&&(typeof input.instruction!=='string'||input.instruction.length>8000))fail('WIKI_INVALID_INPUT');
    if(input.kind==='query'&&!input.instruction?.trim())fail('WIKI_INVALID_INPUT');
    const settings=await this.settings();
    if(input.kind==='lint'&&!this.database().documents(scope.identity,'',1).items.length&&!this.database().pages(scope.identity,'',1).items.length){
      const job={id:randomUUID(),scopeId:scope.identity,workspaceId:scope.workspaceId,kind:'lint',input,status:'completed',createdAt:now(),result:{findings:[],pages:[],summaries:[],refs:[]},skillStatus:'not_bound'};this.database().saveJob(job);this.database().append(scope.identity,'lint_completed',{jobId:job.id,empty:true});return job;
    }
    if(this.active.has(scope.identity)||this.preparing.has(scope.identity)||this.active.size+this.preparing.size>=settings.maxConcurrentJobs)fail('WIKI_BUSY',409);
    const controller=new AbortController();this.preparing.add(scope.identity);this.preparationControllers.add(controller);
    const preparation=this.prepareStart(scope,input,sessionId,settings,controller);
    this.track(preparation);
    try{return await preparation;}finally{this.preparing.delete(scope.identity);this.preparationControllers.delete(controller);}
  }
  async prepareStart(scope,input,sessionId,settings,controller) {
    const parent=await this.parent(scope,sessionId);if(!parent)fail('WIKI_SESSION_REQUIRED',409);
    const config=await this.configLoader(),provider=this.ctx.subagents?.getProvider?.(config.ai?.delegation?.provider||'spawn');
    if(!provider?.capabilities?.toolFilter||provider.inheritsParentContext!==false)fail('WIKI_PROVIDER_UNSUPPORTED',503);
    const {documents,rules}=await this.freeze(scope,input,settings);if(this.closed||this.closing)fail('WIKI_CLOSED',503);
    const budget=await resolveSyncBudget({ctx:this.ctx,llm:this.ctx.llm,parentAgent:parent,signal:controller.signal});
    const runtime=new WikiRuntime(documents,settings,budget,controller.signal,input.kind);
    runtime.freezeSnapshot=doc=>this.database().snapshot(scope.identity,{...doc,load:undefined});
    const variables={runtimeId:runtime.id,kind:input.kind,instruction:input.instruction||'',documents:JSON.stringify(documents.map(doc=>({id:doc.id,version:doc.version,kind:doc.kind,optional:!!doc.optional})))};
    const prepared=await prepareTaskPrompt(this.ctx,this.ctx.llm,config,{promptKey:'wiki-generate',variables,cwd:scope.workspace.path,parentAgent:parent,signal:controller.signal});
    controller.signal.throwIfAborted();if(this.closing)fail('WIKI_CLOSED',503);
    bounded({documents,prompt:prepared.fullPrompt},settings.maxInputBytes);
    const job={id:randomUUID(),scopeId:scope.identity,workspaceId:scope.workspaceId,kind:input.kind,status:'queued',epoch:randomUUID(),ruleVersion:rules.version,ruleHash:rules.hash,manifest:documents.filter(doc=>doc.snapshotId).map(({id,version,kind,snapshotId,pageId,body,scopeId})=>({id,version,kind,snapshotId,pageId,scopeId,hash:digest(body)})),instruction:input.instruction||'',input:{...input},createdAt:now(),skillName:prepared.skillUsed,skillStatus:prepared.skillStatus,promptHash:digest(prepared.fullPrompt),skillHash:prepared.skillContent?digest(prepared.skillContent):null};
    this.database().saveJob(job);this.active.set(scope.identity,{controller,job});
    const task=this.run(scope,job,runtime,variables,config,parent,settings,prepared).finally(async()=>{
      if(this.active.get(scope.identity)?.job.id===job.id)this.active.delete(scope.identity);
      if(!this.closing){await this.resume();if(job.kind==='ingest'&&settings.lintOnIngest&&!this.active.has(scope.identity)){try{await this.start(scope,{kind:'lint'},parent.session.id);}catch(error){this.database().append(scope.identity,'lint_deferred',{error:errorInfo(error)});}}}
    });
    this.track(task);return this.database().job(scope.identity,job.id);
  }
  async verify(scope,job,signal) {
    signal?.throwIfAborted();
    const rules=this.database().rules(scope.identity);if(rules.version!==job.ruleVersion||rules.hash!==job.ruleHash)fail('WIKI_VERSION_CONFLICT',409);
    await this.knowledge.refreshSources(scope);
    for(const ref of job.manifest){
      const selected=ref.scopeId&&ref.scopeId!==scope.identity?await this.resolveScope(ref.scopeId):scope;
      if(selected!==scope)await this.knowledge.refreshSources(selected);
      if(ref.kind==='source'){const doc=this.source(selected,ref.id,['lint','query'].includes(job.kind));if(doc.version!==ref.version||digest(doc.body)!==ref.hash)fail('WIKI_SOURCE_STALE',409);}
      else {const page=this.database().page(selected.identity,ref.pageId);if(page.version!==ref.version||digest(page.body)!==ref.hash)fail('WIKI_VERSION_CONFLICT',409);}
    }
  }
  assertJob(job,signal) {signal?.throwIfAborted();const live=this.database().job(job.scopeId,job.id);if(!live||live.epoch!==job.epoch||!['queued','running'].includes(live.status)||this.closed)fail('WIKI_CANCELLED',409);}
  assertFrozen(scope,job){
    const db=this.database(),rules=db.rules(scope.identity);if(rules.version!==job.ruleVersion||rules.hash!==job.ruleHash)fail('WIKI_VERSION_CONFLICT',409);
    for(const ref of job.manifest){
      const identity=ref.scopeId||scope.identity;
      if(ref.kind==='source'){
        const row=db.db.prepare('SELECT d.version,d.body,s.status FROM documents d JOIN sources s ON s.scope_id=d.scope_id AND s.path=d.path WHERE d.scope_id=? AND d.id=?').get(identity,ref.id);
        if(!row||row.version!==ref.version||digest(row.body)!==ref.hash||!['lint','query'].includes(job.kind)&&row.status!=='active')fail('WIKI_SOURCE_STALE',409);
      }else{const page=db.page(identity,ref.pageId);if(page.version!==ref.version||digest(page.body)!==ref.hash)fail('WIKI_VERSION_CONFLICT',409);}
    }
  }
  async run(scope,job,runtime,variables,config,parent,settings,prepared) {
    const signal=runtime.signal,controller=this.active.get(scope.identity).controller,timeout=setTimeout(()=>controller.abort(new Error('WIKI_TIMEOUT')),settings.timeoutMs);timeout.unref?.();
    this.installation ||= installWikiTools(this.ctx);this.installation.add(runtime);
    try{
      job.status='running';this.database().saveJob(job);
      const result=await this.runTask(this.ctx,this.ctx.llm,config,{promptKey:'wiki-generate',variables,parentAgent:parent,cwd:scope.workspace.path,signal,runtime,preparedPromptData:prepared,maxInputTokens:runtime.budget.limit,toolFilter:{allow:WIKI_TOOLS},description:'ReqHub Wiki '+job.kind});
      if(result.isError||!runtime.result)fail('WIKI_RESULT_INCOMPLETE',422);
      job.manifest=runtime.documents.filter(doc=>doc.snapshotId).map(({id,version,kind,snapshotId,pageId,body,scopeId})=>({id,version,kind,snapshotId,pageId,scopeId,hash:digest(body)}));
      await this.verify(scope,job,signal);this.assertJob(job,signal);
      const output=runtime.result;
      if(job.kind==='lint'){
        for(const doc of runtime.documents.filter(doc=>doc.kind==='source'&&doc.sources.some(source=>source.status!=='active'))){output.findings.push({kind:'stale',reason:'source_version_unavailable',evidence:[{documentId:doc.id,version:doc.version,startLine:1,endLine:1,snapshotId:doc.snapshotId,hash:digest(doc.body)}]});}
        for(const doc of runtime.documents.filter(doc=>doc.kind==='wiki')){
          const page=this.database().page(scope.identity,doc.pageId);
          if(page.status==='stale')output.findings.push({kind:'stale',reason:'wiki_source_changed',evidence:page.revision.evidence});
          if(!page.refs.some(ref=>ref.toPageId===page.id&&ref.reviewState!=='rejected'))output.findings.push({kind:'orphan',reason:'no_inbound_reference',evidence:page.revision.evidence});
        }
      }
      if(job.kind==='ingest'&&settings.useGitNexusForCrossRef&&config.enhancements?.enabled){
        const graph={references:[],relations:[]};
        // The existing provider checks code versions and never confirms human review.
        for(const summary of output.summaries||[])for(const entity of summary.entities||[])if(typeof entity?.path==='string')graph.references.push({id:digest(entity.path),entityId:entity.name,path:entity.path,kind:'reference'});
        await new CodeProvider(this.ctx).refresh(scope,graph,enhancementLimits(config),signal,parent,()=>{});output.code=graph;
        if(graph.code?.status==='ready')for(const relation of graph.relations){
          const from=output.pages.find(page=>page.title===relation.sourceId),to=output.pages.find(page=>page.title===relation.targetId);
          if(from&&to)output.refs.push({fromKey:from.pageId||from.entityKey,toKey:to.pageId||to.entityKey,refType:'related',source:'gitnexus',evidence:from.evidence,codeEvidence:relation.evidence,codeSnapshot:graph.code.snapshot});
        }
      }
      bounded(output,settings.maxResultBytes);
      this.assertJob(job,signal);
      this.database().transaction(()=>{
        this.assertJob(job,signal);
        this.assertFrozen(scope,job);
        if(job.kind==='query')job.result=output;
        else {const candidate=this.stage(scope,job,output,settings);job.candidateId=candidate.id;job.result=output;}
        job.status='completed';this.database().saveJob(job);this.database().append(scope.identity,job.kind+'_completed',{jobId:job.id,candidateId:job.candidateId,versions:job.manifest.map(ref=>({id:ref.id,version:ref.version}))});
        if(job.kind==='ingest')for(const ref of job.manifest.filter(ref=>ref.kind==='source'))this.database().db.prepare("UPDATE knowledge_outbox SET status='completed' WHERE scope_id=? AND document_id=? AND source_version=?").run(scope.identity,ref.id,ref.version);
        if(inputEvent(job))this.database().eventState(inputEvent(job),'completed');
      });
      if(job.kind==='ingest'&&job.candidateId){const candidate=this.database().candidate(scope.identity,job.candidateId);if(candidate.pages.every(page=>!page.humanEdited)&&candidate.summaries.every(summary=>!summary.humanEdited))await this.publish(scope,candidate.id,candidate.version,'automatic');}
      try{await this.project(scope);}catch{job.projection={status:'failed',code:'WIKI_PROJECTION_FAILED'};this.database().saveJob(job);}
    }catch(error){
      const live=this.database().job(scope.identity,job.id);
      if(live&&live.epoch===job.epoch){job.status=signal.aborted&&signal.reason?.message!=='WIKI_TIMEOUT'?'cancelled':'failed';job.error=errorInfo(signal.reason||error);this.database().saveJob(job);if(inputEvent(job))this.database().eventState(inputEvent(job),job.status);}
    }finally{clearTimeout(timeout);this.installation.close(runtime);}
  }
  stage(scope,job,result,settings) {
    const db=this.database();
    const pages=(result.pages||[]).map(proposal=>{
      let existing=proposal.pageId?db.page(scope.identity,proposal.pageId):db.db.prepare('SELECT * FROM knowledge_wiki_pages WHERE scope_id=? AND entity_key=?').get(scope.identity,proposal.entityKey);
      if(existing&&!job.manifest.some(ref=>ref.pageId===existing.id))fail('WIKI_TARGET_NOT_READ',422);
      return {...proposal,entityKey:existing?.entity_key||proposal.entityKey,pageId:existing?.id,baseVersion:existing?.version||0,baseBody:existing?db.page(scope.identity,existing.id).body:'',humanEdited:!!existing?.human_edited};
    });
    if(db.db.prepare('SELECT count(*) n FROM knowledge_wiki_pages WHERE scope_id=?').get(scope.identity).n+pages.filter(page=>!page.pageId).length>settings.maxWikiPagesPerScope)fail('WIKI_PAGE_LIMIT',409);
    const summaries=(result.summaries||[]).filter(summary=>db.summary(scope.identity,summary.documentId)?.humanEdited||Buffer.byteLength(scope.store.entry(summary.documentId)?.body||'')>=settings.smallFileThresholdBytes).map(summary=>({...summary,ruleVersion:job.ruleVersion,baseVersion:db.summary(scope.identity,summary.documentId)?.version||0,humanEdited:!!db.summary(scope.identity,summary.documentId)?.humanEdited}));
    const value={id:randomUUID(),scopeId:scope.identity,jobId:job.id,version:1,status:'pending',pages,summaries,refs:settings.autoCrossRef?result.refs||[]:[],rules:result.rules,manifest:job.manifest,ruleVersion:job.ruleVersion,ruleHash:job.ruleHash,createdAt:now()};
    db.saveCandidate(value);for(const page of pages.filter(page=>page.humanEdited))db.db.prepare("UPDATE knowledge_wiki_pages SET status='pending_merge' WHERE scope_id=? AND id=? AND status='ready'").run(scope.identity,page.pageId);return value;
  }
  async publish(scope,id,expectedVersion,actor='user') {
    const db=this.database(),candidate=db.candidate(scope.identity,id);
    if(candidate.status!=='pending'||candidate.version!==expectedVersion)fail('WIKI_VERSION_CONFLICT',409);
    await this.verify(scope,{...candidate},undefined);
    for(const ref of candidate.refs.filter(ref=>ref.codeSnapshot)){const current=await codeSnapshot(scope.workspace.path);if(current.dirty||current.head!==ref.codeSnapshot.head)fail('WIKI_CODE_STALE',409);}
    const result=db.transaction(()=>{
      const current=db.candidate(scope.identity,id);if(current.status!=='pending'||current.version!==expectedVersion)fail('WIKI_VERSION_CONFLICT',409);
      this.assertFrozen(scope,candidate);
      if(candidate.rules){db.db.prepare('INSERT INTO knowledge_rules VALUES (?,?,?,?,?)').run(scope.identity,candidate.ruleVersion+1,candidate.rules,digest(candidate.rules),now());db.db.prepare("UPDATE knowledge_wiki_pages SET status='stale' WHERE scope_id=?").run(scope.identity);}
      const pageIds=new Map();
      for(const page of candidate.pages){const pageId=db.publishPage(scope.identity,page,candidate.ruleVersion,actor);pageIds.set(page.entityKey,pageId);if(page.pageId)pageIds.set(page.pageId,pageId);}
      for(const summary of candidate.summaries){const old=db.summary(scope.identity,summary.documentId);if((old?.version||0)!==summary.baseVersion)fail('WIKI_VERSION_CONFLICT',409);db.saveSummary(scope.identity,{...summary,version:summary.baseVersion+1,humanEdited:actor==='user'||summary.humanEdited});}
      for(const ref of candidate.refs){
        const resolve=key=>pageIds.get(key)||db.db.prepare('SELECT id FROM knowledge_wiki_pages WHERE scope_id=? AND (id=? OR entity_key=?)').get(scope.identity,key,key)?.id;
        const from=resolve(ref.fromKey),to=resolve(ref.toKey);if(!from||!to)fail('WIKI_REFERENCE_INVALID',422);
        const key=digest([scope.identity,from,to,ref.refType]),evidenceHash=digest([ref.evidence,ref.codeEvidence||null]);
        const decision=parsePayload(db.db.prepare('SELECT payload FROM knowledge_review_decisions WHERE scope_id=? AND target_key=? AND evidence_hash=?').get(scope.identity,key,evidenceHash));
        const prior=parsePayload(db.db.prepare('SELECT payload FROM knowledge_wiki_refs WHERE scope_id=? AND id=?').get(scope.identity,key));
        const saved={id:key,scopeId:scope.identity,fromPageId:from,toPageId:to,fromRevision:db.page(scope.identity,from).current_revision,toVersion:db.page(scope.identity,to).version,refType:ref.refType,source:ref.source||'llm',validity:'valid',reviewState:decision?.decision||'candidate',version:(prior?.version||0)+1,evidence:ref.evidence,codeEvidence:ref.codeEvidence,evidenceHash};
        db.db.prepare('INSERT INTO knowledge_wiki_refs VALUES (?,?,?,?,?,?) ON CONFLICT(scope_id,from_page_id,to_page_id,ref_type) DO UPDATE SET payload=excluded.payload').run(key,scope.identity,from,to,ref.refType,JSON.stringify(saved));
      }
      candidate.status='published';candidate.version++;db.saveCandidate(candidate);db.append(scope.identity,'candidate_published',{id,actor});return {status:'succeeded',pageIds:[...new Set(pageIds.values())]};
    });
    try{await this.project(scope);}catch(error){return {...result,projection:{status:'failed',code:'WIKI_PROJECTION_FAILED'}};}return result;
  }
  async editPage(scope,id,input) {
    const page=this.database().page(scope.identity,id);if(page.version!==input.expectedVersion||typeof input.body!=='string'||!input.body.trim())fail('WIKI_VERSION_CONFLICT',409);
    bounded(input,(await this.settings()).maxResultBytes);
    this.database().transaction(()=>{this.database().publishPage(scope.identity,{pageId:id,baseVersion:input.expectedVersion,title:page.title,pageType:page.page_type,body:input.body,evidence:page.revision.evidence},this.database().rules(scope.identity).version,'user');if(page.status==='stale')this.database().db.prepare("UPDATE knowledge_wiki_pages SET status='stale' WHERE scope_id=? AND id=?").run(scope.identity,id);});
    const saved=this.database().page(scope.identity,id);try{await this.project(scope);}catch{saved.projection={status:'failed',code:'WIKI_PROJECTION_FAILED'};}return saved;
  }
  async restore(scope,backup,cursor=0) {
    const settings=await this.settings(),db=this.database();bounded(backup,settings.maxInputBytes);
    if(backup?.formatVersion!==1||backup.scopeId!==scope.identity||!Array.isArray(backup.pages)||!Array.isArray(backup.snapshots)||!Number.isSafeInteger(cursor)||cursor<0||cursor>backup.pages.length)fail('WIKI_INVALID_INPUT');
    const selectedPages=backup.pages.slice(cursor,cursor+settings.maxAffectedPages);
    const required=new Set(selectedPages.flatMap(page=>(page.revision?.evidence||[]).map(ref=>ref.snapshotId)));
    const snapshots=new Map(),manifest=[];
    const capture=doc=>{const snapshotId=db.snapshot(scope.identity,doc);if(!manifest.some(ref=>ref.id===doc.id))manifest.push({id:doc.id,version:doc.version,kind:doc.kind,pageId:doc.pageId,scopeId:doc.scopeId,snapshotId,hash:digest(doc.body)});return snapshotId;};
    await this.knowledge.refreshSources(scope);
    for(const snapshot of backup.snapshots.filter(snapshot=>required.has(snapshot.snapshotId))){
      let doc;
      const origin=snapshot.scopeId&&snapshot.scopeId!==scope.identity?await this.resolveScope(snapshot.scopeId):scope;
      if(origin!==scope)await this.knowledge.refreshSources(origin);
      if(snapshot.kind==='source')doc=this.source(origin,snapshot.id);
      else if(snapshot.kind==='wiki'){const page=db.page(origin.identity,snapshot.pageId);doc={id:'wiki:'+page.id,version:page.version,body:page.body,pageId:page.id,kind:'wiki',scopeId:origin.identity};}
      else fail('WIKI_INVALID_INPUT');
      if(doc.version!==snapshot.version||doc.body!==snapshot.body)fail('WIKI_SOURCE_STALE',409);
      snapshots.set(snapshot.snapshotId,{doc,snapshotId:capture(doc)});
    }
    const pages=selectedPages.map(page=>{
      if(typeof page.entity_key!=='string'||!page.entity_key.trim()||typeof page.title!=='string'||!page.title.trim()||!PAGE_TYPES.includes(page.page_type)||typeof page.body!=='string'||!page.body.trim()||!Array.isArray(page.revision?.evidence)||!page.revision.evidence.length)fail('WIKI_INVALID_INPUT');
      const existing=db.db.prepare('SELECT id FROM knowledge_wiki_pages WHERE scope_id=? AND entity_key=?').get(scope.identity,page.entity_key);
      if(existing){const current=db.page(scope.identity,existing.id);capture({id:'wiki:'+current.id,version:current.version,body:current.body,pageId:current.id,kind:'wiki',scopeId:scope.identity});}
      const evidence=page.revision.evidence.map(ref=>{const saved=snapshots.get(ref.snapshotId);if(!saved||saved.doc.id!==ref.documentId||saved.doc.version!==ref.version||!Number.isSafeInteger(ref.startLine)||!Number.isSafeInteger(ref.endLine)||ref.startLine<1||ref.endLine<ref.startLine||ref.endLine>saved.doc.body.split('\n').length)fail('WIKI_REFERENCE_INVALID',422);return {...ref,snapshotId:saved.snapshotId,hash:digest(saved.doc.body)};});
      return {entityKey:page.entity_key,title:page.title,pageType:page.page_type,body:page.body,evidence};
    });
    const rules=db.rules(scope.identity),job={manifest,ruleVersion:rules.version,ruleHash:rules.hash};
    await this.verify(scope,job);
    return db.transaction(()=>{this.assertFrozen(scope,job);const candidate=this.stage(scope,job,{pages},settings);db.append(scope.identity,'restore_staged',{candidateId:candidate.id});return {candidate,hasMore:cursor+pages.length<backup.pages.length,nextCursor:cursor+pages.length<backup.pages.length?cursor+pages.length:null};});
  }
  async saveAnswer(scope,jobId,input) {
    const job=this.database().job(scope.identity,jobId);if(!job||job.kind!=='query'||job.status!=='completed')fail('WIKI_NOT_FOUND',404);
    await this.verify(scope,job);const pageType=input.pageType||'analysis';if(!PAGE_TYPES.includes(pageType)||typeof input.title!=='string'||!input.title.trim())fail('WIKI_INVALID_INPUT');
    const result={pages:[{title:input.title,pageType,body:job.result.answer,evidence:job.result.evidence,...(input.pageId?{pageId:input.pageId}:{entityKey:'query:'+job.id})}]};
    const settings=await this.settings();return this.database().transaction(()=>{
      this.assertFrozen(scope,{...job,kind:undefined});
      if(input.pageId&&this.database().page(scope.identity,input.pageId).version!==input.expectedVersion)fail('WIKI_VERSION_CONFLICT',409);
      return this.stage(scope,job,result,settings);
    });
  }
  cancel(scope,id,remove=false) {
    const job=this.database().job(scope.identity,id);if(!job)fail('WIKI_NOT_FOUND',404);
    if(ACTIVE.has(job.status)){if(this.active.get(scope.identity)?.job.id===id){this.active.get(scope.identity).controller.abort();if(remove)this.active.delete(scope.identity);}job.status=remove?'deleted':'cancelling';if(remove)job.epoch=randomUUID();this.database().saveJob(job);}
    if(remove&&job.status!=='deleted'){job.status='deleted';job.epoch=randomUUID();delete job.result;this.database().saveJob(job);}
    return job;
  }
  async index(scope,cursor='',limit=30) {
    const db=this.database();const documents=db.documents(scope.identity,cursor,limit);
    documents.items=documents.items.map(doc=>({...doc,summary:db.summary(scope.identity,doc.id),sourceStatus:scope.store.source(doc.path)?.status,wikiStatus:db.db.prepare('SELECT status FROM knowledge_outbox WHERE scope_id=? AND document_id=? ORDER BY sequence DESC LIMIT 1').get(scope.identity,doc.id)?.status||'not_processed',type:'source'}));return documents;
  }
  search(scope,query,limit=30,cursor='') {
    if(typeof query!=='string'||query.length>1000)fail('WIKI_INVALID_INPUT');
    const db=this.database(),escaped=query.replace(/[\\%_]/g,ch=>'\\'+ch);
    if(!query.trim())return db.pages(scope.identity,cursor,limit);
    return db.pageRows("SELECT p.*,f.body FROM knowledge_wiki_pages p JOIN knowledge_wiki_fts f ON f.id=p.id WHERE p.scope_id=? AND p.id>? AND (p.id IN (SELECT id FROM knowledge_wiki_fts WHERE knowledge_wiki_fts MATCH ?) OR f.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\') ORDER BY p.id",[scope.identity,cursor,toFtsQuery(query||' '),'%'+escaped+'%','%'+escaped+'%'],limit);
  }
  project(scope) {return withDocumentLock(join(dirname(this.knowledge.databasePath),'wiki',digest(scope.identity)),()=>this.projectFiles(scope)).catch(error=>{this.database().append(scope.identity,'projection_failed',{code:'WIKI_PROJECTION_FAILED'});throw error;});}
  async projectFiles(scope) {
    const root=await safeDocumentPath(dirname(this.knowledge.databasePath),'wiki',{allowMissing:true});await mkdir(root,{recursive:true});
    const directory=await safeDocumentPath(root,digest(scope.identity),{allowMissing:true});await mkdir(directory,{recursive:true});
    const index=[];let cursor='';do{const batch=this.database().pages(scope.identity,cursor,100);for(const row of batch.items){const page=this.database().page(scope.identity,row.id);const target=await safeDocumentPath(directory,page.id+'.md',{allowMissing:true});await writeFile(target,`---\npageId: ${page.id}\nversion: ${page.version}\nruleVersion: ${page.revision.ruleVersion}\nstatus: ${page.status}\nevidence: ${JSON.stringify(page.revision.evidence)}\n---\n\n# ${page.title}\n\n${page.body}`,'utf8');index.push(`- [${page.title.replace(/[\[\]\r\n]/g,' ')}](${page.id}.md) · ${page.page_type} · v${page.version} · ${page.status}`);}cursor=batch.nextCursor;}while(cursor);
    await writeFile(await safeDocumentPath(directory,'index.md',{allowMissing:true}),index.join('\n'),'utf8');
    const rules=this.database().rules(scope.identity);await writeFile(await safeDocumentPath(directory,'rules.md',{allowMissing:true}),`---\nversion: ${rules.version}\nhash: ${rules.hash}\n---\n\n${rules.body}`,'utf8');
    const log=[];let after=0;do{const batch=this.database().logs(scope.identity,after,100);for(const row of batch.items)log.push(`## [${row.created_at}] ${row.operation}\n\n${JSON.stringify(row.detail)}\n`);after=batch.nextCursor;}while(after);
    await writeFile(await safeDocumentPath(directory,'log.md',{allowMissing:true}),log.join('\n'),'utf8');
  }
  beginClose() {this.closing=true;for(const controller of this.preparationControllers)controller.abort(new Error('WIKI_CLOSED'));for(const {controller}of this.active.values())controller.abort(new Error('WIKI_CLOSED'));}
  close() {return this.closePromise ||= (async()=>{this.beginClose();await Promise.allSettled([...this.tasks]);await this.installation?.dispose();this.closed=true;})();}
}
function inputEvent(job){return job.input?.eventSequence;}
function parsePayload(row){return row?JSON.parse(row.payload):null;}
