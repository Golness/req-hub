import { msg } from './messages.js';
import { runtimeForRequest } from './delegation-context.js';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hashBytes, decodeDocument } from './sync-artifacts.js';
import { estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';
import { resolveSyncBudget, syncReadPage } from './sync-budget.js';
import { validateCandidate, assertEditInBlock } from './sync-document-validator.js';

export const SYNC_TOOLS = ['req_hub_sync_read', 'req_hub_sync_write', 'req_hub_sync_edit'];
export const OUTPUT_LIMIT = 256 * 1000;
export const REQUEST_RESERVE = 8192;
const installations = new WeakMap();

/**
 * Install global definitions, but authorize every call by its host-owned child session.
 * @param ctx - The injected Host context.
 * @returns A disposer for the tool and request registrations.
 */
export function installSyncTools(ctx) {
  if (installations.has(ctx)) {
    return installations.get(ctx);
  }
  if (!ctx?.tools?.register || !ctx.tools.guard || !ctx.on) {
    return null;
  }
  const runtimes = new Map();
  const sessions = new Map();
  const disposers = [];
  const runtimeFor = (exec) => {
    exec.signal?.throwIfAborted();
    const runtime = sessions.get(exec.agent?.session?.id);
    if (!runtime || runtime.closed) {
      throw new Error('SYNC_TOOL_DENIED');
    }
    if (runtime.outputFailure) {
      throw runtime.outputFailure;
    }
    runtime.assertActive?.();
    runtime.signal?.throwIfAborted();
    runtime.onActivity?.();
    return runtime;
  };
  const schemas = {
    req_hub_sync_read: {
      artifactId: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 8000 },
    },
    // DSH's enforced schema subset supports oneOf, not anyOf. Validate inner
    // fields in the owned runtime so failures get precise diagnostics and count
    // toward the repair limit instead of bypassing it at Host argument parsing.
    req_hub_sync_write: {
      outputId: { type: 'string' },
      content: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            description:
              'Analysis index: changes is an array of {id,action,blockId,reason,proposal,evidenceRefs}; pending is an array of {id,reason}. Exact IDs and field values are validated by the tool.',
          },
        ],
      },
    },
    req_hub_sync_edit: {
      blockId: { type: 'string' },
      expectedHash: { type: 'string' },
      oldText: { type: 'string' },
      newText: { type: 'string' },
    },
  };
  for (const name of SYNC_TOOLS) {
    let description;
    if (name === SYNC_TOOLS[0]) {
      description = 'Read immutable sync evidence by artifact ID; follow nextOffset until eof.';
    } else if (name === SYNC_TOOLS[1]) {
      description =
        'Write one assigned analysis output: changes accepts a structured {changes,pending} object; report takes Markdown text. Rejected outputs are not written. Never overwrite a candidate document.';
    } else {
      description =
        'Edit an authorized candidate block through the native exact editor. Supply the current candidate hash. Use the returned candidateHash for the next edit. Read candidate again only to locate exact text.';
    }
    disposers.push(
      ctx.tools.register({
        name,
        description: description,
        parameters: {
          type: 'object',
          properties: schemas[name],
          required: Object.keys(schemas[name]).filter((key) => !['offset', 'limit'].includes(key)),
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          const runtime = runtimeFor(exec);
          if (name === SYNC_TOOLS[0]) {
            return runtime.read(args);
          }
          if (name === SYNC_TOOLS[1]) {
            return runtime.write(args);
          }
          return runtime.edit(args, exec);
        },
      }),
    );
  }
  disposers.push(
    ctx.tools.guard((exec) => {
      const runtime = sessions.get(exec.agent?.session?.id);
      if (runtime && !runtime.allowedTools?.includes(exec.name) && exec.name !== 'run_code') {
        if (SYNC_TOOLS.includes(exec.name) && !runtime.closed) {
          return runtime.stageToolError(exec.name);
        }
        return 'SYNC_V2_BYPASS_TOOLS_FORBIDDEN';
      }
      return undefined;
    }),
  );
  disposers.push(
    ctx.on(
      'llm/stream',
      async function* (request, next) {
        const runtime =
          sessions.get(request.sessionId) || runtimeForRequest(ctx, runtimes, request);
        if (runtime) {
          if (runtime.closed) {
            throw new Error('SYNC_RUNTIME_CLOSED');
          }
          if (runtime.outputFailure) {
            throw runtime.outputFailure;
          }
          if (runtime.evidenceCompacted) {
            throw new Error('SYNC_EVIDENCE_COMPACTED');
          }
          runtime.assertActive?.();
          runtime.signal?.throwIfAborted();
          runtime.onActivity?.();
          const budget = await resolveSyncBudget({
            ctx,
            parentAgent: runtime.parentAgent,
            request,
            signal: runtime.signal,
          });
          runtime.inputLimit = Math.min(
            runtime.budget?.limit ?? MAX_SYNC_INPUT_TOKENS,
            budget.limit,
          );
          const surface = {
            messages: request.messages,
            system: request.system,
            tools: request.tools,
            toolHistory: request.toolHistory,
          };
          const child = ctx.agents?.get?.(request.sessionId);
          const meter = child?.ctx?.get?.('tokenMeter');
          const measured = meter && child?.session ? meter.measure(child.session).totalTokens : 0;
          const cost = Math.max(estimateSubagentInputTokens(JSON.stringify(surface)), measured);
          if (cost + REQUEST_RESERVE >= runtime.inputLimit) {
            throw new Error('SYNC_REQUEST_BUDGET_EXCEEDED');
          }
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
      },
      { global: true, prepend: true },
    ),
  );
  disposers.push(
    ctx.on(
      'session/event',
      (session, event) => {
        const runtime = sessions.get(session.id);
        if (
          runtime &&
          !runtime.closed &&
          ['compaction/prune', 'compaction/summary'].includes(event.type)
        ) {
          runtime.evidenceCompacted = true;
        }
        // The spawn provider returns only stopReason. Keep the owned child's actual
        // terminal failure before the Host disposes it; never inspect other sessions.
        if (
          runtime &&
          !runtime.closed &&
          event.type === 'turn/end' &&
          event.data?.reason?.kind === 'error'
        ) {
          const failure = event.data.reason.error;
          runtime.failure = { code: failure?.code, message: failure?.message };
        }
      },
      { global: true },
    ),
  );
  // DSH's stop boundary permits same-turn steering before a one-shot settles.
  // Repair only our published child, using tool receipts rather than its claims.
  disposers.push(
    ctx.on(
      'agent/turn-stopping',
      async ({ agent, signal }) => {
        const runtime = sessions.get(agent.session.id);
        if (
          !runtime ||
          runtime.closed ||
          runtime.evidenceCompacted ||
          signal?.aborted ||
          runtime.signal?.aborted ||
          typeof agent.steer !== 'function'
        ) {
          return;
        }
        runtime.assertActive?.();
        const diagnostic = await runtime.diagnostics();
        const missingOutputs = Object.keys(runtime.outputs).filter(
          (id) => !runtime.outputWritten.has(id),
        );
        const missingEditBlockIds = runtime.candidatePath
          ? [...new Set(runtime.changes.map((change) => change.blockId))].filter(
              (id) => !runtime.journal.some((edit) => edit.blockId === id),
            )
          : [];
        if (
          !diagnostic.readState.remaining &&
          !missingOutputs.length &&
          !missingEditBlockIds.length
        ) {
          return;
        }
        if ((runtime.completionReminders || 0) >= (runtime.maxCompletionReminders ?? 3)) {
          return;
        }
        signal?.throwIfAborted();
        runtime.signal?.throwIfAborted();
        runtime.assertActive?.();
        if (runtime.closed) {
          return;
        }
        runtime.completionReminders = (runtime.completionReminders || 0) + 1;
        runtime.onActivity?.();
        const text =
          'ReqHub tool receipts show that this task is NOT complete. Continue in this same turn; do not claim success or repeat completed reads. ' +
          JSON.stringify({
            readState: diagnostic.readState,
            missingOutputs,
            missingEditBlockIds,
            outputErrors: diagnostic.outputErrors,
          }) +
          '. Read readState.next.artifactId at readState.next.offset until remaining=0. ' +
          (runtime.candidatePath
            ? 'Read candidate to locate exact text as needed. Use req_hub_sync_edit for missingEditBlockIds. Edit receipts confirm completion. This stage has no analysis outputs; do not call req_hub_sync_write.'
            : 'Write every missing output with req_hub_sync_write. Only written=true acknowledges a successful write.');
        agent.steer(
          Object.freeze({
            id: randomUUID(),
            role: 'user',
            source: Object.freeze({
              kind: 'req-hub-sync',
              form: 'notice',
              summary: 'Incomplete sync evidence or outputs',
            }),
            content: Object.freeze([Object.freeze({ type: 'text', text })]),
          }),
        );
      },
      { global: true },
    ),
  );
  const installation = {
    revoke(signal) {
      for (const runtime of [...runtimes.values()]) {
        if (runtime.signal === signal || runtime.ownerSignal === signal) {
          runtime.close();
        }
      }
    },
    create(options) {
      options.signal?.throwIfAborted();
      const runtime = new SyncRuntime(ctx, options);
      runtime.bindSession = (id) => sessions.set(id, runtime);
      const close = runtime.close.bind(runtime);
      runtime.close = () => {
        options.signal?.removeEventListener('abort', runtime.close);
        close();
        runtimes.delete(runtime.id);
        if (runtime.sessionId) {
          sessions.set(runtime.sessionId, { closed: true });
        }
      };
      options.signal?.addEventListener('abort', runtime.close, { once: true });
      runtimes.set(runtime.id, runtime);
      return runtime;
    },
    dispose() {
      for (const runtime of [...runtimes.values()]) {
        runtime.close();
      }
      for (const dispose of disposers.reverse()) {
        dispose();
      }
      sessions.clear();
      installations.delete(ctx);
    },
  };
  installations.set(ctx, installation);
  return installation;
}

function resolveSyncEditor(ctx, parentAgent) {
  const get = (name) => ctx?.tools?.get?.(name, parentAgent);
  const editor = get('str_replace_editor');
  if (typeof editor?.execute === 'function') {
    return { kind: 'str_replace_editor', editor };
  }
  const edit = get('edit');
  const write = get('write');
  const read = get('read');
  if ([edit, write, read].every((tool) => typeof tool?.execute === 'function')) {
    return { kind: 'edit', editor: edit, writer: write, reader: read };
  }
  return null;
}

/**
 * Check required Host delegation and tool capabilities before starting sync.
 * @param ctx - The injected Host context.
 * @param [config] - Validated plugin configuration.
 * @param parentAgent - The Host Agent that owns delegated sync execution.
 * @returns No value; missing capabilities throw.
 */
export function assertSyncCapabilities(ctx, config = {}, parentAgent) {
  const name = config.ai?.delegation?.provider || 'spawn';
  const provider = ctx?.subagents?.getProvider?.(name);
  const missing = [];
  if (!provider) {
    missing.push(msg('SYNC_SUBAGENT_PROVIDER_NOT_REGISTERED', { v0: name }));
  } else {
    if (!provider.capabilities?.toolFilter) {
      missing.push(msg('SYNC_PROVIDER_TOOL_FILTER_UNSUPPORTED', { v0: name }));
    }
    if (provider.inheritsParentContext !== false) {
      missing.push(msg('SYNC_PROVIDER_PARENT_CONTEXT_NOT_DECLARED', { v0: name }));
    }
  }
  const nativeEditor = resolveSyncEditor(ctx, parentAgent);
  if (!nativeEditor) {
    missing.push('SYNC_NATIVE_FILE_TOOLS_MISSING');
  }
  for (const method of ['register', 'guard']) {
    if (typeof ctx?.tools?.[method] !== 'function') {
      missing.push(msg('SYNC_HOST_TOOL_MISSING', { v0: method }));
    }
  }
  if (typeof ctx?.on !== 'function') {
    missing.push('SYNC_HOST_EVENT_API_MISSING');
  }
  if (missing.length) {
    throw msg('CAPABILITY_UNSUPPORTED', { v0: missing });
  }
  if (!installSyncTools(ctx)) {
    throw new Error('CAPABILITY_UNSUPPORTED');
  }
  return nativeEditor;
}

class SyncRuntime {
  constructor(ctx, options) {
    Object.assign(this, options);
    this.ctx = ctx;
    this.allowedTools = this.candidatePath
      ? ['req_hub_sync_read', 'req_hub_sync_edit']
      : ['req_hub_sync_read', 'req_hub_sync_write'];
    this.id = randomUUID();
    this.coverage = new Map();
    this.contextCost = 0;
    this.readRanges = new Map();
    this.exposedSinceRequest = 0;
    this.journal = [];
    this.outputWritten = new Set();
    this.outputErrors = new Map();
    this.invalidOutputWrites = 0;
    this.inputLimit = options.budget?.limit ?? MAX_SYNC_INPUT_TOKENS;
    this.optionalContextCost = 0;
    this.nativeEditor = options.nativeEditor || resolveSyncEditor(ctx, options.parentAgent);
  }
  charge(value) {
    const amount = estimateSubagentInputTokens(JSON.stringify(value)) + 128;
    if (this.evidenceCompacted) {
      throw new Error('SYNC_EVIDENCE_COMPACTED');
    }
    if (this.contextCost + this.exposedSinceRequest + amount + REQUEST_RESERVE >= this.inputLimit) {
      throw new Error('SYNC_READ_BUDGET_EXCEEDED');
    }
    this.exposedSinceRequest += amount;
    return value;
  }
  async requiredSizes() {
    if (!this.requiredSizePromise) {
      this.requiredSizePromise = (async () => {
        const sizes = new Map();
        for (const id of this.required) {
          sizes.set(id, (await this.store.read(id)).length);
        }
        return sizes;
      })();
    }
    return this.requiredSizePromise;
  }
  readState(sizes, currentId, currentEnd) {
    const unread = [];
    for (const [artifactId, totalChars] of sizes) {
      const offset =
        artifactId === currentId
          ? Math.max(this.coverage.get(artifactId) ?? -1, currentEnd)
          : (this.coverage.get(artifactId) ?? -1);
      if (offset < totalChars) {
        unread.push({ artifactId, offset: Math.max(0, offset), totalChars });
      }
    }
    return {
      remaining: unread.length,
      next: unread.length ? { artifactId: unread[0].artifactId, offset: unread[0].offset } : null,
    };
  }
  async diagnostics() {
    const sizes = await this.requiredSizes();
    return {
      schemaVersion: 1,
      sessionId: this.sessionId,
      outputsWritten: [...this.outputWritten],
      outputErrors: Object.fromEntries(this.outputErrors),
      invalidOutputWrites: this.invalidOutputWrites,
      outputFailure: this.outputFailure?.message,
      required: [...sizes].map(([artifactId, totalChars]) => ({
        artifactId,
        totalChars,
        nextOffset: Math.max(0, this.coverage.get(artifactId) ?? 0),
        complete: (this.coverage.get(artifactId) ?? -1) >= totalChars,
      })),
      readState: this.readState(sizes),
      evidenceCompacted: !!this.evidenceCompacted,
    };
  }
  async read({ artifactId, offset = 0, limit = 8000 }) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 8000
    ) {
      throw new Error('READ_RANGE');
    }
    let text;
    if (artifactId === 'candidate' && this.candidatePath) {
      text = decodeDocument(await readFile(this.candidatePath));
    } else {
      if (!this.allowed.includes(artifactId)) {
        throw new Error('ARTIFACT_DENIED');
      }
      text = await this.store.read(artifactId);
    }
    const next = this.coverage.get(artifactId) || 0;
    if (offset < text.length && /[\uDC00-\uDFFF]/.test(text[offset])) {
      throw new Error('READ_RANGE_SURROGATE');
    }
    const optional = artifactId !== 'candidate' && !this.required.includes(artifactId);
    if ((!optional && offset > next) || offset > text.length) {
      throw new Error('READ_GAP');
    }
    const child = this.ctx.agents?.get?.(this.sessionId);
    const threshold = child?.ctx?.get?.('toolResultPruner')?.config?.thresholdChars;
    const sizes = await this.requiredSizes();
    const page = syncReadPage(
      artifactId,
      text,
      offset,
      limit,
      hashBytes(Buffer.from(text)),
      threshold,
      (value) => ({ ...value, readState: this.readState(sizes, artifactId, value.nextOffset) }),
    );
    const amount = estimateSubagentInputTokens(JSON.stringify(page)) + 128;
    if (
      optional &&
      this.budget &&
      this.optionalContextCost + amount > this.budget.optionalContextTokens
    ) {
      throw new Error('SYNC_OPTIONAL_CONTEXT_BUDGET_EXCEEDED');
    }
    const result = this.charge(page);
    if (optional) {
      this.optionalContextCost += amount;
    }
    const ranges = [...(this.readRanges.get(artifactId) || []), [offset, result.nextOffset]].sort(
      (a, b) => a[0] - b[0],
    );
    const merged = [];
    for (const range of ranges) {
      if (merged.length && range[0] <= merged.at(-1)[1]) {
        merged.at(-1)[1] = Math.max(merged.at(-1)[1], range[1]);
      } else {
        merged.push([...range]);
      }
    }
    this.readRanges.set(artifactId, merged);
    this.coverage.set(artifactId, merged[0]?.[0] === 0 ? merged[0][1] : 0);
    return result;
  }
  async assertCoverage() {
    if (this.evidenceCompacted) {
      throw new Error('SYNC_EVIDENCE_COMPACTED');
    }
    const sizes = await this.requiredSizes();
    const state = this.readState(sizes);
    if (state.next) {
      throw new Error(
        `EVIDENCE_NOT_FULLY_READ: ${state.next.artifactId}; nextOffset=${state.next.offset}; totalChars=${sizes.get(state.next.artifactId)}; remaining=${state.remaining}. Continue req_hub_sync_read at this exact offset; no output has been written by this call.`,
      );
    }
    // Coverage metadata never substitutes for checking immutable file hashes.
    for (const id of this.required) {
      await this.store.read(id);
    }
  }
  stageToolError(name) {
    const instruction = this.candidatePath
      ? 'Use req_hub_sync_edit for planned candidate edits. This stage has no analysis outputIds. After all edit receipts, finish with a brief acknowledgment.'
      : 'Use req_hub_sync_write for assigned analysis outputs. This stage cannot edit a candidate.';
    return `SYNC_STAGE_TOOL_DENIED: ${name}. ${instruction}`;
  }
  async write({ outputId, content }) {
    if (!this.allowedTools.includes('req_hub_sync_write')) {
      throw new Error(this.stageToolError('req_hub_sync_write'));
    }
    if (this.outputFailure) {
      throw this.outputFailure;
    }
    if (
      outputId === 'changes' &&
      content &&
      typeof content === 'object' &&
      !Array.isArray(content)
    ) {
      content = JSON.stringify(content);
    }
    if (!this.outputs[outputId] || typeof content !== 'string' || !content.trim()) {
      this.rejectOutput(
        outputId,
        new Error(
          'OUTPUT_SCOPE_OR_SIZE: use an assigned outputId and non-empty content; only changes accepts a structured object.',
        ),
      );
    }
    const contentBytes = Buffer.byteLength(content);
    if (contentBytes > OUTPUT_LIMIT) {
      this.rejectOutput(
        outputId,
        new Error(
          `OUTPUT_SIZE: ${outputId} is ${(contentBytes / 1000).toFixed(3)} KB; ` +
            `limit is ${OUTPUT_LIMIT / 1000} KB (UTF-8). ` +
            'Merge duplicate proposals using sourceIds and preserve all confirmed changes.',
        ),
      );
    }
    await this.assertCoverage();
    // Reject invalid analysis while the child is still able to correct it.
    // A successful receipt certifies both the output contract and persistence.
    try {
      await this.validateOutput?.(outputId, content, this);
    } catch (error) {
      this.rejectOutput(outputId, error);
    }
    if (this.outputFailure) {
      throw this.outputFailure;
    }
    const response = this.charge({
      outputId,
      written: true,
      bytes: Buffer.byteLength(content),
      sha256: hashBytes(Buffer.from(content)),
    });
    this.signal?.throwIfAborted();
    this.assertActive?.();
    await writeFile(this.outputs[outputId], content, {
      encoding: 'utf8',
      flag: this.outputWritten.has(outputId) ? 'w' : 'wx',
    });
    this.outputWritten.add(outputId);
    this.outputErrors.delete(outputId);
    return response;
  }
  rejectOutput(outputId, error) {
    if (this.outputFailure) {
      throw this.outputFailure;
    }
    const attempts = ++this.invalidOutputWrites;
    const limit = this.maxInvalidOutputWrites ?? 6;
    this.outputErrors.set(outputId, error.message);
    if (attempts >= limit) {
      this.outputFailure = new Error(
        `SYNC_OUTPUT_REPAIR_LIMIT: ${attempts} invalid output writes; stopped this child only. Last validation: ${error.message}`,
      );
      this.onOutputFailure?.(this.outputFailure);
      throw this.outputFailure;
    }
    throw Object.assign(
      new Error(
        `${error.message} No output was written. Invalid write ${attempts}/${limit}; fix the named field, preserve the analysis, and do not reread completed evidence.`,
      ),
      { code: error.code, details: error.details },
    );
  }
  async edit({ blockId, expectedHash, oldText, newText }, exec) {
    if (!this.allowedTools.includes('req_hub_sync_edit')) {
      throw new Error(this.stageToolError('req_hub_sync_edit'));
    }
    await this.assertCoverage();
    if (
      !this.candidatePath ||
      !this.changes.some((change) => change.blockId === blockId) ||
      typeof oldText !== 'string' ||
      typeof newText !== 'string'
    ) {
      throw new Error('EDIT_SCOPE');
    }
    const before = await readFile(this.candidatePath);
    if (hashBytes(before) !== expectedHash) {
      throw new Error('CANDIDATE_HASH_CONFLICT');
    }
    // Reuse Harness's editor; no replacement algorithm or patch matching is implemented here.
    try {
      if (!this.nativeEditor) {
        throw new Error('NATIVE_EDITOR_UNAVAILABLE');
      }
      if (this.nativeEditor.kind === 'str_replace_editor') {
        const args = before.length
          ? { command: 'str_replace', path: this.candidatePath, old_str: oldText, new_str: newText }
          : { command: 'insert', path: this.candidatePath, insert_line: 0, new_str: newText };
        await this.nativeEditor.editor.execute(args, exec);
      } else {
        // The host's observation policy needs a native read in this child's session.
        await this.nativeEditor.reader.execute(
          { file_path: this.candidatePath, offset: 1, limit: 1 },
          exec,
        );
        exec.signal?.throwIfAborted();
        if (before.length) {
          await this.nativeEditor.editor.execute(
            {
              file_path: this.candidatePath,
              old_string: oldText,
              new_string: newText,
              replace_all: false,
            },
            exec,
          );
        } else {
          await this.nativeEditor.writer.execute(
            { file_path: this.candidatePath, content: newText },
            exec,
          );
        }
      }
      exec.signal?.throwIfAborted();
      const after = await readFile(this.candidatePath);
      assertEditInBlock(this.originalBytes, before, after, blockId, this.blocks);
      if (hashBytes(before) === hashBytes(after)) {
        throw new Error('EDIT_NO_CHANGE');
      }
      validateCandidate(this.originalBytes, after, this.fileName, this.changes, this.blocks);
      const response = this.charge({ blockId, candidateHash: hashBytes(after) });
      this.journal.push({ blockId, beforeHash: expectedHash, afterHash: hashBytes(after) });
      return response;
    } catch (error) {
      await writeFile(this.candidatePath, before);
      throw error;
    }
  }
  close() {
    this.closed = true;
  }
}
