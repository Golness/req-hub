import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { WikiService } from '../../src/server/knowledge/wiki/service.js';
import { WikiRuntime } from '../../src/server/knowledge/wiki/runtime.js';
import { digest } from '../../src/server/knowledge/wiki/store.js';
import { WikiStore } from '../../src/server/knowledge/wiki/store.js';
import { createWikiRoutes } from '../../src/server/routes/wiki-routes.js';
import { createOperations } from '../../src/server/operations.js';
vi.mock('../../src/server/sync-budget.js', async importOriginal => ({ ...await importOriginal(), resolveSyncBudget:async()=>({limit:200000}) }));
let root,knowledge,wiki,scope,doc,ctx,runTask,config;
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'reqhub-wiki-test-'));await mkdir(join(root,'docs/alice/2026-10-29-topic'),{recursive:true});
  config={docsDir:'docs',wiki:{autoManage:false}};
  const parent={status:'idle',session:{id:'parent',header:{cwd:root}}};
  ctx={agents:{get:id=>id==='parent'?parent:null,list:()=>[]},subagents:{getProvider:()=>({capabilities:{toolFilter:true},inheritsParentContext:false})},tools:{register:()=>()=>{},guard:()=>()=>{}},on:()=>()=>{},skills:{get:async()=>null}};
  knowledge=new KnowledgeService({registry:{list:()=>[{id:'ws',path:root}]},configLoader:async()=>config,databasePath:join(root,'data/knowledge.sqlite')});
  runTask=vi.fn(async(_ctx,_llm,_config,options)=>{
    for(const entry of options.runtime.documents){let offset=0;do{const result=options.runtime.read({documentId:entry.id,offset});offset=result.nextOffset;if(result.eof)break;}while(true);}
    const source=options.runtime.documents.find(item=>item.kind==='source');
    const evidence=[{documentId:source.id,version:source.version,startLine:1,endLine:1}];
    options.runtime.submit({result:options.variables.kind==='query'?{answer:'A supported answer.',evidence}:{pages:[{title:'Topic',pageType:'concept',entityKey:'concept:topic',body:'Supported knowledge.',evidence}],summaries:[{documentId:source.id,summary:'Summary',classification:'design',evidence}],refs:[]}});
    return {isError:false};
  });
  wiki=new WikiService({knowledge,ctx,configLoader:async()=>config,runTask});wiki.database();
  scope=await knowledge.scope('ws');await writeFile(join(root,'docs/alice/2026-10-29-topic/source.md'),'# Source\nA supported fact.');
  const source=await knowledge.readSourceFile(scope.docsRoot,'alice/2026-10-29-topic/source.md');doc=scope.store.publishDocument(source,'test').documentId;
});
afterEach(async()=>{await wiki.close();await knowledge.close();const child=relative(tmpdir(),root);if(isAbsolute(child)||child.startsWith('..')||!child.startsWith('reqhub-wiki-test-'))throw new Error('Unsafe test cleanup');await rm(root,{recursive:true,force:true});});
async function settle(){while(wiki.tasks.size)await Promise.allSettled([...wiki.tasks]);}
it('preserves the source format and records source changes in the same transaction',()=>{
  expect(knowledge.database().db.prepare('PRAGMA user_version').get().user_version).toBe(3);
  expect(wiki.database().outbox(scope.identity)).toMatchObject([{document_id:doc,source_version:1}]);
  expect(scope.store.entry(doc).body).toContain('supported fact');
  expect(()=>scope.store.transaction(()=>{scope.store.publishDocumentRow({relativePath:'rollback.md',text:'rollback',contentHash:digest('rollback')},'test');throw new Error('rollback');})).toThrow('rollback');
  expect(wiki.database().outbox(scope.identity)).toHaveLength(1);
});
it('generates and publishes Wiki pages with versioned evidence through isolated tools',async()=>{
  const job=await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');await settle();
  const saved=wiki.database().job(scope.identity,job.id);expect(saved.status).toBe('completed');
  const page=wiki.database().pages(scope.identity).items[0];
  expect(wiki.database().page(scope.identity,page.id).body).toBe('Supported knowledge.');
  expect(runTask.mock.calls[0][3].toolFilter.allow).toEqual(['req_hub_wiki_read','req_hub_wiki_submit']);
  expect(runTask.mock.calls[0][3].preparedPromptData.fullPrompt).toContain('req_hub_wiki_submit');
  expect(wiki.database().db.prepare('SELECT count(*) n FROM knowledge_page_sources').get().n).toBe(1);
  expect(wiki.search(scope,'knowledge').items).toHaveLength(1);
});

it('publishes updates and relations addressed by frozen Wiki document IDs', async () => {
  await wiki.start(scope, { kind: 'ingest', documentIds: [doc] }, 'parent');
  await settle();
  const original = wiki.database().pages(scope.identity).items[0];
  runTask.mockImplementation(async (_ctx, _llm, _config, { runtime }) => {
    for (const entry of runtime.documents) {
      runtime.read({ documentId: entry.id });
    }
    const evidence = [{ documentId: doc, version: 1, startLine: 1, endLine: 2 }];
    runtime.submit({ result: {
      pages: [
        { title: 'Updated topic', pageType: 'concept', pageId: 'wiki:' + original.id,
          body: 'Updated fact.', evidence },
        { title: 'New topic', pageType: 'entity', entityKey: 'entity:new', body: 'Related fact.', evidence },
      ],
      refs: [{ fromKey: 'entity:new', toKey: 'wiki:' + original.id, refType: 'related', evidence }],
    } });
    return { isError: false };
  });
  const job = await wiki.start(scope, { kind: 'ingest', documentIds: [doc] }, 'parent');
  await settle();
  const saved = wiki.database().job(scope.identity, job.id);
  expect(saved.status).toBe('completed');
  expect(wiki.database().candidate(scope.identity, saved.candidateId).status).toBe('published');
  const updated = wiki.database().page(scope.identity, original.id);
  expect(updated.body).toBe('Updated fact.');
  expect(updated.refs).toHaveLength(1);
  expect(updated.refs[0].toPageId).toBe(original.id);
});

it('accepts legacy pending candidates using Wiki evidence aliases without weakening scope checks', async () => {
  await wiki.start(scope, { kind: 'ingest', documentIds: [doc] }, 'parent');
  await settle();
  const original = wiki.database().pages(scope.identity).items[0];
  const originalJob = wiki.database().jobs(scope.identity)[0];
  const page = wiki.database().page(scope.identity, original.id);
  const snapshotId = wiki.database().snapshot(scope.identity, {
    id: 'wiki:' + page.id, pageId: page.id, kind: 'wiki', version: page.version, body: page.body,
  });
  const job = { ...originalJob, manifest: [...originalJob.manifest, {
    id: 'wiki:' + page.id, pageId: page.id, kind: 'wiki', version: page.version,
    scopeId: scope.identity, hash: digest(page.body), snapshotId,
  }] };
  const evidence = page.revision.evidence;
  const candidate = wiki.stage(scope, job, {
    pages: [{ title: 'New', pageType: 'concept', entityKey: 'new', body: 'New fact.', evidence }],
    refs: [{ fromKey: 'new', toKey: 'wiki:foreign', refType: 'related', evidence }],
  }, await wiki.settings());
  await expect(wiki.publish(scope, candidate.id, candidate.version)).rejects.toThrow('WIKI_REFERENCE_INVALID');
  expect(wiki.database().pages(scope.identity).items).toHaveLength(1);
  candidate.refs[0].toKey = 'wiki:' + original.id;
  wiki.database().saveCandidate(candidate);
  await expect(wiki.publish(scope, candidate.id, candidate.version)).resolves.toMatchObject({ status: 'succeeded' });
  expect(wiki.database().page(scope.identity, original.id).refs).toHaveLength(1);
});
it('keeps human edits and rejects stale candidate publication',async()=>{
  await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');await settle();
  let page=wiki.database().pages(scope.identity).items[0];
  await wiki.editPage(scope,page.id,{expectedVersion:page.version,body:'Human edit.'});
  const job=await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');await settle();
  expect(wiki.database().page(scope.identity,page.id).body).toBe('Human edit.');
  const candidate=wiki.database().candidate(scope.identity,wiki.database().job(scope.identity,job.id).candidateId);
  expect(candidate.status).toBe('pending');
  page=wiki.database().page(scope.identity,page.id);await wiki.editPage(scope,page.id,{expectedVersion:page.version,body:'Concurrent edit.'});
  await expect(wiki.publish(scope,candidate.id,candidate.version)).rejects.toThrow('WIKI_VERSION_CONFLICT');
});
it('queries frozen evidence and saves the answer as a reviewable candidate',async()=>{
  const job=await wiki.start(scope,{kind:'query',instruction:'Source',documentIds:[doc]},'parent');await settle();
  expect(wiki.database().job(scope.identity,job.id).result.answer).toBe('A supported answer.');
  expect(wiki.database().pages(scope.identity).items).toHaveLength(0);
  const candidate=await wiki.saveAnswer(scope,job.id,{title:'Answer'});
  expect(candidate.status).toBe('pending');
  await wiki.publish(scope,candidate.id,candidate.version);
  expect(wiki.database().pages(scope.identity).items).toHaveLength(1);
});
it('defers disabled automation and retains a reason', async () => {
  await wiki.consume(scope);
  expect(wiki.database().outbox(scope.identity)).toHaveLength(0);
  expect(wiki.database().logs(scope.identity).items).toMatchObject([
    { operation: 'update_deferred', detail: { reason: 'manual_update' } },
  ]);
});
it('rejects unread evidence and invalid line references',()=>{
  const runtime=new WikiRuntime([{id:'d',version:1,body:'Fact',kind:'source'}],{maxResultBytes:10000,maxAffectedPages:30,maxSourceDocuments:30},{limit:200000},new AbortController().signal,'query');
  expect(()=>runtime.submit({result:{answer:'Answer',evidence:[]}})).toThrow('WIKI_EVIDENCE_INCOMPLETE');
  runtime.read({documentId:'d'});
  expect(()=>runtime.submit({result:{answer:'Answer',evidence:[{documentId:'d',version:1,startLine:1,endLine:2}]}})).toThrow('WIKI_REFERENCE_INVALID');
});
it('fences a deleted execution while a newer execution completes',async()=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const original=runTask.getMockImplementation();runTask.mockImplementationOnce(async(...args)=>{await blocked;return original(...args);});
  const old=await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');
  expect(wiki.cancel(scope,old.id,true).status).toBe('deleted');
  const current=await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');
  release();await settle();
  expect(wiki.database().job(scope.identity,old.id).status).toBe('deleted');
  expect(wiki.database().job(scope.identity,current.id).status).toBe('completed');
  expect(wiki.database().pages(scope.identity).items).toHaveLength(1);
});
it('waits for cancellation cleanup before unload resolves',async()=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
  runTask.mockImplementationOnce(async(_ctx,_llm,_config,{signal})=>{entered();await new Promise(resolve=>{release=resolve;});signal.throwIfAborted();});
  const job=await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');await ready;
  let closed=false;const closing=wiki.close().then(()=>{closed=true;});
  await Promise.resolve();expect(closed).toBe(false);release();await closing;
  expect(knowledge.database().db.prepare('SELECT status FROM knowledge_jobs WHERE id=?').get(job.id).status).toBe('cancelled');
});
it('marks unfinished persisted jobs and outbox events interrupted on restart',()=>{
  const db=wiki.database();db.saveJob({id:'interrupted',scopeId:scope.identity,status:'running',epoch:'old'});
  db.eventState(db.outbox(scope.identity)[0].sequence,'queued');
  new WikiStore(knowledge.database());
  expect(db.job(scope.identity,'interrupted').status).toBe('interrupted');
  expect(db.db.prepare('SELECT status FROM knowledge_outbox').get().status).toBe('interrupted');
});
it('keeps summary history across source versions and rejects unregistered scope queries',async()=>{
  config.wiki.smallFileThresholdBytes=0;
  await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');await settle();
  expect(wiki.database().summary(scope.identity,doc).sourceVersion).toBe(1);
  expect(wiki.database().db.prepare('SELECT count(*) n FROM knowledge_summary_revisions').get().n).toBe(1);
  await expect(wiki.start(scope,{kind:'query',instruction:'Source',scopeIds:['forged']},'parent')).rejects.toThrow('WIKI_SCOPE_DENIED');
});
it('shares route operations and preserves rejected relations when identical evidence recurs',async()=>{
  const adapter=createWikiRoutes(knowledge,ctx,{service:wiki});const ops=createOperations(adapter.routes);
  const generated=runTask.getMockImplementation();
  runTask.mockImplementation(async(...args)=>{
    await generated(...args);const runtime=args[3].runtime,first=runtime.result.pages[0];
    runtime.result.pages.push({...first,title:'Overview',entityKey:'overview:topic',pageType:'overview'});
    runtime.result.refs=[{fromKey:'concept:topic',toKey:'overview:topic',refType:'related',evidence:first.evidence}];return {isError:false};
  });
  await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');await settle();
  const page=wiki.database().pages(scope.identity).items.find(page=>page.title==='Topic');
  const ref=wiki.database().page(scope.identity,page.id).refs[0];
  // The Agent entry cannot approve a relation or publish a candidate.
  expect((await ops.execute({action:'wiki-refs-item',id:ref.id,method:'PUT',body:{workspaceId:'ws',expectedVersion:ref.version,decision:'accepted'}},{})).status).toBe(403);
  wiki.database().db.prepare('INSERT INTO knowledge_review_decisions VALUES (?,?,?,?)').run(scope.identity,ref.id,ref.evidenceHash,JSON.stringify({decision:'rejected',actor:'user'}));
  await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');await settle();
  expect(wiki.database().page(scope.identity,page.id).refs[0].reviewState).toBe('rejected');
  const history=await ops.execute({action:'wiki-revisions',id:page.id,query:{workspaceId:'ws',limit:1}},{});
  expect(history.value.hasMore).toBe(true);expect(history.value.items).toHaveLength(1);
  const bad=await ops.execute({action:'wiki-backfill',method:'POST',body:{workspaceId:'ws',documentIds:'bad'}},{});
  expect(bad.status).toBe(400);
  const settings=await ops.execute({action:'wiki-settings',query:{workspaceId:'ws'}},{});expect(settings.value.version).toMatch(/^[a-f0-9]{64}$/);
  await adapter.dispose();
});
it('restores exported pages as candidates and rejects changed source evidence',async()=>{
  await wiki.start(scope,{kind:'ingest',documentIds:[doc]},'parent');await settle();
  const adapter=createWikiRoutes(knowledge,ctx,{service:wiki}),ops=createOperations(adapter.routes);
  const backup=(await ops.execute({action:'wiki-export',query:{workspaceId:'ws'}},{})).value;
  const page=wiki.database().pages(scope.identity).items[0];
  await wiki.editPage(scope,page.id,{body:'Changed by user',expectedVersion:1});
  const restored=await wiki.restore(scope,backup);expect(restored.candidate.pages[0].baseBody).toBe('Changed by user');
  expect(wiki.database().page(scope.identity,page.id).body).toBe('Changed by user');
  await wiki.publish(scope,restored.candidate.id,restored.candidate.version);
  expect(wiki.database().page(scope.identity,page.id).body).toBe('Supported knowledge.');
  backup.snapshots[0].body='Unverified evidence';await expect(wiki.restore(scope,backup)).rejects.toThrow('WIKI_SOURCE_STALE');
  await adapter.dispose();
});
it('runs explicit backfill while automatic ingestion is disabled',async()=>{
  const adapter=createWikiRoutes(knowledge,ctx,{service:wiki}),ops=createOperations(adapter.routes);
  const result=await ops.execute({action:'wiki-backfill',method:'POST',body:{workspaceId:'ws',documentIds:[doc]}},{agent:{session:{id:'parent'}}});
  expect(result.status).toBe(200);await settle();
  expect(wiki.database().pages(scope.identity).items).toHaveLength(1);
  await adapter.dispose();
});
