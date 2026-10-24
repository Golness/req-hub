/** Sync v2: immutable references → analysis → isolated edit → deterministic diff. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { executeTask, prepareTaskPrompt, TaskExecutorConfig } from './task-executor.js';
import { charsToTokens, estimateTextTokens, estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';
import { parseSyncCodeDiff } from './sync-code-files.js';
import { posix } from 'node:path';
import { ConcurrentChunkProcessor } from './concurrency/ConcurrentChunkProcessor.js';
import { PROMPT_REGISTRY } from './prompts.js';
import { SyncArtifacts } from './sync-artifacts.js';
import { assertSyncCapabilities, installSyncTools, SYNC_TOOLS, OUTPUT_LIMIT, REQUEST_RESERVE } from './sync-controlled-tools.js';
import { indexDocument, validateChanges, validateCandidate } from './sync-document-validator.js';
import { renderSessionDocument, renderSessionTurn } from './session-utils.js';

function countTokens(text) { return charsToTokens(text.length); }

/** Prefer whole groups, splitting oversized groups only at file or turn boundaries. */
export async function packSyncChunks(groups, { buildVariables, preparePrompt, details, maxTokens = MAX_SYNC_INPUT_TOKENS }) {
  const chunks = [];
  let pending = [];
  const upperTotal = groups.reduce((n, group) => n + group.items.length, 0);
  const measure = async (items, index, total) => {
    const variables = buildVariables(items, index, total);
    const preparedPromptData = await preparePrompt(variables);
    return { variables, preparedPromptData, tokens: estimateSubagentInputTokens(preparedPromptData.fullPrompt) };
  };
  const fits = async items => (await measure(items, chunks.length, upperTotal)).tokens < maxTokens;
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
    if (measured.tokens >= maxTokens) throw new Error('完整同步输入超过预算');
    Object.assign(chunk, { index, total: chunks.length, tokens: measured.tokens, details: chunk.items.map(details) });
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
  return packSyncChunks([...sessions.values()], { ...options, details: turn => ({ type: 'turn', sessionId: turn.sessionId, turnNumber: turn.turnNumber, tokens: estimateTextTokens(renderSessionTurn(turn)), userInputPreview: (turn.messages?.find(message => message.role === 'user')?.text || turn.userInput || '').slice(0, 100) }) });
}

export class PhasedSyncEngine {
  constructor(options = {}) { Object.assign(this, options); this.config ||= {}; }
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
    this.nativeEditor = assertSyncCapabilities(this.ctx, this.config, this.parentAgent);
    this.signal?.throwIfAborted();
    const { docType, syncDir, currentDoc = '', commits = [], sourceSnapshots = [], codeDiff = '', sessionTurns = [] } = options;
    if (!['requirement', 'design'].includes(docType)) throw new Error('DOCUMENT_TYPE');
    await mkdir(syncDir, { recursive: true });
    const originalBytes = options.originalVersion?.bytes || Buffer.from(currentDoc);
    const store = await new SyncArtifacts(join(syncDir, 'input')).init(), blocks = indexDocument(originalBytes);
    await store.put('document.original', originalBytes);
    await store.put('document.blocks', JSON.stringify(blocks));
    await store.put('commits', JSON.stringify(commits));
    const common = ['document.original', 'document.blocks', 'commits'];
    const byFile = new Map();
    for (const file of parseSyncCodeDiff(codeDiff)) {
      const existing = byFile.get(file.file);
      if (existing) existing.content += '\n\n' + file.content;
      else byFile.set(file.file, { ...file });
    }
    const codeFiles = [];
    for (const [i, file] of [...byFile.values()].entries()) {
      const id = 'code.' + i, required = [id + '.diff'], context = [];
      await store.put(required[0], file.content);
      const snapshot = sourceSnapshots.find(source => source.file === file.file);
      if (snapshot?.commitChanges) {
        await store.put(id + '.selected-commits', JSON.stringify(snapshot));
        context.push(id + '.selected-commits');
      }
      else if (snapshot) for (const layer of ['base', 'target', 'final']) {
        await store.put(id + '.' + layer, JSON.stringify({ file: file.file, exists: snapshot[layer] !== null, content: snapshot[layer] }));
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
    const cost = async ids => {
      let total = 0;
      for (const id of new Set(ids)) total += estimateSubagentInputTokens(JSON.stringify({ artifactId: id, text: await store.read(id) })) + 1024;
      return total;
    };
    const commonCost = await cost(common);
    const fixed = Math.max(...Object.values(templates).map(prompt => estimateSubagentInputTokens(prompt.fullPrompt))) + REQUEST_RESERVE + 16000 + 2 * OUTPUT_LIMIT;
    if (fixed + commonCost * 2 >= MAX_SYNC_INPUT_TOKENS) throw new Error('DOCUMENT_INPUT_TOO_LARGE: 文档与固定契约超出完整读取预算');
    // Large files can include several full frozen source versions. Preserve every byte,
    // but give each analysis only a bounded, labelled range instead of requiring the
    // entire file and all versions in a single child context.
    const boundedCodeFiles = [];
    for (const file of codeFiles) {
      if (fixed + commonCost + await cost([...file.required, ...file.context]) + 8 < MAX_SYNC_INPUT_TOKENS) {
        boundedCodeFiles.push(file); continue;
      }
      let part = 0;
      for (const sourceId of [...file.required, ...file.context]) {
        const text = await store.read(sourceId);
        let start = 0;
        while (start < text.length) {
          const id = sourceId + '.part-' + part;
          const wrap = end => JSON.stringify({ file: file.file, sourceArtifactId: sourceId, start, end, totalChars: text.length, text: text.slice(start, end) });
          let low = start + 1, high = text.length, end = start;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const tokens = estimateSubagentInputTokens(JSON.stringify({ artifactId: id, text: wrap(middle) })) + 1024;
            if (fixed + commonCost + tokens + 8 < MAX_SYNC_INPUT_TOKENS) { end = middle; low = middle + 1; }
            else high = middle - 1;
          }
          const newline = text.lastIndexOf('\n', end - 1);
          if (newline >= start + (end - start) / 2) end = newline + 1;
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          if (end <= start) throw new Error('DOCUMENT_INPUT_TOO_LARGE: 固定输入预算不足以读取代码片段：' + file.file);
          await store.put(id, wrap(end));
          boundedCodeFiles.push({ file: file.file, part: part++, content: text.slice(start, end), required: [id], context: [] });
          start = end;
        }
      }
    }
    const packing = () => ({
      buildVariables: items => ({ ids: [...common, ...items.flatMap(item => [...item.required, ...item.context])] }),
      preparePrompt: async variables => ({ fullPrompt: 'x'.repeat(fixed + await cost(variables.ids)) }),
    });
    const code = await chunkCodeDiff(boundedCodeFiles, packing());
    const discussion = await chunkTurns(turns, packing());
    const stage = async (source, chunk) => {
      const id = source + '-' + chunk.index, manifestId = 'manifest.' + id;
      const required = [...common, ...chunk.items.flatMap(item => item.required)];
      const allowed = [...required, ...chunk.items.flatMap(item => item.context)];
      await store.put(manifestId, JSON.stringify({ schemaVersion: 2, chunkId: id, docType, task: options.syncContext || {}, required, context: allowed.filter(item => !required.includes(item)), outputIds: ['report', 'changes'], limitBytes: OUTPUT_LIMIT }));
      return Object.assign(chunk, { id, manifestId, required: [manifestId, ...required], allowed: [manifestId, ...allowed] });
    };
    for (const chunk of code) await stage('code', chunk);
    for (const chunk of discussion) await stage('discussion', chunk);
    // Binary reduction: every merge node reads at most two bounded reports and indices.
    const mergeCost = fixed + commonCost + 4 * OUTPUT_LIMIT;
    if (code.length + discussion.length > 1 && mergeCost >= MAX_SYNC_INPUT_TOKENS) throw new Error('MERGE_INPUT_TOO_LARGE: 汇总上界超出预算');
    const plan = { schemaVersion: 2, task: options.syncContext || {}, store, code, discussion, common, blocks, originalBytes, templates, fixed, commonCost, sessionFiles };
    await store.manifest({ docType, task: plan.task, blocks, codeChunks: code.map(c => c.id), discussionChunks: discussion.map(c => c.id), budget: { limit: MAX_SYNC_INPUT_TOKENS, reserve: REQUEST_RESERVE, commonCost, mergeCost } });
    await writeFile(join(syncDir, docType === 'design' ? 'design.md.prev' : 'requirement.md.prev'), originalBytes);
    this.signal?.throwIfAborted();
    return plan;
  }
  async executeTask(key, variables, options = {}) {
    this.assertActive?.();
    if (!this.parentAgent) throw new Error('缺少父 Agent，无法执行同步');
    const result = await executeTask(this.ctx, this.llm, this.getStageConfig(key), {
      promptKey: key, variables, preparedPromptData: options.preparedPromptData,
      parentAgent: this.parentAgent, cwd: this.cwd, signal: this.signal,
      timeout: TaskExecutorConfig.defaultTimeout, maxInputTokens: MAX_SYNC_INPUT_TOKENS,
      syncV2: true, liveness: { enabled: false },
      toolFilter: { allow: SYNC_TOOLS }, description: '同步 v2: ' + key,
      callbacks: { onProgress: progress => {
        if (progress.stage === 'executing') return options.onSubagentStart?.(progress.sessionId);
      } },
    });
    if (result.isError) throw new Error(result.diagnostic || 'SYNC_SUBAGENT_FAILED');
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
        const reportPath = join(syncDir, stage.id + '.md'), changesPath = join(syncDir, stage.id + '.json');
        this.assertActive?.();
        const runtime = installSyncTools(this.ctx).create({ store, allowed: stage.allowed, required: stage.required, signal: this.signal, onActivity: this.onActivity, assertActive: this.assertActive,
          nativeEditor: this.nativeEditor, parentAgent: this.parentAgent,
          outputs: edit ? {} : { report: reportPath, changes: changesPath }, ...edit });
        try {
          const variables = { runtimeId: runtime.id, manifestId: stage.manifestId, reportId: 'report', changesId: 'changes' };
          const preparedPromptData = await this.preparePrompt(key, variables);
          await this.executeTask(key, variables, { preparedPromptData, onSubagentStart: sessionId => progress({ phase: which, status: Number.isInteger(stage.index) ? 'chunk_subagent' : 'summary_subagent', chunkIndex: stage.index, sessionId }) });
          await runtime.assertCoverage();
          result.stats.totalLLMCalls++;
          if (edit) return runtime.journal;
          if (!runtime.outputWritten.has('report') || !runtime.outputWritten.has('changes')) throw new Error('OUTPUT_NOT_WRITTEN');
          const report = await readFile(reportPath, 'utf8'), raw = await readFile(changesPath, 'utf8');
          if (!report.trim() || Buffer.byteLength(raw) > OUTPUT_LIMIT || Buffer.byteLength(report) > OUTPUT_LIMIT) throw new Error('OUTPUT_SIZE');
          let parsed = validateChanges(JSON.parse(raw), blocks, mergeInputs ? [...new Set(mergeInputs.flatMap(input => input.index.changes.flatMap(change => change.evidenceRefs)))] : stage.allowed.filter(id => /^(code\.|session\.)/.test(id)));
          if (!mergeInputs) {
            parsed = { ...parsed, changes: parsed.changes.map(change => ({ ...change, id: stage.id + ':' + change.id })), pending: parsed.pending.map((change, i) => ({ ...change, id: stage.id + ':pending:' + i })) };
            if (Buffer.byteLength(JSON.stringify(parsed)) > OUTPUT_LIMIT) throw new Error('OUTPUT_SIZE');
            await writeFile(changesPath, JSON.stringify(parsed), 'utf8');
          }
          if (!mergeInputs) for (const change of parsed.changes) for (const id of change.evidenceRefs) {
            if ((runtime.coverage.get(id) ?? -1) < (await store.read(id)).length) throw new Error('EVIDENCE_REFERENCE_NOT_READ');
          }
          if (mergeInputs) {
            const covered = new Set([...parsed.changes, ...parsed.pending].flatMap(change => [change.id, ...(change.sourceIds || [])]));
            const previous = mergeInputs.flatMap(input => [...input.index.changes, ...input.index.pending]);
            if (previous.some(change => !covered.has(change.id))) throw new Error('MERGE_CHANGE_DROPPED');
          }
          await emitFile(which, stage.id + '.md'); await emitFile(which, stage.id + '.json');
          const reportId = stage.id + '.report', changesId = stage.id + '.changes';
          await store.put(reportId, report); await store.put(changesId, JSON.stringify(parsed));
          return { report, index: parsed, reportId, changesId };
        } finally { runtime.close(); }
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
        await progress({ phase, status: 'started', codeFiles: chunks.flatMap(c => c.items).length, codeTokens: chunks.reduce((n, c) => n + c.tokens, 0) });
        const processor = new ConcurrentChunkProcessor({ maxConcurrency: 3 });
        const processed = await processor.processAll(chunks, (chunk, index) => run(`phased-${source}-analysis-${docType}`, chunk, phase), { signal: this.signal, onProgress: progress, phase });
        this.signal?.throwIfAborted();
        if (processed.errors.length) throw new Error(processed.errors.map(error => error.error).join('；'));
        const combined = await consolidate(processed.results, source);
        const canonical = source === 'code' ? 'code-diffs.md' : 'discussion-diffs.md';
        await writeFile(join(syncDir, canonical), combined.report, 'utf8'); await emitFile(phase, canonical);
        result[source === 'code' ? 'codeAnalysis' : 'discussionAnalysis'] = combined.report;
        all.push(combined); await progress({ phase, status: 'completed' });
      }
      phase = 'merge';
      await progress({ phase, status: 'started' });
      const combined = await consolidate(all, 'code', phase);
      const changes = combined?.index.changes || [];
      this.signal?.throwIfAborted();
      await writeFile(join(syncDir, 'change-plan.json'), JSON.stringify(combined?.index || { changes: [], pending: [] }, null, 2));
      await emitFile(phase, 'change-plan.json'); await emitFile(phase, fileName + '.prev');
      const candidatePath = join(syncDir, 'candidate-' + fileName);
      await writeFile(candidatePath, originalBytes);
      if (changes.length) {
        const planId = 'validated.plan'; await store.put(planId, JSON.stringify(combined.index));
        const required = [...common, planId, combined.reportId];
        const manifestId = 'manifest.edit';
        await store.put(manifestId, JSON.stringify({ schemaVersion: 2, required, candidateId: 'candidate', allowedBlockIds: [...new Set(changes.map(change => change.blockId))] }));
        const journal = await run(`phased-merge-${docType}`, { id: 'edit', manifestId, required: [manifestId, ...required], allowed: [manifestId, ...required] }, phase, null,
          { candidatePath, originalBytes, fileName, changes, blocks });
        if (!journal.length || changes.some(change => !journal.some(edit => edit.blockId === change.blockId))) throw new Error('EDIT_NOT_PERFORMED');
        await writeFile(join(syncDir, 'edit-journal.json'), JSON.stringify(journal, null, 2)); await emitFile(phase, 'edit-journal.json');
      }
      const candidateBytes = await readFile(candidatePath);
      await emitFile(phase, 'candidate-' + fileName);
      await progress({ phase: 'merge', status: changes.length ? 'completed' : 'skipped', reason: '无可执行变更' });
      phase = 'validate';
      this.signal?.throwIfAborted();
      await progress({ phase, status: 'started' });
      const validation = validateCandidate(originalBytes, candidateBytes, fileName, changes, blocks);
      for (const name of ['document.patch', 'applied-document.diff']) { await writeFile(join(syncDir, name), validation.patch, 'utf8'); await emitFile(phase, name); }
      await writeFile(join(syncDir, 'validation.json'), JSON.stringify(validation, null, 2)); await emitFile(phase, 'validation.json');
      await store.manifest({ docType, task: plan.task, validation, blocks });
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


