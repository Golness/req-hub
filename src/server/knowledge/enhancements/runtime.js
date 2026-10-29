import { randomUUID } from 'node:crypto';
import { runtimeForRequest } from '../../delegation-context.js';
import { syncReadPage } from '../../sync-budget.js';
import { estimateSubagentInputTokens } from '../../token-utils.js';
import { bounded, digest, fail } from './contracts.js';

export const ENHANCEMENT_TOOLS = ['req_hub_enhancement_read', 'req_hub_enhancement_submit'];
export class EnhancementRuntime {
  constructor(documents, budget, settings, signal) {
    this.id = randomUUID(); Object.assign(this, { documents, budget, settings, signal }); this.coverage = new Map(); this.contextCost = 0; this.exposedCost = 0;
  }
  charge(value) {
    this.signal.throwIfAborted();
    const cost = estimateSubagentInputTokens(JSON.stringify(value));
    if (this.contextCost + this.exposedCost + cost + 16000 >= this.budget.limit) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
    this.exposedCost += cost; return value;
  }
  read({ documentId, offset = 0 }) {
    const doc = this.documents.find(item => item.id === documentId);
    if (!doc || !Number.isSafeInteger(offset) || offset < 0 || offset > (this.coverage.get(documentId) || 0) || offset > doc.body.length) fail('ENHANCEMENT_REFERENCE_INVALID', 422);
    if (offset < doc.body.length && /[\uDC00-\uDFFF]/.test(doc.body[offset])) fail('ENHANCEMENT_REFERENCE_INVALID', 422);
    const result = syncReadPage(documentId, doc.body, offset, 8000, digest(doc.body), undefined, page => ({ ...page, documentId, version: doc.version }));
    this.charge(result); this.coverage.set(doc.id, Math.max(result.nextOffset, this.coverage.get(doc.id) || 0)); return result;
  }
  submit({ result }) {
    bounded(result, this.settings.maxResultBytes);
    const missing = this.documents.filter(doc => this.coverage.get(doc.id) !== doc.body.length);
    if (missing.length) fail('ENHANCEMENT_RESULT_INCOMPLETE', 422, { next: missing.map(doc => ({ documentId: doc.id, offset: this.coverage.get(doc.id) || 0 })) });
    if (!result || !Array.isArray(result.findings) || result.findings.length > 200 || !Array.isArray(result.patterns) || result.patterns.length > 20) fail('ENHANCEMENT_RESULT_INVALID', 422);
    const evidence = refs => {
      if (!Array.isArray(refs) || !refs.length || refs.length > this.documents.length) fail('ENHANCEMENT_REFERENCE_INVALID', 422, { field: 'evidence', expected: 'non-empty array of selected document/version/line references' });
      return refs.map(ref => {
        if (!ref || typeof ref !== 'object') fail('ENHANCEMENT_REFERENCE_INVALID', 422, { field: 'evidence', expected: 'documentId, version, startLine, endLine' });
        const doc = this.documents.find(item => item.id === ref.documentId);
        if (!doc || ref.version !== doc.version || !Number.isSafeInteger(ref.startLine) || !Number.isSafeInteger(ref.endLine) || ref.startLine < 1 || ref.endLine < ref.startLine || ref.endLine > doc.body.split('\n').length) fail('ENHANCEMENT_REFERENCE_INVALID', 422, { field: 'evidence', documentId: ref?.documentId, allowed: this.documents.map(item => ({ documentId: item.id, version: item.version, lines: item.body.split('\n').length })) });
        const quote = doc.body.split('\n').slice(ref.startLine - 1, ref.endLine).join('\n');
        if (quote.length > 12000) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
        return { documentId: doc.id, version: doc.version, startLine: ref.startLine, endLine: ref.endLine, quote };
      });
    };
    const findings = result.findings.map((finding, index) => {
      if (!finding || typeof finding.reason !== 'string' || !finding.reason.trim() || finding.reason.length > 4000 || finding.proposal != null && (typeof finding.proposal !== 'string' || finding.proposal.length > 12000)) fail('ENHANCEMENT_RESULT_INVALID', 422);
      return { id: `finding-${index}`, kind: 'possible_issue', status: 'needsConfirmation', reason: finding.reason,
        subject: String(finding.subject || '').slice(0, 500), applicability: String(finding.applicability || '').slice(0, 1000),
        question: String(finding.question || '').slice(0, 2000), proposal: finding.proposal || null, evidence: evidence(finding.evidence) };
    });
    const patterns = result.patterns.map((pattern, index) => {
      if (typeof pattern.content !== 'string' || !pattern.content.trim() || pattern.content.length > 12000) fail('ENHANCEMENT_RESULT_INVALID', 422);
      return { id: `pattern-${index}`, content: pattern.content, evidence: evidence(pattern.evidence), status: 'candidate' };
    });
    this.result = { findings, patterns, coverage: { requestedDocuments: this.documents.length, fullyReadDocuments: this.documents.length, truncated: false }, method: 'semantic' };
    return { submitted: true };
  }
}

export function installEnhancementTools(ctx) {
  const runtimes = new Map(), sessions = new Map(), disposers = [];
  for (const [index, name] of ENHANCEMENT_TOOLS.entries()) disposers.push(ctx.tools.register({
    name, description: index ? 'Submit evidence-grounded findings and exemplar patterns. All selected documents must be read fully first.' : 'Read only a selected frozen document, follow nextOffset until eof.',
    parameters: { type: 'object', properties: index ? { result: { type: 'object' } } : { documentId: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: index ? ['result'] : ['documentId'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute(args, exec) {
      exec.signal?.throwIfAborted(); const runtime = sessions.get(exec.agent?.session?.id);
      if (!runtime || runtime.closed) fail('ENHANCEMENT_SCOPE_DENIED', 403);
      if (!index) return runtime.read(args);
      try { return runtime.submit(args); }
      catch (error) {
        runtime.invalidWrites = (runtime.invalidWrites || 0) + 1;
        const message = error.message + ': ' + JSON.stringify({ ...error.details, attempt: runtime.invalidWrites, limit: runtime.settings.maxInvalidOutputWrites || 3 });
        if (runtime.invalidWrites >= (runtime.settings.maxInvalidOutputWrites || 3)) runtime.outputFailure = new Error('ENHANCEMENT_RESULT_INVALID');
        throw new Error(message);
      }
    },
  }));
  disposers.push(ctx.tools.guard(exec => sessions.has(exec.agent?.session?.id) && ![...ENHANCEMENT_TOOLS, 'run_code'].includes(exec.name) ? 'ENHANCEMENT_SCOPE_DENIED' : undefined));
  disposers.push(ctx.on('llm/stream', async function* (request, next) {
    const runtime = sessions.get(request.sessionId) || runtimeForRequest(ctx, runtimes, request);
    if (runtime) {
      if (runtime.closed) fail('ENHANCEMENT_SCOPE_DENIED', 403);
      if (runtime.outputFailure) throw runtime.outputFailure;
      runtime.signal.throwIfAborted(); runtime.contextCost = estimateSubagentInputTokens(JSON.stringify({ messages: request.messages, system: request.system, tools: request.tools, toolHistory: request.toolHistory })); runtime.exposedCost = 0;
      runtime.charge({});
    }
    yield* next();
  }, { global: true, prepend: true }));
  return {
    add(runtime) { runtime.bindSession = id => sessions.set(id, runtime); runtimes.set(runtime.id, runtime); },
    close(runtime) { runtime.closed = true; runtimes.delete(runtime.id); if (runtime.sessionId) sessions.set(runtime.sessionId, { closed: true }); if (sessions.size > 500) sessions.delete(sessions.keys().next().value); },
    async dispose() { for (const dispose of disposers.reverse()) await dispose(); sessions.clear(); runtimes.clear(); },
  };
}
