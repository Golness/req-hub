import { runtimeForRequest } from './delegation-context.js';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hashBytes, decodeDocument } from './sync-artifacts.js';
import { estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';
import { resolveSyncBudget, syncReadPage } from './sync-budget.js';
import { validateCandidate, assertEditInBlock } from './sync-document-validator.js';

export const SYNC_TOOLS = ['req_hub_sync_read', 'req_hub_sync_write', 'req_hub_sync_edit'];
export const OUTPUT_LIMIT = 12000;
export const REQUEST_RESERVE = 8192;
const installations = new WeakMap();

/** Install global definitions, but authorize every call by its host-owned child session. */
export function installSyncTools(ctx) {
  if (installations.has(ctx)) return installations.get(ctx);
  if (!ctx?.tools?.register || !ctx.tools.guard || !ctx.on) return null;
  const runtimes = new Map(), sessions = new Map(), disposers = [];
  const runtimeFor = exec => {
    exec.signal?.throwIfAborted();
    const runtime = sessions.get(exec.agent?.session?.id);
    if (!runtime || runtime.closed) throw new Error('SYNC_TOOL_DENIED');
    runtime.assertActive?.();
    runtime.signal?.throwIfAborted();
    runtime.onActivity?.();
    return runtime;
  };
  const schemas = {
    req_hub_sync_read: { artifactId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 8000 } },
    req_hub_sync_write: { outputId: { type: 'string' }, content: { type: 'string' } },
    req_hub_sync_edit: { blockId: { type: 'string' }, expectedHash: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
  };
  for (const name of SYNC_TOOLS) disposers.push(ctx.tools.register({
    name, description: name === SYNC_TOOLS[0] ? 'Read immutable sync evidence by artifact ID; follow nextOffset until eof.' : name === SYNC_TOOLS[1] ? 'Write one assigned analysis output. Never use this tool to overwrite a candidate document.' : 'Edit an authorized candidate block through the native exact editor. Supply the current candidate hash. Read candidate again after each edit.',
    parameters: { type: 'object', properties: schemas[name], required: Object.keys(schemas[name]).filter(key => !['offset', 'limit'].includes(key)), additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const runtime = runtimeFor(exec);
      if (name === SYNC_TOOLS[0]) return runtime.read(args);
      if (name === SYNC_TOOLS[1]) return runtime.write(args);
      return runtime.edit(args, exec);
    },
  }));
  disposers.push(ctx.tools.guard(exec => {
    const runtime = sessions.get(exec.agent?.session?.id);
    if (runtime && !SYNC_TOOLS.includes(exec.name) && exec.name !== 'run_code') return '同步 v2 禁止旁路工具';
    return undefined;
  }));
  disposers.push(ctx.on('llm/stream', async function* (request, next) {
    const runtime = sessions.get(request.sessionId) || runtimeForRequest(ctx, runtimes, request);
    if (runtime) {
      if (runtime.closed) throw new Error('SYNC_RUNTIME_CLOSED');
      if (runtime.evidenceCompacted) throw new Error('SYNC_EVIDENCE_COMPACTED');
      runtime.assertActive?.();
      runtime.signal?.throwIfAborted();
      runtime.onActivity?.();
      const budget = await resolveSyncBudget({ ctx, parentAgent: runtime.parentAgent, request, signal: runtime.signal });
      runtime.inputLimit = Math.min(runtime.budget?.limit ?? MAX_SYNC_INPUT_TOKENS, budget.limit);
      const surface = { messages: request.messages, system: request.system, tools: request.tools, toolHistory: request.toolHistory };
      const child = ctx.agents?.get?.(request.sessionId);
      const meter = child?.ctx?.get?.('tokenMeter');
      const measured = meter && child?.session ? meter.measure(child.session).totalTokens : 0;
      const cost = Math.max(estimateSubagentInputTokens(JSON.stringify(surface)), measured);
      if (cost + REQUEST_RESERVE >= runtime.inputLimit) throw new Error('SYNC_REQUEST_BUDGET_EXCEEDED');
      // DSH restrict() filters inherited capabilities, but deliberately retains
      // child-local registrations. A schema is not execution authority: the
      // provider's toolFilter and our unconditional guard enforce the boundary,
      // including nested run_code dispatch. Do not abort a valid child merely
      // because the Host contributes a scope-local schema.
      runtime.contextCost = cost;
      runtime.exposedSinceRequest = 0;
      runtime.maxRequestCost = Math.max(runtime.maxRequestCost || 0, cost);
    }
    yield* next();
  }, { global: true, prepend: true }));
  disposers.push(ctx.on('session/event', (session, event) => {
    const runtime = sessions.get(session.id);
    if (runtime && !runtime.closed && ['compaction/prune', 'compaction/summary'].includes(event.type)) runtime.evidenceCompacted = true;
    // The spawn provider returns only stopReason. Keep the owned child's actual
    // terminal failure before the Host disposes it; never inspect other sessions.
    if (runtime && !runtime.closed && event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      const failure = event.data.reason.error;
      runtime.failure = { code: failure?.code, message: failure?.message };
    }
  }, { global: true }));
  // DSH's stop boundary permits same-turn steering before a one-shot settles.
  // Repair only our published child, using tool receipts rather than its claims.
  disposers.push(ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const runtime = sessions.get(agent.session.id);
    if (!runtime || runtime.closed || runtime.evidenceCompacted || signal?.aborted || runtime.signal?.aborted || typeof agent.steer !== 'function') return;
    runtime.assertActive?.();
    const diagnostic = await runtime.diagnostics();
    const missingOutputs = Object.keys(runtime.outputs).filter(id => !runtime.outputWritten.has(id));
    if (!diagnostic.readState.remaining && !missingOutputs.length) return;
    if ((runtime.completionReminders || 0) >= (runtime.maxCompletionReminders ?? 3)) return;
    signal?.throwIfAborted(); runtime.signal?.throwIfAborted(); runtime.assertActive?.();
    if (runtime.closed) return;
    runtime.completionReminders = (runtime.completionReminders || 0) + 1;
    runtime.onActivity?.();
    const text = 'ReqHub tool receipts show that this task is NOT complete. Continue in this same turn; do not claim success or repeat completed reads. '
      + JSON.stringify({ readState: diagnostic.readState, missingOutputs })
      + '. Read readState.next.artifactId at readState.next.offset, follow subsequent readState.next until remaining=0; then write every missing output with req_hub_sync_write. Only written=true acknowledges a successful write.';
    agent.steer(Object.freeze({ id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'req-hub-sync', form: 'notice', summary: 'Incomplete sync evidence or outputs' }),
      content: Object.freeze([Object.freeze({ type: 'text', text })]) }));
  }, { global: true }));
  const installation = {
    revoke(signal) { for (const runtime of [...runtimes.values()]) if (runtime.signal === signal) runtime.close(); },
    create(options) {
      options.signal?.throwIfAborted();
      const runtime = new SyncRuntime(ctx, options);
      runtime.bindSession = id => sessions.set(id, runtime);
      const close = runtime.close.bind(runtime);
      runtime.close = () => {
        options.signal?.removeEventListener('abort', runtime.close);
        close(); runtimes.delete(runtime.id);
        if (runtime.sessionId) sessions.set(runtime.sessionId, { closed: true });
      };
      options.signal?.addEventListener('abort', runtime.close, { once: true });
      runtimes.set(runtime.id, runtime); return runtime;
    },
    dispose() { for (const runtime of [...runtimes.values()]) runtime.close(); for (const dispose of disposers.reverse()) dispose(); sessions.clear(); installations.delete(ctx); },
  };
  installations.set(ctx, installation);
  return installation;
}

function resolveSyncEditor(ctx, parentAgent) {
  const get = name => ctx?.tools?.get?.(name, parentAgent);
  const editor = get('str_replace_editor');
  if (typeof editor?.execute === 'function') return { kind: 'str_replace_editor', editor };
  const edit = get('edit'), write = get('write'), read = get('read');
  if ([edit, write, read].every(tool => typeof tool?.execute === 'function')) return { kind: 'edit', editor: edit, writer: write, reader: read };
  return null;
}

export function assertSyncCapabilities(ctx, config = {}, parentAgent) {
  const name = config.ai?.delegation?.provider || 'spawn';
  const provider = ctx?.subagents?.getProvider?.(name), missing = [];
  if (!provider) missing.push(`子代理 provider「${name}」未注册`);
  else {
    if (!provider.capabilities?.toolFilter) missing.push(`provider「${name}」不支持工具隔离 toolFilter`);
    if (provider.inheritsParentContext !== false) missing.push(`provider「${name}」未声明零父上下文（inheritsParentContext=false）`);
  }
  const nativeEditor = resolveSyncEditor(ctx, parentAgent);
  if (!nativeEditor) missing.push('当前会话缺少原生文件工具：需要 str_replace_editor 或 read + edit + write，请在 Agent 预设中启用对应文件工具');
  for (const method of ['register', 'guard']) if (typeof ctx?.tools?.[method] !== 'function') missing.push(`宿主缺少 tools.${method}，无法安装受控工具`);
  if (typeof ctx?.on !== 'function') missing.push('宿主缺少事件接口，无法校验子代理上下文');
  if (missing.length) throw new Error(`CAPABILITY_UNSUPPORTED: ${missing.join('；')}`);
  if (!installSyncTools(ctx)) throw new Error('CAPABILITY_UNSUPPORTED: 同步受控工具安装失败');
  return nativeEditor;
}

class SyncRuntime {
  constructor(ctx, options) {
    Object.assign(this, options);
    this.ctx = ctx; this.id = randomUUID(); this.coverage = new Map(); this.contextCost = 0;
    this.readRanges = new Map();
    this.exposedSinceRequest = 0; this.journal = []; this.outputWritten = new Set();
    this.inputLimit = options.budget?.limit ?? MAX_SYNC_INPUT_TOKENS;
    this.optionalContextCost = 0;
    this.nativeEditor = options.nativeEditor || resolveSyncEditor(ctx, options.parentAgent);
  }
  charge(value) {
    const amount = estimateSubagentInputTokens(JSON.stringify(value)) + 128;
    if (this.evidenceCompacted) throw new Error('SYNC_EVIDENCE_COMPACTED');
    if (this.contextCost + this.exposedSinceRequest + amount + REQUEST_RESERVE >= this.inputLimit) throw new Error('SYNC_READ_BUDGET_EXCEEDED');
    this.exposedSinceRequest += amount;
    return value;
  }
  async requiredSizes() {
    if (!this.requiredSizePromise) this.requiredSizePromise = (async () => {
      const sizes = new Map();
      for (const id of this.required) sizes.set(id, (await this.store.read(id)).length);
      return sizes;
    })();
    return this.requiredSizePromise;
  }
  readState(sizes, currentId, currentEnd) {
    const unread = [];
    for (const [artifactId, totalChars] of sizes) {
      const offset = artifactId === currentId ? Math.max(this.coverage.get(artifactId) ?? -1, currentEnd) : this.coverage.get(artifactId) ?? -1;
      if (offset < totalChars) unread.push({ artifactId, offset: Math.max(0, offset), totalChars });
    }
    return { remaining: unread.length, next: unread.length ? { artifactId: unread[0].artifactId, offset: unread[0].offset } : null };
  }
  async diagnostics() {
    const sizes = await this.requiredSizes();
    return { schemaVersion: 1, sessionId: this.sessionId, outputsWritten: [...this.outputWritten],
      required: [...sizes].map(([artifactId, totalChars]) => ({ artifactId, totalChars, nextOffset: Math.max(0, this.coverage.get(artifactId) ?? 0), complete: (this.coverage.get(artifactId) ?? -1) >= totalChars })),
      readState: this.readState(sizes), evidenceCompacted: !!this.evidenceCompacted };
  }
  async read({ artifactId, offset = 0, limit = 8000 }) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) throw new Error('READ_RANGE');
    let text;
    if (artifactId === 'candidate' && this.candidatePath) text = decodeDocument(await readFile(this.candidatePath));
    else {
      if (!this.allowed.includes(artifactId)) throw new Error('ARTIFACT_DENIED');
      text = await this.store.read(artifactId);
    }
    const next = this.coverage.get(artifactId) || 0;
    if (offset < text.length && /[\uDC00-\uDFFF]/.test(text[offset])) throw new Error('READ_RANGE_SURROGATE');
    const optional = artifactId !== 'candidate' && !this.required.includes(artifactId);
    if ((!optional && offset > next) || offset > text.length) throw new Error('READ_GAP');
    const child = this.ctx.agents?.get?.(this.sessionId);
    const threshold = child?.ctx?.get?.('toolResultPruner')?.config?.thresholdChars;
    const sizes = await this.requiredSizes();
    const page = syncReadPage(artifactId, text, offset, limit, hashBytes(Buffer.from(text)), threshold,
      value => ({ ...value, readState: this.readState(sizes, artifactId, value.nextOffset) }));
    const amount = estimateSubagentInputTokens(JSON.stringify(page)) + 128;
    if (optional && this.budget && this.optionalContextCost + amount > this.budget.optionalContextTokens) throw new Error('SYNC_OPTIONAL_CONTEXT_BUDGET_EXCEEDED');
    const result = this.charge(page);
    if (optional) this.optionalContextCost += amount;
    const ranges = [...(this.readRanges.get(artifactId) || []), [offset, result.nextOffset]].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
      else merged.push([...range]);
    }
    this.readRanges.set(artifactId, merged);
    this.coverage.set(artifactId, merged[0]?.[0] === 0 ? merged[0][1] : 0);
    return result;
  }
  async assertCoverage() {
    if (this.evidenceCompacted) throw new Error('SYNC_EVIDENCE_COMPACTED');
    const sizes = await this.requiredSizes();
    const state = this.readState(sizes);
    if (state.next) throw new Error(`EVIDENCE_NOT_FULLY_READ: ${state.next.artifactId}; nextOffset=${state.next.offset}; totalChars=${sizes.get(state.next.artifactId)}; remaining=${state.remaining}. Continue req_hub_sync_read at this exact offset; no output has been written by this call.`);
    // Coverage metadata never substitutes for checking immutable file hashes.
    for (const id of this.required) await this.store.read(id);
  }
  async write({ outputId, content }) {
    if (!this.outputs[outputId] || typeof content !== 'string' || Buffer.byteLength(content) > OUTPUT_LIMIT || !content.trim()) throw new Error('OUTPUT_SCOPE_OR_SIZE');
    await this.assertCoverage();
    const response = this.charge({ outputId, written: true, bytes: Buffer.byteLength(content), sha256: hashBytes(Buffer.from(content)) });
    this.signal?.throwIfAborted(); this.assertActive?.();
    await writeFile(this.outputs[outputId], content, { encoding: 'utf8', flag: this.outputWritten.has(outputId) ? 'w' : 'wx' });
    this.outputWritten.add(outputId);
    return response;
  }
  async edit({ blockId, expectedHash, oldText, newText }, exec) {
    await this.assertCoverage();
    if (!this.candidatePath || !this.changes.some(change => change.blockId === blockId)
      || typeof oldText !== 'string' || typeof newText !== 'string') throw new Error('EDIT_SCOPE');
    const before = await readFile(this.candidatePath);
    if (hashBytes(before) !== expectedHash) throw new Error('CANDIDATE_HASH_CONFLICT');
    // Reuse Harness's editor; no replacement algorithm or patch matching is implemented here.
    try {
      if (!this.nativeEditor) throw new Error('NATIVE_EDITOR_UNAVAILABLE');
      if (this.nativeEditor.kind === 'str_replace_editor') {
        const args = before.length ? { command: 'str_replace', path: this.candidatePath, old_str: oldText, new_str: newText }
          : { command: 'insert', path: this.candidatePath, insert_line: 0, new_str: newText };
        await this.nativeEditor.editor.execute(args, exec);
      } else {
        // The host's observation policy needs a native read in this child's session.
        await this.nativeEditor.reader.execute({ file_path: this.candidatePath, offset: 1, limit: 1 }, exec);
        exec.signal?.throwIfAborted();
        if (before.length) await this.nativeEditor.editor.execute({ file_path: this.candidatePath, old_string: oldText, new_string: newText, replace_all: false }, exec);
        else await this.nativeEditor.writer.execute({ file_path: this.candidatePath, content: newText }, exec);
      }
      exec.signal?.throwIfAborted();
      const after = await readFile(this.candidatePath);
      assertEditInBlock(this.originalBytes, before, after, blockId, this.blocks);
      if (hashBytes(before) === hashBytes(after)) throw new Error('EDIT_NO_CHANGE');
      validateCandidate(this.originalBytes, after, this.fileName, this.changes, this.blocks);
      const response = this.charge({ blockId, candidateHash: hashBytes(after) });
      this.journal.push({ blockId, beforeHash: expectedHash, afterHash: hashBytes(after) });
      return response;
    } catch (error) { await writeFile(this.candidatePath, before); throw error; }
  }
  close() { this.closed = true; }
}
