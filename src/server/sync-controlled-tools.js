import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hashBytes, decodeDocument } from './sync-artifacts.js';
import { estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';
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
    const marker = JSON.stringify(request.messages || []).match(/REQHUB_SYNC_V2=([a-f0-9-]{36})/);
    if (marker && !runtimes.has(marker[1])) throw new Error('SYNC_RUNTIME_CLOSED');
    let runtime = sessions.get(request.sessionId);
    if (!runtime && marker && runtimes.has(marker[1])) {
      runtime = runtimes.get(marker[1]);
      if (runtime.sessionId && runtime.sessionId !== request.sessionId) throw new Error('SYNC_SESSION_REUSE');
      if (!request.sessionId) throw new Error('SYNC_SESSION_REQUIRED');
      runtime.sessionId = request.sessionId;
      sessions.set(request.sessionId, runtime);
    }
    if (runtime) {
      runtime.assertActive?.();
      if (runtime.closed) throw new Error('SYNC_RUNTIME_CLOSED');
      runtime.signal?.throwIfAborted();
      runtime.onActivity?.();
      const surface = { messages: request.messages, system: request.system, tools: request.tools, toolHistory: request.toolHistory };
      const cost = estimateSubagentInputTokens(JSON.stringify(surface));
      if (cost + REQUEST_RESERVE >= MAX_SYNC_INPUT_TOKENS) throw new Error('SYNC_REQUEST_BUDGET_EXCEEDED');
      if (request.tools?.some(tool => !SYNC_TOOLS.includes(tool.name) && tool.name !== 'run_code')) throw new Error('SYNC_TOOL_ISOLATION_FAILED');
      runtime.contextCost = cost;
      runtime.exposedSinceRequest = 0;
      runtime.maxRequestCost = Math.max(runtime.maxRequestCost || 0, cost);
    }
    yield* next();
  }, { global: true, prepend: true }));
  const installation = {
    revoke(signal) { for (const runtime of [...runtimes.values()]) if (runtime.signal === signal) runtime.close(); },
    create(options) {
      options.signal?.throwIfAborted();
      const runtime = new SyncRuntime(ctx, options);
      const close = runtime.close.bind(runtime);
      runtime.close = () => {
        options.signal?.removeEventListener('abort', runtime.close);
        close(); runtimes.delete(runtime.id);
        if (runtime.sessionId) sessions.delete(runtime.sessionId);
      };
      options.signal?.addEventListener('abort', runtime.close, { once: true });
      runtimes.set(runtime.id, runtime); return runtime;
    },
    dispose() { for (const dispose of disposers.reverse()) dispose(); installations.delete(ctx); },
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
    this.exposedSinceRequest = 0; this.journal = []; this.outputWritten = new Set();
    this.nativeEditor = options.nativeEditor || resolveSyncEditor(ctx, options.parentAgent);
  }
  charge(value) {
    const amount = estimateSubagentInputTokens(JSON.stringify(value)) + 128;
    if (this.contextCost + this.exposedSinceRequest + amount + REQUEST_RESERVE >= MAX_SYNC_INPUT_TOKENS) throw new Error('SYNC_READ_BUDGET_EXCEEDED');
    this.exposedSinceRequest += amount;
    return value;
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
    if (offset > next || offset > text.length) throw new Error('READ_GAP');
    let end = Math.min(text.length, offset + limit);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    if (end === offset && end < text.length) throw new Error('READ_RANGE_SURROGATE');
    const result = this.charge({ artifactId, offset, nextOffset: end, eof: end === text.length, sha256: hashBytes(Buffer.from(text)), text: text.slice(offset, end) });
    this.coverage.set(artifactId, Math.max(next, end));
    return result;
  }
  async assertCoverage() {
    for (const id of this.required) if ((this.coverage.get(id) ?? -1) < (await this.store.read(id)).length) throw new Error('EVIDENCE_NOT_FULLY_READ: ' + id);
  }
  async write({ outputId, content }) {
    if (!this.outputs[outputId] || typeof content !== 'string' || Buffer.byteLength(content) > OUTPUT_LIMIT || !content.trim()) throw new Error('OUTPUT_SCOPE_OR_SIZE');
    await this.assertCoverage();
    await writeFile(this.outputs[outputId], content, { encoding: 'utf8', flag: this.outputWritten.has(outputId) ? 'w' : 'wx' });
    this.outputWritten.add(outputId);
    return this.charge({ outputId, bytes: Buffer.byteLength(content), sha256: hashBytes(Buffer.from(content)) });
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
