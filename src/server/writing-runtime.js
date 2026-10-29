import { runtimeForRequest } from './delegation-context.js';
import { syncReadPage } from './sync-budget.js';
import { randomUUID } from 'node:crypto';
import { relevanceScore } from './knowledge/retrieval.js';
import { estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';

export const WRITING_TOOLS = ['req_hub_writing_search', 'req_hub_writing_read', 'req_hub_writing_submit'];

/** Frozen, selected knowledge only. Reading is paginated; submission records actual evidence. */
export class WritingRuntime {
  constructor(scopes, documents, budget = { limit: MAX_SYNC_INPUT_TOKENS }) {
    this.budget = budget;
    this.id = randomUUID(); this.scopes = scopes; this.documents = documents;
    this.searched = new Set(); this.available = new Set(); this.coverage = new Map();
    this.contextCost = 0; this.exposedCost = 0; this.activity = { stage: 'preparing', searched: 0, read: 0, searches: 0, hits: 0, outputCharacters: 0, reasoningCharacters: 0, toolCharacters: 0, toolErrors: 0 };
  }
  updateActivity(update) { this.activity = { ...this.activity, ...update }; this.onActivity?.(this.activity); }
  recordActivity(update) { this.updateActivity({ ...update, lastActivityAt: Date.now() }); }
  charge(value) {
    const cost = estimateSubagentInputTokens(JSON.stringify(value));
    if (this.contextCost + this.exposedCost + cost + 16000 >= this.budget.limit) throw new Error('知识资料超出本轮上下文预算，请减少所选知识库或缩小优化范围');
    this.exposedCost += cost; return value;
  }
  search({ scopeId, query }) {
    if (!this.scopes.some(s => s.id === scopeId) || typeof query !== 'string' || !query.trim()) throw new Error('WRITING_SEARCH_INVALID: ' + JSON.stringify({ allowedScopeIds: this.scopes.map(scope => scope.id), expected: { scopeId: 'exact selected id', query: 'non-empty string' } }));
    this.searched.add(scopeId);
    const hits = this.documents.filter(d => d.scopeId === scopeId).map(d => ({ ...d, score: relevanceScore(d, query) }))
      .sort((a, b) => b.score - a.score).slice(0, 8);
    for (const hit of hits) this.available.add(hit.id);
    const result = this.charge({ scopeId, hits: hits.map(hit => ({ id: hit.id, scopeId, title: hit.title, version: hit.version, snippet: hit.body.slice(0, 240), sources: hit.sources.map(source => ({ relativePath: source.relativePath, ...(source.workspaceTitle ? { workspaceTitle: source.workspaceTitle } : {}) })) })) });
    this.recordActivity({ stage: 'searching', searched: this.searched.size, searches: this.activity.searches + 1, hits: hits.length });
    return result;
  }
  read({ id, offset = 0 }) {
    const doc = this.documents.find(d => d.id === id);
    if (!doc || !this.available.has(id)) throw new Error('WRITING_READ_INVALID: ' + JSON.stringify({ availableIds: [...this.available].slice(-16), instruction: 'Read an exact hits[].id returned by search; do not invent IDs.' }));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > (this.coverage.get(id) || 0) || offset > doc.body.length) throw new Error('无效的读取位置');
    if (offset < doc.body.length && /[\uDC00-\uDFFF]/.test(doc.body[offset])) throw new Error('WRITING_READ_SURROGATE');
    const result = this.charge(syncReadPage(id, doc.body, offset, 8000, '', undefined, page => ({ ...page, id, sources: doc.sources, version: doc.version })));
    this.coverage.set(id, Math.max(result.nextOffset, this.coverage.get(id) || 0));
    this.recordActivity({ stage: 'reading', read: [...this.coverage].filter(([key, length]) => this.documents.find(item => item.id === key)?.body.length === length).length });
    return result;
  }
  completionState() {
    const fullyRead = this.documents.filter(doc => this.available.has(doc.id) && this.coverage.has(doc.id) && this.coverage.get(doc.id) === doc.body.length);
    const unsearched = this.scopes.filter(scope => !this.searched.has(scope.id));
    const missingEvidence = this.scopes.filter(scope => this.documents.some(doc => doc.scopeId === scope.id) && !fullyRead.some(doc => doc.scopeId === scope.id));
    const nextReads = missingEvidence.map(scope => this.documents.find(doc => doc.scopeId === scope.id && this.available.has(doc.id))).filter(Boolean)
      .slice(0, 3).map(doc => ({ id: doc.id, offset: this.coverage.get(doc.id) || 0 }));
    return { unsearchedScopes: unsearched.map(scope => scope.id), missingEvidenceScopes: missingEvidence.map(scope => scope.id), nextReads, fullyReadIds: fullyRead.map(doc => doc.id), submitted: !!this.result };
  }
  submit({ content, evidenceIds, overview }) {
    if (this.failure) throw this.failure;
    if (this.scopes.some(s => !this.searched.has(s.id))) throw new Error('必须检索每个所选知识库');
    if (typeof content !== 'string' || !content.trim() || content.length > 120000 || !Array.isArray(evidenceIds)) throw new Error('候选文档或引用无效');
    const evidence = [...new Set(evidenceIds)].map(id => {
      const doc = this.documents.find(d => d.id === id);
      if (!doc || !this.available.has(id) || this.coverage.get(id) !== doc.body.length) throw new Error('引用正文必须完整读取');
      const { body, ...source } = doc; return source;
    });
    for (const scope of this.scopes) {
      if (this.documents.some(d => d.scopeId === scope.id) && !evidence.some(d => d.scopeId === scope.id)) throw new Error('每个非空知识库至少需要读取并引用一篇资料');
    }
    if (overview !== undefined && (typeof overview !== 'string' || overview.length > 8000)) throw new Error('WRITING_OVERVIEW_INVALID');
    this.recordActivity({ stage: 'submitted' });
    this.result = { content, evidence, ...(overview ? { overview } : {}) }; return { success: true };
  }
}

export function installWritingTools(ctx) {
  if (!ctx?.tools?.register || !ctx.tools.guard || !ctx.on) throw new Error('写作需要 Harness 受控工具支持');
  const runtimes = new Map(), sessions = new Map(), disposers = [];
  const properties = [
    { scopeId: { type: 'string' }, query: { type: 'string' } },
    { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
    { overview: { type: 'string', description: 'Separate review summary; never insert it into document content' }, content: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } } },
  ];
  for (const [i, name] of WRITING_TOOLS.entries()) disposers.push(ctx.tools.register({
    name, description: ['Search one exact selected scopeId. Returns {scopeId,hits:[{id,title,version,snippet,sources}]}. Read hits[].id before citing; an empty hits array means no records.', 'Read frozen knowledge; follow nextOffset until eof before citing.', 'Submit the complete optimized Markdown and IDs of fully read evidence.'][i],
    parameters: { type: 'object', properties: properties[i], required: Object.keys(properties[i]).filter(k => !['offset', 'overview'].includes(k)), additionalProperties: false },
    output: { schema: i === 0 ? { type: 'object', properties: { scopeId: { type: 'string' }, hits: { type: 'array', items: { type: 'object' } } }, required: ['scopeId', 'hits'] } : { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      exec.signal?.throwIfAborted();
      const runtime = sessions.get(exec.agent?.session?.id);
      if (!runtime || runtime.closed) throw new Error('WRITING_TOOL_DENIED');
      if (runtime.failure) throw runtime.failure;
      try {
        const value = runtime[['search', 'read', 'submit'][i]](args); runtime.repairFailures = 0; return value;
      } catch (error) {
        runtime.recordActivity({ stage: 'tool_error', toolErrors: runtime.activity.toolErrors + 1, lastTool: name });
        runtime.repairFailures = (runtime.repairFailures || 0) + 1;
        // A bounded correction protocol: invalid tools cannot run indefinitely.
        if (runtime.repairFailures >= 3) {
          runtime.failure = new Error('WRITING_TOOL_FAILED'); runtime.onFatal?.(runtime.failure);
          throw runtime.failure;
        }
        throw new Error(error.message + ' ' + JSON.stringify({ attempt: runtime.repairFailures, limit: 3, instruction: 'Correct from the exact selected IDs. Never bypass selected knowledge or claim completion after an error.' }));
      }
    },
  }));
  disposers.push(ctx.tools.guard(exec => sessions.has(exec.agent?.session?.id) && !WRITING_TOOLS.includes(exec.name) && exec.name !== 'run_code' ? '写作仅允许读取所选知识库与提交候选文档' : undefined));
  // A one-shot may produce prose resembling tool calls and then stop. Only
  // tool receipts establish completion; never parse that prose into operations.
  disposers.push(ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    const runtime = sessions.get(agent.session.id);
    if (!runtime || runtime.closed || runtime.failure || runtime.result || signal?.aborted || runtime.signal?.aborted || typeof agent.steer !== 'function') return;
    if ((runtime.completionReminders || 0) >= 3) {
      runtime.failure = new Error('WRITING_RESULT_INCOMPLETE'); runtime.onFatal?.(runtime.failure); return;
    }
    runtime.completionReminders = (runtime.completionReminders || 0) + 1;
    runtime.recordActivity({ stage: 'repairing', completionReminders: runtime.completionReminders });
    const text = 'ReqHub has NOT received a successful req_hub_writing_submit result. This task is incomplete. Continue in the SAME turn using the actual callable tools or run_code SDK exposed to you. '
      + 'Writing <function=...>, <parameter=...>, JSON calls, or tool result text in a normal answer does NOT execute tools. Do not repeat completed reads. '
      + JSON.stringify(runtime.completionState())
      + '. Search exact unsearchedScopes; read nextReads with req_hub_writing_read and follow nextOffset until eof. Then use req_hub_writing_submit with the complete optimized content and actually fully read evidenceIds. Do not claim that an output was submitted without a successful tool receipt.';
    agent.steer(Object.freeze({ id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'req-hub-writing', form: 'notice', summary: 'Writing output not submitted' }),
      content: Object.freeze([Object.freeze({ type: 'text', text })]) }));
  }, { global: true }));
  disposers.push(ctx.on('llm/stream', async function* (request, next) {
    const runtime = sessions.get(request.sessionId) || runtimeForRequest(ctx, runtimes, request);
    if (runtime) {
      if (runtime.failure) throw runtime.failure;
      if (runtime.closed || !request.sessionId || (runtime.sessionId && runtime.sessionId !== request.sessionId)) throw new Error('WRITING_SESSION_DENIED');
      runtime.updateActivity({ stage: 'waiting_model', lastRequestAt: Date.now() });
      runtime.sessionId = request.sessionId; sessions.set(request.sessionId, runtime);
      // Child-local schemas survive DSH restrict(); the provider filter and the
      // execution guard above remain authoritative, including nested dispatch.
      runtime.contextCost = estimateSubagentInputTokens(JSON.stringify({ messages: request.messages, system: request.system, tools: request.tools, toolHistory: request.toolHistory }));
      runtime.exposedCost = 0;
      if (runtime.contextCost + 16000 >= runtime.budget.limit) throw new Error('写作上下文预算不足，请缩小优化范围');
    }
    for await (const chunk of next()) {
      if (runtime && !runtime.closed) {
        if (['text-delta', 'reasoning-delta'].includes(chunk?.type) && chunk.text?.length) {
          const counter = chunk.type === 'text-delta' ? 'outputCharacters' : 'reasoningCharacters';
          runtime.recordActivity({ stage: chunk.type === 'text-delta' ? 'generating' : 'thinking', [counter]: runtime.activity[counter] + chunk.text.length });
        } else if (chunk?.type === 'tool-call-delta' && chunk.argumentsDelta?.length) runtime.recordActivity({ stage: 'tool_call', toolCharacters: runtime.activity.toolCharacters + chunk.argumentsDelta.length });
      }
      yield chunk;
    }
  }, { global: true, prepend: true }));
  return {
    add(runtime) { runtime.bindSession = id => sessions.set(id, runtime); runtimes.set(runtime.id, runtime); },
    close(runtime) { runtime.closed = true; runtimes.delete(runtime.id); if (runtime.sessionId) sessions.set(runtime.sessionId, { closed: true }); },
    dispose() { for (const dispose of disposers.reverse()) dispose(); runtimes.clear(); sessions.clear(); },
  };
}
