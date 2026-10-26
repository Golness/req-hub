/** Sync v2: immutable references → analysis → isolated edit → deterministic diff. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { executeTask, prepareTaskPrompt, TaskExecutorConfig } from './task-executor.js';
import { estimateTextTokens, estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';
import { resolveSyncBudget, estimateArtifactReadTokens, estimateArtifactReadCost } from './sync-budget.js';
import { parseSyncCodeDiff } from './sync-code-files.js';
import { posix } from 'node:path';
import { ConcurrentChunkProcessor } from './concurrency/ConcurrentChunkProcessor.js';
import { PROMPT_REGISTRY } from './prompts.js';
import { SyncArtifacts } from './sync-artifacts.js';
import { assertSyncCapabilities, installSyncTools, SYNC_TOOLS, OUTPUT_LIMIT, REQUEST_RESERVE } from './sync-controlled-tools.js';
import { indexDocument, parseAnalysisChanges, validateCandidate } from './sync-document-validator.js';
import { renderSessionDocument, renderSessionTurn } from './session-utils.js';

function countTokens(text) { return estimateTextTokens(text); }

/** Prefer whole groups, splitting oversized groups only at file or turn boundaries. */
export async function packSyncChunks(groups, { buildVariables, preparePrompt, measureTokens, measureReadPages, maxReadPages = Infinity, details, maxTokens = MAX_SYNC_INPUT_TOKENS }) {
  const chunks = [];
  let pending = [];
  const upperTotal = groups.reduce((n, group) => n + group.items.length, 0);
  const measure = async (items, index, total) => {
    const variables = buildVariables(items, index, total);
    const preparedPromptData = await preparePrompt(variables);
    return { variables, preparedPromptData, tokens: measureTokens ? await measureTokens(variables) : estimateSubagentInputTokens(preparedPromptData.fullPrompt), readPages: measureReadPages ? await measureReadPages(variables) : 0 };
  };
  const fits = async items => { const value = await measure(items, chunks.length, upperTotal); return value.tokens < maxTokens && value.readPages <= maxReadPages; };
  for (const group of groups) {
    if (await fits([...pending, ...group.items])) {
      pending.push(...group.items);
      continue;
    }
    if (pending.length) { chunks.push({ items: pending }); pending = []; }
    if (await fits(group.items)) { pending = [...group.items]; continue; }
    if (!group.splittable) throw new Error('单个会话超过同步输入预算：' + group.name);
    for (const item of group.items) {
      if (await fits([...pending, item])) { pending.push(item); continue; }
      if (pending.length) { chunks.push({ items: pending }); pending = []; }
      if (!await fits([item])) {
        const measured = await measure([item], chunks.length, upperTotal);
        throw new Error('单个' + (item.file ? '代码文件' : '会话轮次') + '超过同步输入预算：' + (item.file || ((item.sessionId || item.sessionTitle || '未提供会话标识') + ' · 轮次 ' + (item.turnNumber ?? '未知'))) + `（完整输入保守估算 ${measured.tokens.toLocaleString()}，上限 ${maxTokens.toLocaleString()}，含提示词、文档和证据）`);
      }
      pending.push(item);
    }
  }
  if (pending.length) chunks.push({ items: pending });
  for (const [index, chunk] of chunks.entries()) {
    const measured = await measure(chunk.items, index, chunks.length);
    if (measured.tokens >= maxTokens || measured.readPages > maxReadPages) throw new Error('完整同步输入超过预算');
    Object.assign(chunk, { index, total: chunks.length, tokens: measured.tokens, readPages: measured.readPages, details: chunk.items.map(details) });
    Object.defineProperties(chunk, {
      variables: { value: measured.variables },
      preparedPromptData: { value: measured.preparedPromptData },
    });
  }
  const totalTokens = chunks.reduce((n, c) => n + c.tokens, 0);
  chunks.forEach(c => { c.totalTokens = totalTokens; });
  return chunks;
}

/**
 * @typedef {Object} DiffFile
 * @property {string} file - File path
 * @property {string} content - File diff content
 * @property {number} tokens - Estimated token count
 */

/**
 * Parse code diff into individual file array.
 * @param {string} codeDiff - Full diff content
 * @returns {DiffFile[]} Array of parsed files
 */
/** Consolidate a file's committed and working-tree layers before grouping by package directory. */
export async function chunkCodeDiff(files, options) {
  const byFile = new Map();
  for (const file of files) {
    const key = file.part === undefined ? file.file : `${file.file}\0${file.part}`;
    if (byFile.has(key)) byFile.get(key).content += '\n' + file.content;
    else byFile.set(key, { ...file });
  }
  const packages = new Map();
  for (const file of byFile.values()) {
    const name = posix.dirname(file.file.replaceAll('\\', '/'));
    if (!packages.has(name)) packages.set(name, { name, items: [], splittable: true });
    packages.get(name).items.push(file);
  }
  return packSyncChunks([...packages.values()], { ...options, details: item => ({ type: 'file', file: item.file, tokens: countTokens(item.content), lines: item.content.split('\n').length }) });
}

/** Prefer whole sessions; split oversized sessions only between complete turns. */
export async function chunkTurns(turns, options) {
  const sessions = new Map();
  for (const turn of turns) {
    const name = turn.sessionId || turn.sessionTitle || '未提供会话标识';
    if (!sessions.has(name)) sessions.set(name, { name, items: [], splittable: true });
    sessions.get(name).items.push(turn);
  }
  return packSyncChunks([...sessions.values()], { ...options, details: turn => ({ type: 'turn', sessionId: turn.sessionId, turnNumber: turn.turnNumber, part: turn.part, tokens: estimateTextTokens(turn.part === undefined ? renderSessionTurn(turn) : turn.content), userInputPreview: (turn.messages?.find(message => message.role === 'user')?.text || turn.userInput || '').slice(0, 100) }) });
}

export class PhasedSyncEngine {
  constructor(options = {}) { Object.assign(this, options); this.config ||= {}; }
  file(syncDir, name) { return this.storage ? this.storage.file(this.task, name) : join(syncDir, name); }
  getStageConfig(key) {
    const custom = this.config.ai?.syncV2?.prompts?.[key]?.trim();
    if (custom && /\{(?:codeDiff|currentDoc|sessionContent|commitList|analysisFilePaths|originalDocPath|outputFilePath)\}/.test(custom)) throw new Error('PROMPT_CONTRACT_CONFLICT: ' + key);
    if (this.config.ai?.syncV2?.skillBindings?.[key] && this.config.ai.syncV2.contractVersion !== 2) throw new Error('SKILL_CONTRACT_UNCONFIRMED: 请按 v2 契约重新确认 Skill 绑定');
    if (!custom || custom === PROMPT_REGISTRY[key]?.default) return this.config;
    return { ...this.config, ai: { ...this.config.ai, syncV2: { ...this.config.ai.syncV2,
      prompts: { ...this.config.ai.syncV2.prompts, [key]: custom + '\n\n以下 v2 契约必须遵守：\n' + PROMPT_REGISTRY[key].default } } } };
  }
  async preparePrompt(key, variables) {
    const prompt = await prepareTaskPrompt(this.ctx, this.llm, this.getStageConfig(key), { promptKey: key, variables, cwd: this.cwd, parentAgent: this.parentAgent });
    const binding = this.config.ai?.syncV2?.skillBindings?.[key];
    if (binding && prompt.skillUsed !== binding) throw new Error('SKILL_LOAD_FAILED: ' + binding);
    return prompt;
  }
  async prepareSyncChunks(options) {
    this.assertActive?.();
    await options.onPreparation?.({ stage: 'budget' });
    this.nativeEditor = assertSyncCapabilities(this.ctx, this.config, this.parentAgent);
    this.signal?.throwIfAborted();
    const budget = await resolveSyncBudget({ ctx: this.ctx, llm: this.llm, parentAgent: this.parentAgent,
      agentOptions: { ...TaskExecutorConfig.defaultAgentOptions, ...this.config.ai?.delegation?.agentOptions }, signal: this.signal });
    const { docType, syncDir, currentDoc = '', commits = [], sourceSnapshots = [], codeDiff = '', sessionTurns = [] } = options;
    if (!['requirement', 'design'].includes(docType)) throw new Error('DOCUMENT_TYPE');
    await mkdir(syncDir, { recursive: true });
    const originalBytes = options.originalVersion?.bytes || Buffer.from(currentDoc);
    const store = await new SyncArtifacts(join(syncDir, 'input'), { storage: this.storage, task: this.task }).init(), blocks = indexDocument(originalBytes);
    await store.put('document.original', originalBytes);
    await store.put('document.blocks', JSON.stringify(blocks));
    await store.put('commits', JSON.stringify(commits));
    const common = ['document.original', 'document.blocks', 'commits'];
    await store.put('code.input', codeDiff);
    const byFile = new Map();
    for (const file of parseSyncCodeDiff(codeDiff, { withRanges: true })) {
      const existing = byFile.get(file.file);
      if (existing) { existing.content += '\n\n' + file.content; existing.parts.push('\n\n', ...file.parts); }
      else byFile.set(file.file, { ...file });
    }
    const codeFiles = [];
    for (const [i, file] of [...byFile.values()].entries()) {
      if (i % 10 === 0) await options.onPreparation?.({ stage: 'artifacts', current: i, total: byFile.size });
      const id = 'code.' + i, required = [id + '.diff'], context = [];
      await store.putSegments(required[0], file.parts, file.content);
      const snapshot = sourceSnapshots.find(source => source.file === file.file);
      if (snapshot?.commitChanges) {
        await store.putJSON(id + '.selected-commits', snapshot);
        context.push(id + '.selected-commits');
      }
      else if (snapshot) for (const layer of ['base', 'target', 'final']) {
        await store.putJSON(id + '.' + layer, { file: file.file, exists: snapshot[layer] !== null, content: snapshot[layer] });
        context.push(id + '.' + layer);
      }
      codeFiles.push({ file: file.file, content: file.content, required, context });
    }
    const turns = [], sessionFiles = [], sessionGroups = new Map();
    for (const turn of sessionTurns) {
      if (turn.syncable === false) throw new Error('SESSION_TURN_INCOMPLETE: ' + turn.sessionId);
      const key = turn.sessionId || '未提供会话标识';
      if (!sessionGroups.has(key)) sessionGroups.set(key, []);
      sessionGroups.get(key).push(turn);
    }
    const sessionNumbers = new Map();
    for (const [sessionId, group] of sessionGroups) {
      const number = sessionNumbers.size + 1; sessionNumbers.set(sessionId, number);
      const file = `sessions/session-${number}.md`;
      await store.put('session.document.' + number, renderSessionDocument(sessionId, group), file);
      sessionFiles.push('input/' + file);
    }
    for (const [i, turn] of sessionTurns.entries()) {
      const id = 'session.turn.' + i;
      const sessionId = turn.sessionId || '未提供会话标识';
      const file = `sessions/session-${sessionNumbers.get(sessionId)}-turn-${i + 1}.md`;
      await store.put(id, renderSessionDocument(sessionId, [turn]), file);
      sessionFiles.push('input/' + file);
      turns.push({ ...turn, required: [id], context: [] });
    }
    // All ten rendered contracts and Skills are checked before any model is started.
    const templates = {};
    for (const key of Object.keys(PROMPT_REGISTRY).filter(k => k.startsWith('phased-'))) {
      templates[key] = await this.preparePrompt(key, { runtimeId: '00000000-0000-0000-0000-000000000000', manifestId: 'stage-manifest', reportId: 'report', changesId: 'changes' });
    }
    const costs = new Map();
    const measureCost = async (ids, field) => {
      let total = 0;
      for (const id of new Set(ids)) {
        if (!costs.has(id)) costs.set(id, estimateArtifactReadCost(id, await store.read(id)));
        total += costs.get(id)[field];
      }
      return total;
    };
    const cost = ids => measureCost(ids, 'tokens');
    const pages = ids => measureCost(ids, 'pages');
    const commonCost = await cost(common);
    const maxReadPages = this.config.sync?.maxAnalysisReadPages ?? 24;
    if (!Number.isSafeInteger(maxReadPages) || maxReadPages < 8 || maxReadPages > 128) throw new Error('SYNC_READ_PAGE_LIMIT_INVALID');
    const commonPages = await pages(common);
    const manifestPageReserve = 4;
    // Reserve space for the stage manifest. Large documents still get
    // their necessary reads, with at least four pages left for new evidence.
    const readPageLimit = Math.max(maxReadPages, commonPages + manifestPageReserve + 4);
    const optionalContextTokens = Math.min(8192, Math.floor(budget.limit * 0.08));
    const fixed = Math.max(...Object.values(templates).map(prompt => estimateSubagentInputTokens(prompt.fullPrompt))) + REQUEST_RESERVE + 4096 + 2 * OUTPUT_LIMIT + optionalContextTokens;
    if (fixed + commonCost * 2 >= budget.limit) throw new Error('DOCUMENT_INPUT_TOO_LARGE: 文档与固定契约超出完整读取预算');
    // Large files can include several full frozen source versions. Preserve every byte,
    // but give each analysis only a bounded, labelled range instead of requiring the
    // entire file and all versions in a single child context.
    const boundEvidence = async (items, session = false) => {
      const bounded = [];
      for (const item of items) {
        if (fixed + commonCost + await cost(item.required) + 1024 < budget.limit && commonPages + await pages(item.required) + manifestPageReserve <= readPageLimit) {
          bounded.push(item); continue;
        }
        let part = 0;
        for (const sourceId of item.required) {
          const text = await store.read(sourceId);
          let start = 0;
          while (start < text.length) {
            this.signal?.throwIfAborted();
            const id = sourceId + '.part-' + part;
            const wrap = end => JSON.stringify({ file: item.file, sessionId: item.sessionId, turnNumber: item.turnNumber,
              fragment: true, part, sourceArtifactId: sourceId, start, end, totalChars: text.length, text: text.slice(start, end) });
            let low = start + 1, high = text.length, end = start;
            while (low <= high) {
              const middle = Math.floor((low + high) / 2);
              const measured = estimateArtifactReadCost(id, wrap(middle));
              if (fixed + commonCost + measured.tokens + 1024 < budget.limit && commonPages + measured.pages + manifestPageReserve <= readPageLimit) { end = middle; low = middle + 1; }
              else high = middle - 1;
            }
            // Prefer message boundaries; split an oversized message losslessly at a line boundary.
            const message = session ? text.lastIndexOf('\n### ', end - 1) : -1;
            if (message > start) end = message + 1;
            const newline = text.lastIndexOf('\n', end - 1);
            if (newline >= start + (end - start) / 2) end = newline + 1;
            if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
            if (end <= start) throw new Error('DOCUMENT_INPUT_TOO_LARGE: 固定输入预算不足以读取证据片段：' + (item.file || item.sessionId));
            const rendered = wrap(end), metadata = JSON.parse(rendered); delete metadata.text;
            await store.putFragment(id, sourceId, metadata, rendered);
            bounded.push({ ...item, part: part++, content: text.slice(start, end), required: [id] });
            start = end;
          }
        }
      }
      return bounded;
    };
    const boundedCodeFiles = await boundEvidence(codeFiles);
    await options.onPreparation?.({ stage: 'chunks' });
    const boundedTurns = await boundEvidence(turns, true);
    const packing = () => ({
      maxTokens: budget.limit,
      buildVariables: items => ({ ids: [...common, ...items.flatMap(item => item.required)] }),
      preparePrompt: async () => ({ fullPrompt: '' }),
      measureTokens: async variables => fixed + await cost(variables.ids) + 1024,
      measureReadPages: async variables => manifestPageReserve + await pages(variables.ids),
      maxReadPages: readPageLimit,
    });
    const code = await chunkCodeDiff(boundedCodeFiles, packing());
    const discussion = await chunkTurns(boundedTurns, packing());
    const stage = async (source, chunk) => {
      const id = source + '-' + chunk.index, manifestId = 'manifest.' + id;
      const required = [...common, ...chunk.items.flatMap(item => item.required)];
      const allowed = [...required, ...chunk.items.flatMap(item => item.context)];
      await store.put(manifestId, JSON.stringify({ schemaVersion: 2, chunkId: id, docType, task: options.syncContext || {}, required, context: [...new Set(allowed.filter(item => !required.includes(item)))], optionalContextTokens,
        fragments: chunk.items.filter(item => item.part !== undefined).map(item => ({ artifactId: item.required[0], part: item.part, sessionId: item.sessionId, turnNumber: item.turnNumber })),
        outputIds: ['report', 'changes'], limitBytes: OUTPUT_LIMIT, estimatedReadPages: chunk.readPages }));
      return Object.assign(chunk, { id, manifestId, required: [manifestId, ...required], allowed: [manifestId, ...allowed] });
    };
    for (const chunk of code) await stage('code', chunk);
    for (const chunk of discussion) await stage('discussion', chunk);
    // Binary reduction: every merge node reads at most two bounded reports and indices.
    const mergeCost = fixed + commonCost + 4 * OUTPUT_LIMIT;
    // Reports have byte caps, not fixed token costs. Validate each actual merge
    // input below rather than rejecting small reports at their theoretical maxima.
    const plan = { schemaVersion: 2, task: options.syncContext || {}, store, code, discussion, common, blocks, originalBytes, templates, fixed, commonCost, sessionFiles,
      budget: { ...budget, reserve: REQUEST_RESERVE, optionalContextTokens, commonCost, mergeCost, maxAnalysisReadPages: readPageLimit } };
    await store.manifest({ docType, task: plan.task, blocks, codeChunks: code.map(c => c.id), discussionChunks: discussion.map(c => c.id), budget: plan.budget });
    await writeFile(this.file(syncDir, docType === 'design' ? 'design.md.prev' : 'requirement.md.prev'), originalBytes);
    this.signal?.throwIfAborted();
    return plan;
  }
  async executeTask(key, variables, options = {}) {
    this.assertActive?.();
    if (!this.parentAgent) throw new Error('缺少父 Agent，无法执行同步');
    const result = await executeTask(this.ctx, this.llm, this.getStageConfig(key), {
      promptKey: key, variables, preparedPromptData: options.preparedPromptData,
      parentAgent: this.parentAgent, cwd: this.cwd, signal: this.signal,
      timeout: TaskExecutorConfig.defaultTimeout, maxInputTokens: options.runtime?.inputLimit ?? MAX_SYNC_INPUT_TOKENS,
      runtime: options.runtime, syncV2: true, liveness: { enabled: false },
      toolFilter: { allow: SYNC_TOOLS }, description: '同步 v2: ' + key,
      callbacks: { onProgress: progress => {
        if (progress.stage === 'executing') return options.onSubagentStart?.(progress.sessionId);
      } },
    });
    if (result.isError) {
      const error = new Error([result.errorCode || 'SYNC_SUBAGENT_FAILED', result.diagnostic].filter(Boolean).join(': '));
      Object.assign(error, { code: result.errorCode, stopReason: result.stopReason, sessionId: result.sessionId });
      throw error;
    }
    return result;
  }
  async sync(options) {
    const progress = options.onProgress || (() => {}), { docType, syncDir } = options;
    const result = { schemaVersion: 2, mergedDoc: null, codeAnalysis: null, discussionAnalysis: null,
      errors: [], stats: { codeChunks: 0, discussionChunks: 0, totalLLMCalls: 0 }, chunks: {} };
    let phase = 'init';
    const emitFile = async (which, fileName) => progress({ phase: which, status: 'output_file', fileName });
    try {
      const plan = options.preparedChunks || await this.prepareSyncChunks(options);
      if (plan.schemaVersion !== 2) throw new Error('SYNC_PLAN_VERSION');
      const { store, blocks, originalBytes, common } = plan;
      const fileName = docType === 'design' ? 'design.md' : 'requirement.md';
      const run = async (key, stage, which, mergeInputs = null, edit = null) => {
        this.signal?.throwIfAborted();
        let inputCost = plan.fixed;
        for (const id of new Set(stage.required)) inputCost += estimateArtifactReadTokens(id, await store.read(id));
        if (edit) inputCost += estimateArtifactReadTokens('candidate', originalBytes.toString('utf8'));
        if (inputCost >= plan.budget.limit) throw new Error('SYNC_STAGE_INPUT_TOO_LARGE: ' + stage.id);
        const reportPath = this.file(syncDir, stage.id + '.md'), changesPath = this.file(syncDir, stage.id + '.json');
        const evidenceIds = mergeInputs
          ? [...new Set(mergeInputs.flatMap(input => input.index.changes.flatMap(change => change.evidenceRefs)))]
          : stage.allowed.filter(id => /^(code\.|session\.)/.test(id));
        const checkChanges = async (raw, runtime) => {
          const parsed = parseAnalysisChanges(raw, blocks, evidenceIds);
          if (!mergeInputs) for (const change of parsed.changes) for (const id of change.evidenceRefs) {
            if ((runtime.coverage.get(id) ?? -1) < (await store.read(id)).length) throw new Error('EVIDENCE_REFERENCE_NOT_READ: ' + id);
          }
          if (mergeInputs) {
            const covered = new Set([...parsed.changes, ...parsed.pending].flatMap(change => [change.id, ...(change.sourceIds || [])]));
            const missing = mergeInputs.flatMap(input => [...input.index.changes, ...input.index.pending]).filter(change => !covered.has(change.id));
            if (missing.length) throw new Error('MERGE_CHANGE_DROPPED: preserve every input id in results or pending, directly or via sourceIds. Missing: ' + JSON.stringify(missing.map(change => change.id)));
          }
          return parsed;
        };
        this.assertActive?.();
        const runtime = installSyncTools(this.ctx).create({ store, allowed: stage.allowed, required: stage.required, signal: this.signal, onActivity: this.onActivity, assertActive: this.assertActive,
          maxCompletionReminders: this.config.sync?.maxCompletionReminders ?? 3,
          nativeEditor: this.nativeEditor, parentAgent: this.parentAgent, budget: plan.budget,
          outputs: edit ? {} : { report: reportPath, changes: changesPath }, ...edit });
        runtime.validateOutput = async (outputId, content) => {
          if (outputId === 'changes') await checkChanges(content, runtime);
        };
        try {
          const variables = { runtimeId: runtime.id, manifestId: stage.manifestId, reportId: 'report', changesId: 'changes' };
          const preparedPromptData = await this.preparePrompt(key, variables);
          await this.executeTask(key, variables, { preparedPromptData, runtime, onSubagentStart: sessionId => progress({ phase: which, status: Number.isInteger(stage.index) ? 'chunk_subagent' : 'summary_subagent', chunkIndex: stage.index, sessionId }) });
          await runtime.assertCoverage();
          result.stats.totalLLMCalls++;
          if (edit) return runtime.journal;
          const missingOutputs = ['report', 'changes'].filter(id => !runtime.outputWritten.has(id));
          if (missingOutputs.length) {
            const validationErrors = missingOutputs.map(id => runtime.outputErrors.get(id)).filter(Boolean);
            throw new Error('OUTPUT_NOT_WRITTEN: ' + missingOutputs.join(', ') + (validationErrors.length ? '; ' + validationErrors.join('; ') : ''));
          }
          const report = await readFile(reportPath, 'utf8'), raw = await readFile(changesPath, 'utf8');
          if (!report.trim() || Buffer.byteLength(raw) > OUTPUT_LIMIT || Buffer.byteLength(report) > OUTPUT_LIMIT) throw new Error('OUTPUT_SIZE');
          let parsed = await checkChanges(raw, runtime);
          if (!mergeInputs) {
            parsed = { ...parsed, changes: parsed.changes.map(change => ({ ...change, id: stage.id + ':' + change.id })), pending: parsed.pending.map((change, i) => ({ ...change, id: stage.id + ':pending:' + i })) };
            if (Buffer.byteLength(JSON.stringify(parsed)) > OUTPUT_LIMIT) throw new Error('OUTPUT_SIZE');
            await writeFile(changesPath, JSON.stringify(parsed), 'utf8');
          }
          await emitFile(which, stage.id + '.md'); await emitFile(which, stage.id + '.json');
          const reportId = stage.id + '.report', changesId = stage.id + '.changes';
          await store.put(reportId, report); await store.put(changesId, JSON.stringify(parsed));
          return { report, index: parsed, reportId, changesId };
        } finally {
          try {
            if (!this.signal?.aborted) {
              const name = stage.id + '.read-state.json';
              const diagnostic = await runtime.diagnostics();
              this.signal?.throwIfAborted(); this.assertActive?.();
              await writeFile(this.file(syncDir, name), JSON.stringify(diagnostic, null, 2), { signal: this.signal });
              await emitFile(which, name);
            }
          } finally { runtime.close(); }
        }
      };
      let mergeNumber = 0;
      const consolidate = async (inputs, source, targetPhase = source === 'code' ? 'code_analysis' : 'discussion_analysis') => {
        while (inputs.length > 1) {
          const next = [];
          for (let i = 0; i < inputs.length; i += 2) {
            const pair = inputs.slice(i, i + 2);
            if (pair.length === 1) { next.push(pair[0]); continue; }
            const id = 'summary-' + mergeNumber++, manifestId = 'manifest.' + id;
            const required = [...common, ...pair.flatMap(input => [input.reportId, input.changesId])];
            await store.put(manifestId, JSON.stringify({ schemaVersion: 2, required, outputIds: ['report', 'changes'] }));
            const stage = { id, manifestId, required: [manifestId, ...required], allowed: [manifestId, ...required] };
            next.push(await run(`phased-${source}-analysis-merge-${docType}`, stage, targetPhase, pair));
          }
          inputs = next;
        }
        return inputs[0] || null;
      };
      const all = [];
      for (const source of ['code', 'discussion']) {
        phase = source === 'code' ? 'code_analysis' : 'discussion_analysis';
        const chunks = plan[source]; result.stats[source === 'code' ? 'codeChunks' : 'discussionChunks'] = chunks.length;
        result.chunks[source] = chunks;
        if (!chunks.length) { await progress({ phase, status: 'skipped', reason: '无相关变更' }); continue; }
        const processor = new ConcurrentChunkProcessor({ maxConcurrency: 3 });
        await progress({ phase, status: 'started', concurrency: processor.maxConcurrency, codeFiles: chunks.flatMap(c => c.items).length, codeTokens: chunks.reduce((n, c) => n + c.tokens, 0) });
        const processed = await processor.processAll(chunks, (chunk, index) => run(`phased-${source}-analysis-${docType}`, chunk, phase), { signal: this.signal, onProgress: progress, phase });
        this.signal?.throwIfAborted();
        if (processed.errors.length) throw new Error([...new Set(processed.errors.map(error => error.error))].join('；'));
        const combined = await consolidate(processed.results, source);
        const canonical = source === 'code' ? 'code-diffs.md' : 'discussion-diffs.md';
        await writeFile(this.file(syncDir, canonical), combined.report, 'utf8'); await emitFile(phase, canonical);
        result[source === 'code' ? 'codeAnalysis' : 'discussionAnalysis'] = combined.report;
        all.push(combined); await progress({ phase, status: 'completed' });
      }
      phase = 'merge';
      await progress({ phase, status: 'started' });
      const combined = await consolidate(all, 'code', phase);
      const changes = combined?.index.changes || [];
      this.signal?.throwIfAborted();
      await writeFile(this.file(syncDir, 'change-plan.json'), JSON.stringify(combined?.index || { changes: [], pending: [] }, null, 2));
      await emitFile(phase, 'change-plan.json'); await emitFile(phase, fileName + '.prev');
      const candidatePath = this.file(syncDir, 'candidate-' + fileName);
      await writeFile(candidatePath, originalBytes);
      if (changes.length) {
        const planId = 'validated.plan'; await store.put(planId, JSON.stringify(combined.index));
        const required = [...common, planId, combined.reportId];
        const manifestId = 'manifest.edit';
        await store.put(manifestId, JSON.stringify({ schemaVersion: 2, required, candidateId: 'candidate', allowedBlockIds: [...new Set(changes.map(change => change.blockId))] }));
        const journal = await run(`phased-merge-${docType}`, { id: 'edit', manifestId, required: [manifestId, ...required], allowed: [manifestId, ...required] }, phase, null,
          { candidatePath, originalBytes, fileName, changes, blocks });
        if (!journal.length || changes.some(change => !journal.some(edit => edit.blockId === change.blockId))) throw new Error('EDIT_NOT_PERFORMED');
        await writeFile(this.file(syncDir, 'edit-journal.json'), JSON.stringify(journal, null, 2)); await emitFile(phase, 'edit-journal.json');
      }
      const candidateBytes = await readFile(candidatePath);
      await emitFile(phase, 'candidate-' + fileName);
      await progress({ phase: 'merge', status: changes.length ? 'completed' : 'skipped', reason: '无可执行变更' });
      phase = 'validate';
      this.signal?.throwIfAborted();
      await progress({ phase, status: 'started' });
      const validation = validateCandidate(originalBytes, candidateBytes, fileName, changes, blocks);
      for (const name of ['document.patch', 'applied-document.diff']) { await writeFile(this.file(syncDir, name), validation.patch, 'utf8'); await emitFile(phase, name); }
      await writeFile(this.file(syncDir, 'validation.json'), JSON.stringify(validation, null, 2)); await emitFile(phase, 'validation.json');
      await store.manifest({ docType, task: plan.task, validation, blocks, budget: plan.budget });
      await progress({ phase, status: 'completed' });
      result.mergedDoc = candidateBytes.toString('utf8'); result.candidateBytes = candidateBytes; result.validation = validation;
      result.originalBytes = originalBytes; result.patchFile = 'document.patch'; result.appliedDiffFile = 'applied-document.diff';
    } catch (error) {
      result.errors.push({ phase, error: error.message });
      await progress({ phase, status: this.signal?.aborted ? 'aborted' : 'failed', error: error.message });
      if (this.signal?.aborted) { result.aborted = true; result.stopReason = 'aborted'; }
    }
    return result;
  }
}


