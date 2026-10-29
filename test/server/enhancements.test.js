import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { EnhancementService } from '../../src/server/knowledge/enhancements/service.js';
import { EnhancementStore } from '../../src/server/knowledge/enhancements/store.js';
import { buildGraph, impact } from '../../src/server/knowledge/enhancements/graph.js';
import { DEFAULTS } from '../../src/server/knowledge/enhancements/contracts.js';
import { CodeProvider } from '../../src/server/knowledge/enhancements/code-provider.js';
import { EnhancementRuntime, installEnhancementTools } from '../../src/server/knowledge/enhancements/runtime.js';
import { freezeKnowledgeContext } from '../../src/server/knowledge/enhancements/knowledge-context.js';
import { createEnhancementRoutes } from '../../src/server/routes/enhancement-routes.js';
import { createOperations } from '../../src/server/operations.js';

let root, knowledge, service, scope, ctx;
const doc = (id, path, body, version = 1) => ({ id, title: id, version, body, type: 'document', sources: [{ relativePath: path, sourceHash: `hash-${id}-${version}`, status: 'active' }] });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rh-enhancements-'));
  await mkdir(join(root, 'docs/alice/2026-10-23-order'), { recursive: true });
  await mkdir(join(root, 'docs/bob/2026-10-23-order'), { recursive: true });
  await writeFile(join(root, 'docs/alice/2026-10-23-order/requirement.md'), '# Order\n\n依赖 [Payment](../../bob/2026-10-23-order/design.md)\n\n`src/order.js`\n');
  await writeFile(join(root, 'docs/bob/2026-10-23-order/design.md'), '# Payment\n\n`src/payment.js`\n');
  const registry = { list: () => [{ id: 'w', path: root, title: 'Work' }] };
  knowledge = new KnowledgeService({ registry, databasePath: join(root, 'store/knowledge.sqlite'), configLoader: async () => ({ docsDir: 'docs' }) });
  scope = await knowledge.scope('w');
  await knowledge.build(scope, { requestKey: 'import', files: ['alice/2026-10-23-order/requirement.md', 'bob/2026-10-23-order/design.md'].map(relativePath => ({ relativePath })) });
  await Promise.all([...knowledge.tasks]);
  ctx = { tools: { get: () => undefined } };
  service = new EnhancementService({ knowledge, ctx, configLoader: async () => ({ enhancements: { enabled: true } }) });
});
afterEach(async () => { await service?.close(); await knowledge?.close(); await rm(root, { recursive: true, force: true }); });
const input = () => ({ kind: 'graph-build', requestKey: 'graph', documentRefs: scope.store.list().map(entry => ({ id: entry.id, version: entry.version, scopeId: scope.identity })), scopeIds: [scope.identity] });
const finish = async job => { await Promise.all([...service.tasks]); return service.database().job(scope.identity, job.id); };

it('materializes document links from the current source without manual document selection or MCP', async () => {
  const path = 'alice/2026-10-23-order/requirement.md';
  const context = await service.context(scope, { path });
  expect(context.indexed).toBe(true); expect(context.documents).toHaveLength(1);
  expect(context.related.some(item => item.path === 'bob/2026-10-23-order/design.md')).toBe(true);
  expect(context.graph.relations).toHaveLength(1);
  const again = await service.context(scope, { path }); expect(again.graph.id).toBe(context.graph.id);
  const relation = context.graph.relations[0];
  await service.review(scope, { expectedRevision: context.graph.id, expectedReviewSeq: context.graph.reviewSeq, resultId: relation.id, basisHash: relation.basisHash, decision: 'confirmed' }, {});
  expect((await service.context(scope, { path })).related.find(item => item.path.startsWith('bob/')).confirmed).toBe(true);
  await expect(service.context(scope, { path: '../outside.md' })).rejects.toThrow('ENHANCEMENT_SCOPE_DENIED');
  await expect(service.context(scope, { documentId: 'foreign-document' })).rejects.toThrow('ENHANCEMENT_REFERENCE_INVALID');
});
it('checks the frozen unsaved draft rather than the imported source and does not modify either', async () => {
  const original = await readFile(join(root, 'docs/alice/2026-10-23-order/requirement.md'), 'utf8');
  const job = await finish(await service.start(scope, { kind: 'quality-check', mode: 'rules', requestKey: 'draft-check', context: { requirementPath: 'alice/2026-10-23-order' }, draft: 'TODO new draft' }));
  expect(job.status).toBe('completed'); expect(job.draftId).toMatch(/^draft\./);
  expect(job.result.findings.map(item => item.kind)).toContain('missing_title');
  expect(job.result.findings.every(item => item.evidence[0].documentId === job.draftId)).toBe(true);
  expect(await readFile(join(root, 'docs/alice/2026-10-23-order/requirement.md'), 'utf8')).toBe(original);
});
it('exposes the same contextual lookup through the shared Agent action and rejects unknown workspaces', async () => {
  const routes = createEnhancementRoutes(knowledge, ctx, { configLoader: async () => ({ enhancements: { enabled: true } }) });
  try {
    const operations = createOperations(routes.routes);
    const result = await operations.execute({ action: 'knowledge-document-context', query: { workspaceId: 'w', path: 'alice/2026-10-23-order/requirement.md' } }, {});
    expect(result.status).toBe(200); expect(result.value.indexed).toBe(true); expect(result.value.related).toHaveLength(1);
    const denied = await operations.execute({ action: 'knowledge-document-context', query: { workspaceId: 'foreign', path: 'alice/2026-10-23-order/requirement.md' } }, {});
    expect(denied.status).toBeGreaterThanOrEqual(400); expect(denied.value.documents).toBeUndefined();
  } finally { await routes.dispose(); }
});
it('freezes explicitly chosen reference versions without broadening to the whole knowledge scope', async () => {
  const doc = scope.store.entryByPath('bob/2026-10-23-order/design.md');
  const refs = [{ id: doc.id, scopeId: scope.identity, version: doc.version }];
  const context = await freezeKnowledgeContext(knowledge, [], 'unrelated-query', undefined, refs);
  expect(context.map(item => item.documentId)).toEqual([doc.id]);
  await expect(freezeKnowledgeContext(knowledge, [], '', undefined, [{ ...refs[0], version: doc.version + 1 }])).rejects.toThrow('ENHANCEMENT_INPUT_CHANGED');
  await expect(freezeKnowledgeContext(knowledge, [], '', undefined, [{ ...refs[0], scopeId: 'other-workspace' }])).rejects.toThrow('ENHANCEMENT_SCOPE_DENIED');
});
it('uses the current draft plus only checked references for semantic checking and revalidates them before returning', async () => {
  const doc = scope.store.entryByPath('bob/2026-10-23-order/design.md');
  ctx.agents = { get: () => ({ status: 'idle', session: { id: 'parent', header: { cwd: root } } }) };
  const seen = [];
  service.semantic = vi.fn(async (_scope, _job, documents) => { seen.push(documents.map(item => item.id)); return { findings: [], patterns: [] }; });
  const request = { kind: 'quality-check', mode: 'semantic', requestKey: 'draft-and-ref', context: { requirementPath: 'alice/2026-10-23-order' }, draft: '# Current draft', referenceRefs: [{ id: doc.id, scopeId: scope.identity, version: doc.version }] };
  const completed = await finish(await service.start(scope, request, 'parent'));
  expect(completed.status).toBe('completed'); expect(service.semantic).toHaveBeenCalledTimes(1);
  expect(seen[0]).toEqual([completed.draftId, doc.id]);
  service.semantic = async () => { await writeFile(join(root, 'docs/bob/2026-10-23-order/design.md'), '# Changed during checking'); return { findings: [], patterns: [] }; };
  const changed = await finish(await service.start(scope, { ...request, requestKey: 'reference-changed' }, 'parent'));
  expect(changed.status).toBe('failed'); expect(changed.error.code).toBe('ENHANCEMENT_INPUT_CHANGED'); expect(changed.result).toBeUndefined();
});

it('runs manual indexing without document selection and then checks status through MCP', async () => {
  const order = [];
  service.configLoader = async () => ({ enhancements: { enabled: false, indexWorkers: 1, indexWorkerReadyTimeoutMs: 45000 } });
  service.runIndex = vi.fn(async (path, signal, progress) => { expect(path).toBe(root); signal.throwIfAborted(); order.push('index'); progress({ stage: 'index_running', percent: 45, logs: ['Parsing'] }); });
  service.provider.refresh = vi.fn(async (_scope, graph) => { order.push('mcp'); graph.code = { status: 'ready' }; });
  const job = await finish(await service.start(scope, { kind: 'code-index', requestKey: 'manual' }));
  expect(job.status).toBe('completed'); expect(job.manifest).toEqual([]);
  expect(order).toEqual(['index', 'mcp']); expect(job.result.indexUpdated).toBe(true); expect(job.result.code.status).toBe('ready');
  expect(job.indexLogs).toEqual(['Parsing']);
  expect(service.runIndex.mock.calls[0][3]).toEqual({ workers: 1, readyTimeoutMs: 45000 });
  expect((await service.catalog(scope)).capabilities.codeIndex).toBe(true);
});
it('does not report failed or cancelled indexing as successful or release its slot early', async () => {
  service.runIndex = async () => { throw new Error('ENHANCEMENT_INDEX_FAILED'); };
  service.provider.refresh = vi.fn();
  const failed = await finish(await service.start(scope, { kind: 'code-index', requestKey: 'fail' }));
  expect(failed.status).toBe('failed'); expect(service.provider.refresh).not.toHaveBeenCalled();
  let finishCleanup;
  service.runIndex = (_root, signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { finishCleanup = () => reject(signal.reason); }, { once: true }); });
  const job = await service.start(scope, { kind: 'code-index', requestKey: 'cancel' });
  service.cancel(scope, job.id);
  await expect(service.start(scope, { kind: 'code-index', requestKey: 'overlap' })).rejects.toThrow('ENHANCEMENT_BUSY');
  finishCleanup(); expect((await finish(job)).status).toBe('cancelled');
  expect(service.provider.refresh).not.toHaveBeenCalled();
});

it('refreshes workspace MCP status with enhancements disabled and no documents without replacing the graph', async () => {
  const built = await finish(await service.start(scope, input()));
  service.configLoader = async () => ({ enhancements: { enabled: false } });
  const refresh = vi.fn(async (_scope, graph) => { graph.code = { status: 'not_indexed' }; });
  service.provider.refresh = refresh;
  const job = await finish(await service.start(scope, { kind: 'code-refresh', requestKey: 'status', documentRefs: [] }));
  expect(job.status).toBe('completed'); expect(job.result.code.status).toBe('not_indexed');
  expect(job.manifest).toEqual([]); expect(refresh).toHaveBeenCalledTimes(1);
  expect(service.database().current(scope.identity).id).toBe(built.result.id);
  await expect(service.start(scope, { ...input(), requestKey: 'disabled' })).rejects.toThrow('ENHANCEMENT_DISABLED');
});

it('detects session-scoped MCP tools and preserves the authorized agent when refreshing', async () => {
  const parent = { session: { id: 'parent', header: { cwd: root } }, status: 'idle' };
  ctx.agents = { get: id => id === 'parent' ? parent : undefined };
  ctx.tools.get = vi.fn((name, agent) => name === 'mcp__gitnexus__list_repos' && agent === parent ? {} : undefined);
  ctx.tools.schemas = agent => agent === parent ? [{ name: 'mcp__GitNexus__list_repos' }, { name: 'mcp__GitNexus__impact' }, { name: 'mcp__unrelated__list_repos' }] : [];
  expect((await service.catalog(scope)).mcpAvailable).toBe(false);
  expect((await service.catalog(scope, {}, 'parent')).mcpAvailable).toBe(true);
  expect((await service.catalog(scope, {}, 'parent')).mcpServers).toEqual(['GitNexus']);
  expect((await service.catalog(scope, {}, 'unrelated')).mcpAvailable).toBe(false);
  const refresh = vi.fn(async (_scope, graph) => { graph.code = { status: 'not_indexed' }; });
  service.provider.refresh = refresh;
  const job = await finish(await service.start(scope, { ...input(), useCode: true }, 'parent'));
  expect(job.status).toBe('completed'); expect(refresh.mock.calls[0][4]).toBe(parent);
});

it('builds reproducible directory identities, separates same names and requires review for business propagation', async () => {
  const job = await finish(await service.start(scope, input()));
  expect(job.status, JSON.stringify(job.error)).toBe('completed');
  const graph = job.result; expect(graph.entities).toHaveLength(2); expect(graph.relations).toHaveLength(1);
  const relation = graph.relations[0]; expect(relation.type).toBe('explicit_dependency');
  expect(impact(graph, { entityId: relation.targetId, direction: 'dependents' }, DEFAULTS).results).toEqual([]);
  const updated = await service.review(scope, { expectedRevision: graph.id, expectedReviewSeq: graph.reviewSeq, resultId: relation.id, basisHash: relation.basisHash, decision: 'confirmed' }, { user: true });
  expect(impact(updated, { entityId: relation.targetId, direction: 'dependents' }, DEFAULTS).results[0].id).toBe(relation.sourceId);
  await expect(service.review(scope, { expectedRevision: graph.id, expectedReviewSeq: 0, resultId: relation.id, basisHash: relation.basisHash, decision: 'rejected' }, {})).rejects.toThrow('CONFLICT');
  const rebuilt = await finish(await service.start(scope, { ...input(), requestKey: 'second' }));
  expect(rebuilt.result.relations[0].reviewState).toBe('confirmed');
  await writeFile(join(root, 'docs/alice/2026-10-23-order/requirement.md'), '# Changed');
  expect((await service.graph(scope, {})).stale).toBe(true);
  await expect(service.impact(scope, { entityId: relation.targetId })).rejects.toThrow('INPUT_CHANGED');
});
it('preserves multiple documents and manual decisions across rebuilding without metadata generation', async () => {
  const a = doc('a','alice/2026-10-23-order/a.md','# A'), b = doc('b','alice/2026-10-23-order/b.md','# B'), c = doc('c','bob/2026-10-23-order/c.md','# C');
  const graph = buildGraph([a,b,c],scope.identity,DEFAULTS); service.database().scope(scope.identity);
  service.database().publish(scope.identity,graph,DEFAULTS); expect(graph.entities[0].documents).toHaveLength(2);
  const manual = service.database().review(scope.identity,{expectedRevision:graph.id,expectedReviewSeq:0,sourceId:graph.entities[0].id,targetId:graph.entities[1].id,note:'Payment first'},{});
  const relation = manual.relations[0];
  service.database().review(scope.identity,{expectedRevision:graph.id,expectedReviewSeq:manual.reviewSeq,resultId:relation.id,basisHash:relation.basisHash,decision:'rejected'},{});
  const rebuilt = service.database().publish(scope.identity,buildGraph([a,b,c],scope.identity,DEFAULTS),DEFAULTS);
  expect(rebuilt.relations[0].reviewState).toBe('rejected');
  const changed = service.database().publish(scope.identity,buildGraph([{...a,version:2},b,c],scope.identity,DEFAULTS),DEFAULTS);
  expect(changed.relations[0].reviewState).toBe('needs_review');
});
it('does not turn examples and negated statements into business dependencies or merge same titles', () => {
  const docs = [doc('a','alice/2026-10-23-order/a.md','# A\n不再依赖 [B](../../bob/2026-10-23-order/b.md)\n```js\nimport b from "src/b.js"\n```'),doc('b','bob/2026-10-23-order/b.md','# B')];
  expect(buildGraph(docs,'scope',DEFAULTS).relations).toEqual([]);
});
it('falls back to document relationships without GitNexus and never attempts indexing or shell execution', async () => {
  const original = await readFile(join(root, 'docs/alice/2026-10-23-order/requirement.md'));
  service.provider = new CodeProvider(ctx); const job = await finish(await service.start(scope,{...input(),useCode:true}));
  expect(job.status).toBe('completed'); expect(job.result.code.status).toBe('unavailable'); expect(job.result.relations).toHaveLength(1);
  expect(await readFile(join(root, 'docs/alice/2026-10-23-order/requirement.md'))).toEqual(original);
});
it('calls policy-mediated MCP names only and validates structured/text/error envelopes', async () => {
  const execute = vi.fn(async () => ({isError:false,value:{content:[{type:'text',text:'[{"name":"example"}]\n\n---\nNext'}]}}));
  const provider = new CodeProvider({tools:{get:()=>({}),execute}}), signal = new AbortController().signal;
  expect(await provider.call('gitnexus','list_repos',{},signal)).toEqual([{name:'example'}]);
  expect(execute.mock.calls[0][0]).toMatchObject({name:'mcp__gitnexus__list_repos',arguments:{},signal});
  execute.mockResolvedValue({isError:true,error:{code:'DENIED'}});
  await expect(provider.call('gitnexus','impact',{},signal)).rejects.toThrow('UNAVAILABLE');
  expect(execute.mock.calls.every(([args])=>!args.name.includes('analyze'))).toBe(true);
});
it.each(['text', 'structured'])('reads GitNexus 1.6.12 repository pagination through %s MCP content', async encoding => {
  const pages = [
    { repositories: [{ name: 'other', path: dirname(root) }], pagination: { total: 2, limit: 1, offset: 0, returned: 1, hasMore: true, nextOffset: 1 } },
    { repositories: [{ name: 'fixture', path: root }], pagination: { total: 2, limit: 1, offset: 1, returned: 1, hasMore: false } },
  ];
  const execute = vi.fn(async request => {
    const page = pages[request.arguments.offset || 0];
    return { isError: false, value: encoding === 'structured' ? { content: [], structuredContent: page } : { content: [{ type: 'text', text: JSON.stringify(page) + '\n\n---\nNext' }] } };
  });
  const provider = new CodeProvider({ tools: { get: () => ({}), execute } });
  expect(await provider.repositories('gitnexus', new AbortController().signal)).toEqual(pages.flatMap(page => page.repositories));
  expect(execute.mock.calls.map(([request]) => request.arguments)).toEqual([{}, { offset: 1 }]);
  execute.mockResolvedValue({ isError: false, value: { content: [], structuredContent: { ...pages[0], pagination: { ...pages[0].pagination, nextOffset: 0 } } } });
  await expect(provider.repositories('gitnexus', new AbortController().signal)).rejects.toThrow('ENHANCEMENT_PROVIDER_SCHEMA');
});
it('matches the repository by canonical workspace path, reports missing/stale indexes and refreshes only on explicit request', async () => {
  execFileSync('git',['init','-q'],{cwd:root});
  execFileSync('git',['add','docs'],{cwd:root});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const execute=vi.fn(async()=>({isError:false,value:{content:[],structuredContent:[]}}));
  service.provider=new CodeProvider({tools:{get:()=>({}),execute}});
  const local=await finish(await service.start(scope,input())); expect(local.result.code.status).toBe('disabled');expect(execute).not.toHaveBeenCalled();
  const missing=await finish(await service.start(scope,{...input(),requestKey:'missing-index',useCode:true}));expect(missing.result.code.status).toBe('not_indexed');
  execute.mockResolvedValue({isError:false,value:{content:[],structuredContent:[{name:'same-name-wrong-path',path:dirname(root),lastCommit:head}]}});
  const wrong=await finish(await service.start(scope,{...input(),requestKey:'wrong-root',useCode:true}));expect(wrong.result.code.status).toBe('not_indexed');
  execute.mockResolvedValue({isError:false,value:{content:[],structuredContent:[{name:'fixture',path:root,lastCommit:'0'.repeat(40)}]}});
  const stale=await finish(await service.start(scope,{...input(),requestKey:'stale-index',useCode:true}));expect(stale.result.code.status).toBe('stale');
  expect(execute.mock.calls.every(([request])=>request.name==='mcp__gitnexus__list_repos')).toBe(true);
});
it('uses a fresh matching MCP index for code candidates, keeps their origin and never promotes them to business dependencies', async () => {
  await mkdir(join(root,'src'));
  await writeFile(join(root,'src/order.js'),'import payment from "./payment.js";');
  await writeFile(join(root,'src/payment.js'),'export default 1;');
  await writeFile(join(root,'.gitignore'),'store/\n');
  execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','docs','src','.gitignore'],{cwd:root});
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],{cwd:root});
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const execute=vi.fn(async request=>({isError:false,value:{content:[],structuredContent:request.name.endsWith('list_repos')
    ? [{name:'fixture',path:root,lastCommit:head,indexedAt:'fixture-index'}]
    : {byDepth:request.arguments.target==='src/order.js'?{1:[{filePath:'src/payment.js',relationType:'IMPORTS',confidence:0.9}]}:{}} }}));
  service.provider=new CodeProvider({tools:{get:()=>({}),execute}});
  const job=await finish(await service.start(scope,{...input(),useCode:true}));
  expect(job.status,JSON.stringify(job.error)).toBe('completed');expect(job.result.code.status).toBe('ready');
  const candidate=job.result.relations.find(item=>item.type==='code_related');expect(candidate).toBeTruthy();
  expect(candidate.evidence[0]).toMatchObject({snapshot:head,coverage:'impact_candidate'});
  candidate.reviewState='confirmed';
  expect(impact(job.result,{entityId:candidate.targetId,direction:'dependents'},DEFAULTS).results).toEqual([]);
  expect(execute.mock.calls.filter(([request])=>request.name.endsWith('impact'))).toHaveLength(2);
  expect(await readFile(join(root,'src/order.js'),'utf8')).toBe('import payment from "./payment.js";');
});
it('keeps cancellation pending until the model settles, rejects overlapping jobs and prevents late results', async () => {
  let release, entered;
  const started=new Promise(resolve=>{entered=resolve;});
  ctx.agents={get:()=>({status:'idle',session:{id:'parent',header:{cwd:root}}})};
  ctx.subagents={getProvider:()=>({capabilities:{toolFilter:true},inheritsParentContext:false})};
  ctx.tools={register:()=>()=>{},guard:()=>()=>{}};ctx.on=()=>()=>{};
  service.runTask=async()=>{entered();await new Promise(resolve=>{release=resolve;});return{isError:false};};
  const job=await service.start(scope,{...input(),kind:'consistency-check'},'parent');await started;
  expect(service.cancel(scope,job.id).status).toBe('cancelling');
  await expect(service.start(scope,{...input(),requestKey:'overlap'})).rejects.toThrow('BUSY');
  release();const done=await finish(job);expect(done.status).toBe('cancelled');expect(done.result).toBeUndefined();
  expect(await service.graph(scope,{})).toBeNull();
});
it('persists task interruption across a store restart and never discards independent review decisions', () => {
  const path=join(root,'restart.sqlite');const store=new EnhancementStore(path);
  store.saveJob({id:'job',scopeId:'s',requestKey:'r',fingerprint:'f',status:'running'});store.close();
  const restarted=new EnhancementStore(path);try{expect(restarted.job('s','job').status).toBe('interrupted');}finally{restarted.close();}
});
it('enforces selected scope/version ownership and request-key fingerprints, and cannot expose a different scope job', async () => {
  await expect(service.start(scope,{...input(),documentRefs:[{id:'foreign',version:1}]})).rejects.toThrow('INPUT_CHANGED');
  const job = await finish(await service.start(scope,input()));
  expect((await service.start(scope,input())).id).toBe(job.id);
  await expect(service.start(scope,{...input(),mode:'changed'})).rejects.toThrow('CONFLICT');
  expect(service.database().job('foreign',job.id)).toBeNull();
  const refs=input().documentRefs.map(ref=>({...ref,version:999}));
  await expect(service.start(scope,{...input(),requestKey:'bad-version',documentRefs:refs})).rejects.toThrow('INPUT_CHANGED');
});
it('runs structural checks locally and never treats a rule finding as established business fact', async () => {
  await writeFile(join(root,'docs/alice/2026-10-23-order/requirement.md'),'## Empty\n\n## TODO\n待补充');
  await knowledge.build(scope,{requestKey:'new-version',files:[{relativePath:'alice/2026-10-23-order/requirement.md'}]}); await Promise.all([...knowledge.tasks]);
  const job = await finish(await service.start(scope,{...input(),kind:'quality-check'}));
  expect(job.result.method).toBe('rules'); expect(job.result.findings.some(f=>f.kind==='missing_title')).toBe(true);
  expect(job.result.findings.every(f=>f.status==='needsConfirmation'&&f.proposal===null)).toBe(true);
});
it('requires full paginated reads, exact evidence lines and selected versions before structured submission', () => {
  const documents=[doc('d','alice/2026-10-23-order/a.md','汉字'.repeat(9000))];
  const runtime=new EnhancementRuntime(documents,{limit:150000},DEFAULTS,new AbortController().signal);
  const result={findings:[{reason:'Check',evidence:[{documentId:'d',version:1,startLine:1,endLine:1}],proposal:null}],patterns:[]};
  expect(()=>runtime.submit({result})).toThrow('INCOMPLETE'); expect(()=>runtime.read({documentId:'outside'})).toThrow('REFERENCE');
  while((runtime.coverage.get('d')||0)<documents[0].body.length) runtime.read({documentId:'d',offset:runtime.coverage.get('d')||0});
  expect(()=>runtime.submit({result})).toThrow('BUDGET');
  runtime.submit({result:{findings:[],patterns:[]}}); expect(runtime.result.coverage.fullyReadDocuments).toBe(1);
});
it('isolates enhancement tools by actual owned child session and releases all listeners on disposal', async () => {
  const definitions=new Map(), guards=[], hooks=[]; const clean=vi.fn();
  const install=installEnhancementTools({tools:{register:def=>{definitions.set(def.name,def);return clean;},guard:fn=>{guards.push(fn);return clean;}},on:(_event,fn)=>{hooks.push(fn);return clean;}});
  const runtime=new EnhancementRuntime([doc('d','alice/x/a.md','# A')],{limit:150000},DEFAULTS,new AbortController().signal); install.add(runtime); runtime.bindSession('child');
  const read=definitions.get('req_hub_enhancement_read');
  expect(()=>read.execute({documentId:'d'},{agent:{session:{id:'parent'}}})).toThrow('DENIED');
  expect(read.execute({documentId:'d'},{agent:{session:{id:'child'}}}).eof).toBe(true);
  expect(guards[0]({name:'shell',agent:{session:{id:'child'}}})).toContain('DENIED');
  expect(guards[0]({name:'shell',agent:{session:{id:'unrelated'}}})).toBeUndefined();
  install.close(runtime); expect(()=>read.execute({documentId:'d'},{agent:{session:{id:'child'}}})).toThrow('DENIED'); await install.dispose(); expect(clean).toHaveBeenCalledTimes(4);
});
it('bounds traversal depth/nodes/edges, avoids cycles, and rejects code candidates as business propagation', () => {
  const entities=['a','b','c'].map(id=>({id}));
  const relation=(id,a,b,type='explicit_dependency')=>({id,sourceId:a,targetId:b,type,validity:'valid',reviewState:'confirmed'});
  const graph={id:'r',reviewSeq:0,entities,relations:[relation('ab','a','b'),relation('bc','b','c'),relation('ca','c','a')]};
  expect(impact(graph,{entityId:'b',direction:'dependents',depth:1},DEFAULTS).results.map(r=>r.id)).toEqual(['a']);
  expect(impact(graph,{entityId:'a',direction:'dependencies',depth:4},DEFAULTS).results.map(r=>r.id)).toEqual(['b','c']);
  expect(impact(graph,{entityId:'a',direction:'dependencies',maxNodes:1},DEFAULTS).limitReason).toBe('maxNodes');
  graph.relations[0].type='code_related';expect(impact(graph,{entityId:'a',direction:'dependencies'},DEFAULTS).results).toEqual([]);
});
it('freezes selected knowledge only with versions, fails oversized references and keeps code evidence separate', async () => {
  const context=await freezeKnowledgeContext(knowledge,[scope.identity],'Order');
  expect(context.length).toBeGreaterThan(0);expect(context[0].id).toMatch(/^knowledge\./);expect(JSON.parse(context[0].text).version).toBe(1);
  await expect(freezeKnowledgeContext(knowledge,['unknown'],'Order')).rejects.toThrow('DENIED');
  expect(await freezeKnowledgeContext(knowledge,undefined,'Order')).toEqual([]);
});
it('exposes the same versioned operations through the shared Agent catalog', async () => {
  const routes=createEnhancementRoutes(knowledge,ctx,{configLoader:async()=>({enhancements:{enabled:true}})});
  try {
    const operations=createOperations(routes.routes);
    const response=await operations.execute({action:'knowledge-enhancement-start',query:{workspaceId:'w'}},{signal:new AbortController().signal});
    expect(response.status).toBe(200);expect(response.value.scopeId).toBe(scope.identity);
    const denied=await operations.execute({action:'knowledge-enhancement-job',query:{workspaceId:'w'},id:'not-real'},{signal:new AbortController().signal});expect(denied.status).toBe(404);
  }finally{await routes.dispose();}
});
