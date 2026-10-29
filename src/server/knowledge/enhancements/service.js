import { join, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EnhancementStore } from './store.js';
import { ACTIVE, bounded, digest, fail, limits, publicError } from './contracts.js';
import { buildGraph, impact } from './graph.js';
import { CodeProvider, codeSnapshot } from './code-provider.js';
import { indexWorkspace } from './index-runner.js';
import { documentContext, contextPath } from './document-context.js';
import { resolveKnowledgeReferences } from './knowledge-context.js';
import { checkStructure } from './quality.js';
import { EnhancementRuntime, ENHANCEMENT_TOOLS, installEnhancementTools } from './runtime.js';
import { executeTask } from '../../task-executor.js';
import { resolveSyncBudget } from '../../sync-budget.js';

export class EnhancementService {
  constructor({ knowledge, ctx, configLoader, runTask = executeTask, runIndex = indexWorkspace }) {
    Object.assign(this, { knowledge, ctx, configLoader, runTask, runIndex }); this.active = new Map(); this.tasks = new Set(); this.closed = false; this.provider = new CodeProvider(ctx);
  }
  database() { if (this.closed) fail('ENHANCEMENT_CLOSED', 503); return this.store ||= new EnhancementStore(join(dirname(this.knowledge.databasePath), 'enhancements.sqlite')); }
  async settings() { return limits(await this.configLoader()); }
  context(scope, input) { return documentContext(this, scope, input); }
  async parent(sessionId, scope) {
    const parent = this.ctx.agents?.get(sessionId);
    const cwd = parent?.session?.header?.cwd || parent?.options?.cwd;
    if (!parent || parent.status === 'stopped' || !cwd || await realpath(cwd).catch(() => null) !== await realpath(scope.workspace.path)) fail('ENHANCEMENT_SESSION_DENIED', 403);
    return parent;
  }
  async selected(scope, input, settings, signal) {
    const refs = input.documentRefs;
    if (!Array.isArray(refs) || !refs.length || refs.length > settings.maxDocuments) fail('ENHANCEMENT_INVALID_INPUT');
    const scopes = input.scopeIds === undefined ? [scope.identity] : input.scopeIds;
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > 10 || scopes.some(id => typeof id !== 'string')) fail('ENHANCEMENT_INVALID_INPUT');
    const authorized = new Map();
    for (const identity of [...new Set(scopes)]) {
      const origin = this.knowledge.database().scopes().find(item => item.id === identity);
      if (!origin) fail('ENHANCEMENT_SCOPE_DENIED', 403);
      const resolved = await this.knowledge.scope(origin.workspace_id);
      if (resolved.identity !== identity) fail('ENHANCEMENT_SCOPE_DENIED', 403);
      await this.knowledge.refreshSources(resolved); authorized.set(identity, resolved);
    }
    const documents = [], seen = new Set();
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('ENHANCEMENT_INVALID_INPUT');
      signal?.throwIfAborted(); const selected = authorized.get(ref.scopeId || scope.identity);
      if (!selected || typeof ref.id !== 'string' || seen.has(ref.id)) fail('ENHANCEMENT_REFERENCE_INVALID', 422);
      const entry = selected.store.entry(ref.id);
      if (!entry || entry.version !== ref.version || entry.sources.some(source => source.status !== 'active')) fail('ENHANCEMENT_INPUT_CHANGED', 409);
      const { versions, ...snapshot } = entry;
      seen.add(ref.id); documents.push({ ...snapshot, scopeId: selected.identity });
    }
    return bounded(documents, settings.maxInputBytes);
  }
  async recommend(scope, input) {
    let ids; try { ids = JSON.parse(input.scopeIds); } catch { fail('ENHANCEMENT_INVALID_INPUT'); }
    if (!Array.isArray(ids) || ids.length > 10 || typeof input.recommendQuery !== 'string' || input.recommendQuery.length > 500) fail('ENHANCEMENT_INVALID_INPUT');
    const hits = [];
    for (const id of [...new Set(ids)]) {
      const origin = this.knowledge.database().scopes().find(item => item.id === id);
      if (!origin) fail('ENHANCEMENT_SCOPE_DENIED', 403);
      const selected = await this.knowledge.scope(origin.workspace_id);
      if (selected.identity !== id) fail('ENHANCEMENT_SCOPE_DENIED', 403);
      await this.knowledge.refreshSources(selected);
      hits.push(...selected.store.search(input.recommendQuery, 5).hits.map(item => ({ id: item.id, scopeId: id, title: item.title, path: item.sources[0].relativePath, version: item.version, snippet: item.snippet, reason: 'fts_match' })));
    }
    return bounded({ hits }, (await this.settings()).maxResultBytes);
  }
  async catalog(scope, input = {}, sessionId) {
    const settings = await this.settings(), database = this.database(); database.scope(scope.identity);
    const scopes = [];
    for (const origin of this.knowledge.database().scopes()) {
      const current = await this.knowledge.scope(origin.workspace_id).catch(() => null);
      if (!current || current.identity !== origin.id) continue;
      scopes.push({ id: origin.id, title: origin.workspace_title, workspaceId: origin.workspace_id });
    }
    const selected = scopes.find(item => item.id === (input.scopeId || scope.identity));
    if (input.scopeId && !selected) fail('ENHANCEMENT_SCOPE_DENIED', 403);
    if (!selected) scopes.unshift({ id: scope.identity, title: scope.workspace.title || scope.workspaceId, workspaceId: scope.workspaceId });
    const selectedScope = selected ? await this.knowledge.scope(selected.workspaceId) : scope;
    const cursor = Number(input.cursor || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 100000 || input.q && input.q.length > 200) fail('ENHANCEMENT_INVALID_INPUT');
    await this.knowledge.refreshSources(selectedScope);
    const rows = selectedScope.store.listMetadata(51, cursor, input.q || '');
    const agent = sessionId ? await this.parent(sessionId, scope).catch(error => {
      if (error.message === 'ENHANCEMENT_SESSION_DENIED') return undefined;
      throw error;
    }) : undefined;
    const toolNames = new Set((this.ctx.tools?.schemas?.(agent) || []).map(tool => tool.name));
    const mcpServers = [...toolNames].flatMap(name => {
      const match = /^mcp__([A-Za-z0-9_-]{1,32})__list_repos$/.exec(name);
      return match && toolNames.has(`mcp__${match[1]}__impact`) ? [match[1]] : [];
    }).sort();
    return { enabled: settings.enabled, capabilities: { codeRefresh: true, codeIndex: true }, limits: { maxDocuments: settings.maxDocuments, maxDepth: settings.maxDepth }, scopes, scopeId: scope.identity, selectedScopeId: selectedScope.identity,
      documents: rows.slice(0, 50), nextCursor: rows.length > 50 ? cursor + 50 : null,
      jobs: database.summaries(scope.identity, 20), graph: await this.graph(scope, {}),
      mcpServer: settings.gitnexusServer,
      mcpServers,
      mcpAvailable: !!this.ctx.tools?.get?.(`mcp__${settings.gitnexusServer}__list_repos`, agent) };
  }
  async start(scope, input, sessionId) {
    if (this.closed || this.closing) fail('ENHANCEMENT_CLOSED', 503);
    const statusOnly = ['code-refresh', 'code-index'].includes(input.kind);
    const settings = await this.settings(); if (!settings.enabled && !statusOnly) fail('ENHANCEMENT_DISABLED', 409);
    if (!['graph-build', 'code-refresh', 'code-index', 'quality-check', 'consistency-check', 'pattern-propose'].includes(input.kind)) fail('ENHANCEMENT_INVALID_INPUT', 400, { field: 'kind' });
    if (typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 128) fail('ENHANCEMENT_INVALID_INPUT', 400, { field: 'requestKey' });
    if (this.active.has(scope.workspaceId) || this.active.size >= settings.maxConcurrentJobs) fail('ENHANCEMENT_BUSY', 409);
    const controller = new AbortController(); this.active.set(scope.workspaceId, { controller });
    try {
      const contextualGraph = !!input.context && input.kind === 'graph-build';
      if (input.context && !statusOnly) {
        const context = await this.context(scope, input.context);
        if (contextualGraph && context.limited) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
        const related = input.kind === 'consistency-check' ? context.related.filter(doc => doc.confirmed).map(({ id, scopeId, version }) => ({ id, scopeId, version })) : [];
        const refs = contextualGraph ? (context.graph?.documents || []).map(({ id, version }) => ({ id, version, scopeId: scope.identity })) : [...context.documentRefs, ...related];
        input = { ...input, documentRefs: [...new Map(refs.map(ref => [ref.id, ref])).values()], scopeIds: [scope.identity] };
      }
      const draft = input.draft;
      if (draft !== undefined && (!input.context || !['quality-check', 'pattern-propose'].includes(input.kind) || typeof draft !== 'string' || !draft.trim() || draft.length > 100000)) fail('ENHANCEMENT_INVALID_INPUT');
      const documents = statusOnly || draft !== undefined ? [] : await this.selected(scope, input, contextualGraph ? { ...settings, maxDocuments: settings.maxNodes } : settings, controller.signal);
      if (draft !== undefined) documents.push({ id: 'draft.' + digest(draft), scopeId: scope.identity, version: 1, type: 'document', title: 'draft', body: draft,
        sources: [{ relativePath: input.context.requirementPath ? contextPath(input.context.requirementPath + '/draft.md') : 'draft/document.md', sourceHash: digest(draft), status: 'active' }] });
      if (input.mode === 'semantic' || ['pattern-propose', 'consistency-check'].includes(input.kind)) {
        for (const { doc } of await resolveKnowledgeReferences(this.knowledge, input.referenceRefs, controller.signal)) if (!documents.some(item => item.id === doc.id)) documents.push(doc);
        if (documents.length > settings.maxDocuments + (draft !== undefined ? 1 : 0)) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
      }
      bounded(documents, settings.maxInputBytes);
      if (input.kind === 'graph-build' && documents.some(doc => doc.scopeId !== scope.identity || doc.type !== 'document')) fail('ENHANCEMENT_SCOPE_DENIED', 403);
      const semantic = input.kind === 'consistency-check' || input.kind === 'pattern-propose' || input.kind === 'quality-check' && input.mode === 'semantic';
      const parent = semantic || (input.useCode === true || statusOnly) && sessionId ? await this.parent(sessionId, scope) : undefined;
      const snapshot = input.useCode === true || statusOnly ? await codeSnapshot(scope.workspace.path, controller.signal).catch(() => null) : null;
      const fingerprint = digest([input.kind, input.mode, !!input.useCode, snapshot, settings, documents.map(doc => [doc.scopeId, doc.id, doc.version, doc.sources[0].sourceHash]), 'enhancement-v1']);
      const existing = this.database().request(scope.identity, input.requestKey, input.kind);
      if (existing) { if (existing.fingerprint !== fingerprint) fail('ENHANCEMENT_REQUEST_CONFLICT', 409); return existing; }
      const job = { id: randomUUID(), scopeId: scope.identity, workspaceId: scope.workspaceId, requestKey: input.requestKey, fingerprint, kind: input.kind, status: 'queued', codeSnapshot: snapshot, createdAt: new Date().toISOString(),
        ...(input.context ? { contextDocIds: documents.filter(doc => !doc.id.startsWith('draft.')).map(doc => doc.id), contextRequirement: input.context.requirementPath ? contextPath(input.context.requirementPath + '/draft.md').slice(0, -'/draft.md'.length) : null } : {}),
        ...(contextualGraph ? { contextualGraph: true } : {}), ...(draft !== undefined ? { draftId: documents[0].id } : {}), manifest: documents.map(doc => ({ scopeId: doc.scopeId, id: doc.id, version: doc.version, hash: doc.sources[0].sourceHash })), epoch: randomUUID() };
      this.database().transaction(() => {
        if (this.database().hasActive(scope.identity)) fail('ENHANCEMENT_BUSY', 409);
        this.database().saveJob(job);
      }); this.active.set(scope.workspaceId, { controller, job });
      const timeout = setTimeout(() => controller.abort(new Error('ENHANCEMENT_TIMEOUT')), input.kind === 'code-index' ? settings.indexTimeoutMs : settings.timeoutMs); timeout.unref?.();
      const monitor = setInterval(() => { if (this.store.job(scope.identity, job.id)?.status === 'cancelling') controller.abort(); }, 1000); monitor.unref?.();
      const task = this.run(scope, job, input, documents, settings, controller.signal, parent).finally(() => { clearTimeout(timeout); clearInterval(monitor); this.tasks.delete(task); if (this.active.get(scope.workspaceId)?.controller === controller) this.active.delete(scope.workspaceId); });
      this.tasks.add(task); return this.database().job(scope.identity, job.id);
    } finally { if (!this.active.get(scope.workspaceId)?.job) this.active.delete(scope.workspaceId); }
  }
  async verify(scope, job, input, settings, signal) { const refs = job.manifest.filter(ref => ref.id !== job.draftId); if (refs.length) await this.selected(scope, { ...input, scopeIds: [...new Set(refs.map(ref => ref.scopeId))], documentRefs: refs }, job.contextualGraph ? { ...settings, maxDocuments: settings.maxNodes } : settings, signal); }
  async run(scope, job, input, documents, settings, signal, parent) {
    const save = activity => { if (this.closed) signal.throwIfAborted(); if (activity) { job.activity = activity; if (job.kind === 'code-index' && activity.logs) job.indexLogs = activity.logs; } this.database().saveJob(job); };
    try {
      job.status = 'running'; save({ stage: 'documents', completed: 0, total: documents.length });
      let result;
      if (job.kind === 'code-refresh' || job.kind === 'code-index') {
        if (job.kind === 'code-index') await this.runIndex(scope.workspace.path, signal, save, { workers: settings.indexWorkers, readyTimeoutMs: settings.indexWorkerReadyTimeoutMs });
        const status = { references: [], relations: [] };
        await this.provider.refresh(scope, status, settings, signal, parent, save);
        result = { code: status.code, ...(job.kind === 'code-index' ? { indexUpdated: true } : {}) };
      } else if (job.kind === 'graph-build') {
        result = buildGraph(documents, scope.identity, settings);
        if (input.useCode === true) await this.provider.refresh(scope, result, settings, signal, parent, save);
      } else if (job.kind === 'quality-check' && input.mode !== 'semantic') result = checkStructure(documents);
      else { save({ stage: 'working' }); result = await this.semantic(scope, job, documents, settings, signal, parent); }
      if (!['code-refresh', 'code-index'].includes(job.kind)) { save({ stage: 'validating' }); await this.verify(scope, job, input, settings, signal); }
      signal.throwIfAborted();
      this.database().transaction(() => {
        const live = this.database().job(scope.identity, job.id);
        if (!live || live.epoch !== job.epoch || live.status === 'cancelling') fail('ENHANCEMENT_CANCELLED', 409);
        signal.throwIfAborted();
        if (job.kind === 'graph-build') result = this.database().publish(scope.identity, result, settings);
        job.result = bounded(result, settings.maxResultBytes); job.status = 'completed'; save({ stage: 'completed', completed: documents.length, total: documents.length });
      });
    } catch (error) {
      job.status = signal.aborted ? (signal.reason?.message === 'ENHANCEMENT_TIMEOUT' ? 'failed' : 'cancelled') : error.message === 'ENHANCEMENT_CANCELLED' ? 'cancelled' : 'failed'; job.error = job.status === 'cancelled' ? undefined : publicError(signal.aborted ? signal.reason || error : error);
      this.store.saveJob(job);
    } finally { this.store.retain(scope.identity, settings.retainedJobs); }
  }
  async semantic(scope, job, documents, settings, signal, parentAgent) {
    const config = await this.configLoader(), provider = this.ctx.subagents?.getProvider?.(config.ai?.delegation?.provider || 'spawn');
    if (!provider?.capabilities?.toolFilter || provider.inheritsParentContext !== false) fail('ENHANCEMENT_PROVIDER_UNSUPPORTED', 503);
    const budget = await resolveSyncBudget({ ctx: this.ctx, llm: this.ctx.llm, parentAgent, signal });
    const runtime = new EnhancementRuntime(documents, budget, settings, signal);
    this.installation ||= installEnhancementTools(this.ctx); this.installation.add(runtime);
    try {
      const result = await this.runTask(this.ctx, this.ctx.llm, config, { promptKey: 'knowledge-enhancement',
        variables: { runtimeId: runtime.id, kind: job.kind, documents: JSON.stringify(job.manifest) },
        parentAgent, cwd: scope.workspace.path, runtime, signal, toolFilter: { allow: ENHANCEMENT_TOOLS }, description: `ReqHub ${job.kind}` });
      signal.throwIfAborted(); if (result.isError || !runtime.result) fail('ENHANCEMENT_RESULT_INCOMPLETE', 422);
      return runtime.result;
    } finally { this.installation.close(runtime); }
  }
  cancel(scope, id) {
    const job = this.database().job(scope.identity, id); if (!job) fail('ENHANCEMENT_NOT_FOUND', 404);
    if (ACTIVE.has(job.status)) { (this.active.get(scope.workspaceId)?.job?.id === job.id) && this.active.get(scope.workspaceId).controller.abort(); job.status = 'cancelling'; this.database().saveJob(job); }
    return job;
  }
  async graph(scope, input) {
    const graph = this.database().current(scope.identity); if (!graph) return null;
    if (input.revision && input.revision !== graph.id || input.reviewSeq !== undefined && Number(input.reviewSeq) !== graph.reviewSeq) fail('ENHANCEMENT_REVIEW_CONFLICT', 409);
    await this.knowledge.refreshSources(scope);
    graph.stale = graph.documents.some(ref => { const entry = scope.store.entry(ref.id); return !entry || entry.version !== ref.version || entry.sources[0].sourceHash !== ref.hash || entry.sources[0].status !== 'active'; });
    if (graph.code?.snapshot) { const snapshot = await codeSnapshot(scope.workspace.path).catch(() => null); if (!snapshot || snapshot.head !== graph.code.snapshot.head || snapshot.dirty) { graph.code.status = 'stale'; for (const r of graph.relations.filter(r => r.type === 'code_related')) r.validity = 'stale'; } }
    return graph;
  }
  async impact(scope, input) { const graph = await this.graph(scope, input); if (!graph || graph.stale) fail('ENHANCEMENT_INPUT_CHANGED', 409); return impact(graph, input, await this.settings()); }
  async review(scope, input, actor) {
    if (input.jobId) {
      const job = this.database().job(scope.identity, input.jobId);
      if (!job || job.seq !== input.expectedSeq || job.status !== 'completed') fail('ENHANCEMENT_REVIEW_CONFLICT', 409);
      const pattern = job.result?.patterns?.find(item => item.id === input.resultId);
      if (!pattern || !['confirmed', 'rejected'].includes(input.decision)) fail('ENHANCEMENT_REFERENCE_INVALID', 422);
      await this.verify(scope, job, { scopeIds: [...new Set(job.manifest.map(ref => ref.scopeId))] }, await this.settings());
      pattern.status = input.decision; pattern.actor = actor; this.database().saveJob(job); return job;
    }
    const graph = await this.graph(scope, input); if (!graph || graph.stale) fail('ENHANCEMENT_INPUT_CHANGED', 409);
    return this.database().review(scope.identity, input, actor);
  }
  beginClose() { this.closing = true; for (const { controller } of this.active.values()) controller.abort(); }
  async close() { this.beginClose(); for (const { controller } of this.active.values()) controller.abort(); await Promise.allSettled([...this.tasks]); this.closed = true; await this.installation?.dispose(); this.store?.close(); }
}
