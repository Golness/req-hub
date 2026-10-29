import { resolve } from 'node:path';
import { safeDocumentPath } from '../safe-path.js';
import { normalizeSourcePath } from '../knowledge/source-reader.js';
import { realpath, stat } from 'node:fs/promises';
import { externalizeWritingImages, readWritingImage, hasWritingImages, WRITING_IMAGE_INPUT_LIMIT } from '../writing-images.js';
import { resolveSyncBudget } from '../sync-budget.js';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { executeTask } from '../task-executor.js';
import { json, readBody } from '../utils.js';
import { knowledgeError } from '../knowledge/source-reader.js';
import { installWritingTools, WritingRuntime, WRITING_TOOLS } from '../writing-runtime.js';
import { saveWriting } from '../writing-save.js';
import { resolveKnowledgeReferences } from '../knowledge/enhancements/knowledge-context.js';

function writingRequirementPath(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const document = normalizeSourcePath(`${value}/requirement.md`);
    if (document.split('/').length !== 3) throw new Error();
    return document.slice(0, -'/requirement.md'.length);
  } catch { throw knowledgeError('WRITING_REQUIREMENT_INVALID', 400); }
}
export const WRITING_STARTERS = {
  requirement: { label: '需求文档', content: '# 需求文档\n\n## 背景与目标\n\n## 用户与场景\n\n## 功能与业务规则\n\n## 异常与边界\n\n## 验收标准\n' },
  design: { label: '技术方案', content: '# 技术方案\n\n## 背景与目标\n\n## 现状与约束\n\n## 方案设计\n\n## 接口与数据设计\n\n## 风险与兼容性\n\n## 验证与发布\n' },
};

export function createWritingRoutes(registry, llm, agents, ctx, knowledge, options = {}) {
  const jobs = new Map(), reservations = new Set(), pending = new Set(), requests = new Set(); let installation; let closed = false;
  const configLoader = options.configLoader || loadConfig, runTask = options.executeTask || executeTask;
  function scopeData(origin) {
    const store = knowledge.database().scoped(origin.id, { id: origin.workspace_id, title: origin.workspace_title }, origin.workspace_root, origin.docs_root);
    return { identity: origin.id, docsRoot: origin.docs_root, store };
  }
  const catalog = () => knowledge.database().scopes().map(origin => ({ id: origin.id, workspaceId: origin.workspace_id, title: origin.workspace_title, docsRoot: origin.docs_root, ...scopeData(origin).store.status() }));
  const publicJob = job => ({ id: job.id, status: job.status, sessionId: job.sessionId, error: job.error, errorDetails: job.errorDetails, excludedSourceCount: job.excludedSourceCount, result: job.result, createdAt: job.createdAt, activity: job.activity, workspaceId: job.workspaceId, docType: job.docType, requirementPath: job.requirementPath, docsDir: job.docsDir });
  const dispatch = async (req, res) => {
    let reservation;
    try {
      if (closed) throw knowledgeError('写作服务已关闭', 503);
      const url = new URL(req.url, 'http://localhost'), path = url.pathname.slice('/req-hub/writing'.length);
      if (req.method === 'POST' && path === '/assets') {
        let input; try { input = JSON.parse(await readBody(req, WRITING_IMAGE_INPUT_LIMIT + 10000)); } catch { throw knowledgeError('WRITING_IMAGE_INVALID', 400); }
        return json(res, await externalizeWritingImages(registry, await configLoader(), input, () => { if (closed) throw knowledgeError('WRITING_CLOSED', 503); req.operationExec?.signal?.throwIfAborted(); }));
      }
      if (req.method === 'GET' && path.startsWith('/assets/')) {
        const image = await readWritingImage(registry, await configLoader(), { workspaceId: url.searchParams.get('workspaceId'), requirementPath: url.searchParams.get('requirementPath'), filename: path.slice('/assets/'.length) });
        res.writeHead(200, { 'Content-Type': image.contentType, 'Content-Length': image.bytes.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        res.end(image.bytes); return;
      }
      if (req.method === 'GET' && path === '/options') return json(res, { scopes: catalog(), starters: WRITING_STARTERS });
      if (req.method === 'GET' && path === '/jobs') {
        const workspaceId = url.searchParams.get('workspaceId');
        if (!registry.list().some(workspace => workspace.id === workspaceId)) throw knowledgeError('WRITING_SCOPE_DENIED', 403);
        const requirementPath = writingRequirementPath(url.searchParams.get('requirementPath'));
        const docsDir = (await configLoader()).docsDir || 'docs';
        const owner = req.operationExec?.agent?.session?.id;
        const candidates = [...jobs.values()].reverse().filter(job => job.workspaceId === workspaceId && job.requirementPath === requirementPath && job.docsDir === docsDir && (!owner || job.owner === owner) && ['running', 'cancelling', 'completed'].includes(job.status));
        candidates.sort((a, b) => Number(['running', 'cancelling'].includes(b.status)) - Number(['running', 'cancelling'].includes(a.status)) || b.createdAt - a.createdAt);
        return json(res, { jobs: candidates.slice(0, 1).map(publicJob) });
      }
      const match = path.match(/^\/jobs\/([^/]+)(\/cancel)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) throw knowledgeError('优化任务不存在，请重新优化', 404);
        if (req.method === 'POST' && match[2]) { job.controller.abort(); if (job.status === 'running') job.status = 'cancelling'; return json(res, publicJob(job)); }
        if (req.method === 'GET' && !match[2]) return json(res, publicJob(job));
      }
      if (req.method === 'POST' && path === '/save') {
        let input; try { input = JSON.parse(await readBody(req)); } catch { throw knowledgeError('WRITING_SAVE_INVALID', 400); }
        if (!input || typeof input !== 'object') throw knowledgeError('WRITING_SAVE_INVALID', 400);
        try {
          return json(res, await saveWriting(registry, await configLoader(), input, () => { if (closed) throw knowledgeError('WRITING_CLOSED', 503); req.operationExec?.signal?.throwIfAborted(); }));
        } catch (error) {
          if (/^WRITING_[A-Z_]+$/.test(error.message)) throw error;
          throw knowledgeError(error.status === 403 ? 'WRITING_SAVE_PATH_DENIED' : error.code === 'ENOENT' ? 'WRITING_SAVE_TARGET_REQUIRED' : 'WRITING_SAVE_FAILED', error.status || (error.code === 'ENOENT' ? 404 : 500));
        }
      }
      if (req.method !== 'POST' || path !== '/optimize') throw knowledgeError('接口不存在', 404);
      let input; try { input = JSON.parse(await readBody(req)); } catch { throw knowledgeError('请求 JSON 无效'); }
      const workspace = registry.list().find(w => w.id === input.workspaceId);
      if (!workspace || !Object.hasOwn(WRITING_STARTERS, input.docType)) throw knowledgeError('工作区或文档类型无效');
      if (typeof input.content !== 'string' || !input.content.trim()) throw knowledgeError('WRITING_CONTENT_REQUIRED', 400);
      if (hasWritingImages(input.content)) throw knowledgeError('WRITING_INLINE_IMAGES', 400);
      if (input.content.length > 100000) throw knowledgeError('WRITING_CONTENT_TOO_LONG', 413);
      if (typeof input.instruction !== 'string' || input.instruction.length > 4000) throw knowledgeError('WRITING_INSTRUCTION_TOO_LONG', 400);
      if (!Array.isArray(input.scopeIds) || input.scopeIds.some(id => typeof id !== 'string')) throw knowledgeError('知识库选择无效');
      const parentAgent = agents?.get(input.sessionId);
      if (!parentAgent || parentAgent.status === 'stopped') throw knowledgeError('请先选择一个活跃的 DSH 会话');
      const parentCwd = parentAgent.session?.header?.cwd || parentAgent.options?.cwd;
      if (!parentCwd || await realpath(parentCwd).catch(() => null) !== await realpath(workspace.path)) throw knowledgeError('WRITING_SESSION_DENIED', 403);
      const config = await configLoader();
      const docsDir = config.docsDir || 'docs', requirementPath = writingRequirementPath(input.requirementPath);
      if (requirementPath) {
        const docsRoot = resolve(workspace.path, docsDir);
        if (docsRoot !== resolve(workspace.path)) await safeDocumentPath(workspace.path, docsDir);
        const directory = await safeDocumentPath(docsRoot, requirementPath);
        if (!(await stat(directory)).isDirectory()) throw knowledgeError('WRITING_REQUIREMENT_INVALID', 400);
      }
      const contextKey = JSON.stringify([workspace.id, docsDir, requirementPath]);
      if (reservations.has(contextKey) || [...jobs.values()].some(job => job.contextKey === contextKey && ['running', 'cancelling'].includes(job.status))) throw knowledgeError('WRITING_REQUIREMENT_BUSY', 409);
      reservation = contextKey; reservations.add(reservation);
      const provider = ctx.subagents?.getProvider?.(config.ai?.delegation?.provider || 'spawn');
      if (!provider?.capabilities?.toolFilter || provider.inheritsParentContext !== false) throw knowledgeError('写作需要支持工具隔离且不继承父上下文的 spawn provider', 503);
      installation ||= installWritingTools(ctx);
      const origins = knowledge.database().scopes(), selected = [...new Set(input.scopeIds)].map(id => {
        const origin = origins.find(s => s.id === id); if (!origin) throw knowledgeError('所选知识库已不存在，请刷新'); return origin;
      });
      const exact = await resolveKnowledgeReferences(knowledge, input.referenceRefs, req.operationExec?.signal);
      const documents = []; let characters = 0, excludedSourceCount = 0;
      for (const origin of selected) {
        const scope = scopeData(origin); await knowledge.refreshSources(scope);
        const excluded = scope.store.sources().filter(source => source.status !== 'active');
        excludedSourceCount += excluded.length;
        const entries = scope.store.list(10001, undefined, { activeOnly: true });
        if (!entries.length && excluded.length) throw Object.assign(knowledgeError('WRITING_KNOWLEDGE_STALE', 409), { details: { workspaceTitle: origin.workspace_title, sources: excluded.slice(0, 3).map(({ path, status }) => ({ relativePath: path, status })) } });
        for (const entry of entries) {
          characters += entry.body.length;
          if (characters > 20000000 || documents.length >= 10000) throw knowledgeError('所选知识库过大，请减少选择范围', 413);
          documents.push({ ...entry, scopeId: origin.id });
        }
      }
      for (const { doc, origin } of exact) if (!documents.some(item => item.id === doc.id)) {
        characters += doc.body.length;
        if (characters > 20000000 || documents.length >= 10000) throw knowledgeError('ENHANCEMENT_BUDGET_EXCEEDED', 413);
        documents.push(doc);
        if (!selected.some(scope => scope.id === origin.id)) selected.push(origin);
      }
      const scopes = selected.map(s => ({ id: s.id, title: s.workspace_title }));
      if (closed) throw knowledgeError('写作服务已关闭', 503);
      const budget = await resolveSyncBudget({ ctx, llm, parentAgent });
      if (closed) throw knowledgeError('WRITING_CLOSED', 503);
      const runtime = new WritingRuntime(scopes, documents, budget); installation.add(runtime);
      // Keep bounded task history; running tasks are never evicted.
      for (const [id, job] of jobs) if (jobs.size >= 50 && !['running','cancelling'].includes(job.status)) jobs.delete(id);
      const job = { id: randomUUID(), owner: input.sessionId, workspaceId: workspace.id, docType: input.docType, requirementPath, docsDir, contextKey, excludedSourceCount, controller: new AbortController(), status: 'running', createdAt: Date.now(), activity: runtime.activity };
      runtime.onActivity = activity => { job.activity = activity; };
      runtime.signal = job.controller.signal;
      runtime.onFatal = error => job.controller.abort(error);
      jobs.set(job.id, job);
      job.task = (async () => {
        try {
          const result = await runTask(ctx, llm, config, {
            promptKey: 'writing', variables: { runtimeId: runtime.id, docTypeName: WRITING_STARTERS[input.docType].label, content: input.content, instruction: input.instruction.trim() || '结合原文和知识库完善表达、边界与可验证性', scopes: JSON.stringify(scopes) },
            runtime, parentAgent, cwd: workspace.path, signal: job.controller.signal, toolFilter: { allow: WRITING_TOOLS },
            description: `优化${WRITING_STARTERS[input.docType].label}`,
            callbacks: { onProgress: event => {
              if (closed || job.controller.signal.aborted) return;
              if (event.stage === 'executing') { job.sessionId = event.sessionId; runtime.updateActivity({ stage: 'waiting_model', lastRequestAt: Date.now() }); }
              else if (event.stage === 'subagent_starting') runtime.updateActivity({ stage: 'preparing' });
            } },
          });
          job.controller.signal.throwIfAborted();
          if (runtime.failure) throw runtime.failure;
          if (result.isError) throw new Error(result.diagnostic || 'Subagent 优化失败');
          if (!runtime.result) throw new Error('WRITING_RESULT_INCOMPLETE');
          job.activity = { ...runtime.activity, stage: 'validating' };
          await resolveKnowledgeReferences(knowledge, input.referenceRefs, job.controller.signal);
          for (let offset = 0; offset < runtime.result.evidence.length; offset += 30) await resolveKnowledgeReferences(knowledge,
            runtime.result.evidence.slice(offset, offset + 30).map(({ id, scopeId, version }) => ({ id, scopeId, version })), job.controller.signal);
          job.controller.signal.throwIfAborted();
          job.result = { original: input.content, ...runtime.result }; job.sessionId = result.sessionId; job.status = 'completed';
        } catch (error) { job.status = job.controller.signal.aborted && !runtime.failure ? 'cancelled' : 'failed'; job.error = runtime.failure?.message || error.message; job.errorDetails = error.details; }
        finally { installation.close(runtime); }
      })();
      return json(res, publicJob(job), 202);
    } catch (error) { json(res, { error: error.message, ...(error.details ? { details: error.details } : {}) }, error.status || 500); }
    finally { if (reservation) reservations.delete(reservation); }
  };
  const handler = (req, res) => { requests.add(req); const task = dispatch(req, res).finally(() => { pending.delete(task); requests.delete(req); }); pending.add(task); return task; };
  return { routes: [{ kind: 'prefix', path: '/req-hub/writing', handler }], async dispose() { closed = true; for (const job of jobs.values()) job.controller.abort(); for (const req of requests) if (req.method === 'POST' && !req.readableEnded) req.destroy(new Error('WRITING_CLOSED')); await Promise.allSettled([...pending]); await Promise.allSettled([...jobs.values()].map(j => j.task)); await installation?.dispose(); } };
}
