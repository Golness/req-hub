import { runtimeForRequest } from './delegation-context.js';
import { randomUUID } from 'node:crypto';
import { relevanceScore } from './knowledge/retrieval.js';
import { estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';

export const WRITING_TOOLS = ['req_hub_writing_search', 'req_hub_writing_read', 'req_hub_writing_submit'];

/** Frozen, selected knowledge only. Reading is paginated; submission records actual evidence. */
export class WritingRuntime {
  constructor(scopes, documents) {
    this.id = randomUUID(); this.scopes = scopes; this.documents = documents;
    this.searched = new Set(); this.available = new Set(); this.coverage = new Map();
    this.contextCost = 0; this.exposedCost = 0;
  }
  charge(value) {
    const cost = estimateSubagentInputTokens(JSON.stringify(value));
    if (this.contextCost + this.exposedCost + cost + 16000 >= MAX_SYNC_INPUT_TOKENS) throw new Error('知识资料超出本轮上下文预算，请减少所选知识库或缩小优化范围');
    this.exposedCost += cost; return value;
  }
  search({ scopeId, query }) {
    if (!this.scopes.some(s => s.id === scopeId) || typeof query !== 'string' || !query.trim()) throw new Error('知识库或查询无效');
    this.searched.add(scopeId);
    const hits = this.documents.filter(d => d.scopeId === scopeId).map(d => ({ ...d, score: relevanceScore(d, query) }))
      .sort((a, b) => b.score - a.score).slice(0, 8);
    for (const hit of hits) this.available.add(hit.id);
    return this.charge(hits.map(({ body, ...hit }) => ({ ...hit, snippet: body.slice(0, 240) })));
  }
  read({ id, offset = 0 }) {
    const doc = this.documents.find(d => d.id === id);
    if (!doc || !this.available.has(id)) throw new Error('请先在所选知识库搜索此文档');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > (this.coverage.get(id) || 0) || offset > doc.body.length) throw new Error('无效的读取位置');
    const end = Math.min(offset + 8000, doc.body.length);
    const result = this.charge({ id, text: doc.body.slice(offset, end), nextOffset: end, eof: end === doc.body.length, sources: doc.sources, version: doc.version });
    this.coverage.set(id, Math.max(end, this.coverage.get(id) || 0));
    return result;
  }
  submit({ content, evidenceIds }) {
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
    this.result = { content, evidence }; return { success: true };
  }
}

export function installWritingTools(ctx) {
  if (!ctx?.tools?.register || !ctx.tools.guard || !ctx.on) throw new Error('写作需要 Harness 受控工具支持');
  const runtimes = new Map(), sessions = new Map(), disposers = [];
  const properties = [
    { scopeId: { type: 'string' }, query: { type: 'string' } },
    { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
    { content: { type: 'string' }, evidenceIds: { type: 'array', items: { type: 'string' } } },
  ];
  for (const [i, name] of WRITING_TOOLS.entries()) disposers.push(ctx.tools.register({
    name, description: ['Search one selected knowledge scope. Search every selected scope.', 'Read frozen knowledge; follow nextOffset until eof before citing.', 'Submit the complete optimized Markdown and IDs of fully read evidence.'][i],
    parameters: { type: 'object', properties: properties[i], required: Object.keys(properties[i]).filter(k => k !== 'offset'), additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      exec.signal?.throwIfAborted();
      const runtime = sessions.get(exec.agent?.session?.id);
      if (!runtime || runtime.closed) throw new Error('WRITING_TOOL_DENIED');
      return runtime[['search', 'read', 'submit'][i]](args);
    },
  }));
  disposers.push(ctx.tools.guard(exec => sessions.has(exec.agent?.session?.id) && !WRITING_TOOLS.includes(exec.name) && exec.name !== 'run_code' ? '写作仅允许读取所选知识库与提交候选文档' : undefined));
  disposers.push(ctx.on('llm/stream', async function* (request, next) {
    const runtime = sessions.get(request.sessionId) || runtimeForRequest(ctx, runtimes, request);
    if (runtime) {
      if (runtime.closed || !request.sessionId || (runtime.sessionId && runtime.sessionId !== request.sessionId)) throw new Error('WRITING_SESSION_DENIED');
      runtime.sessionId = request.sessionId; sessions.set(request.sessionId, runtime);
      if (request.tools?.some(t => !WRITING_TOOLS.includes(t.name) && t.name !== 'run_code')) throw new Error('WRITING_TOOL_ISOLATION_FAILED');
      runtime.contextCost = estimateSubagentInputTokens(JSON.stringify({ messages: request.messages, system: request.system, tools: request.tools, toolHistory: request.toolHistory }));
      runtime.exposedCost = 0;
      if (runtime.contextCost + 16000 >= MAX_SYNC_INPUT_TOKENS) throw new Error('写作上下文预算不足，请缩小优化范围');
    }
    yield* next();
  }, { global: true, prepend: true }));
  return {
    add(runtime) { runtime.bindSession = id => sessions.set(id, runtime); runtimes.set(runtime.id, runtime); },
    close(runtime) { runtime.closed = true; runtimes.delete(runtime.id); if (runtime.sessionId) sessions.set(runtime.sessionId, { closed: true }); },
    dispose() { for (const dispose of disposers.reverse()) dispose(); runtimes.clear(); sessions.clear(); },
  };
}
