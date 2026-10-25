import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { executeTask } from '../task-executor.js';
import { json, readBody } from '../utils.js';
import { knowledgeError } from '../knowledge/source-reader.js';
import { installWritingTools, WritingRuntime, WRITING_TOOLS } from '../writing-runtime.js';

export const WRITING_STARTERS = {
  requirement: { label: '需求文档', content: '# 需求文档\n\n## 背景与目标\n\n## 用户与场景\n\n## 功能与业务规则\n\n## 异常与边界\n\n## 验收标准\n' },
  design: { label: '技术方案', content: '# 技术方案\n\n## 背景与目标\n\n## 现状与约束\n\n## 方案设计\n\n## 接口与数据设计\n\n## 风险与兼容性\n\n## 验证与发布\n' },
};

export function createWritingRoutes(registry, llm, agents, ctx, knowledge, options = {}) {
  const jobs = new Map(); let installation; let closed = false;
  const configLoader = options.configLoader || loadConfig, runTask = options.executeTask || executeTask;
  function scopeData(origin) {
    const store = knowledge.database().scoped(origin.id, { id: origin.workspace_id, title: origin.workspace_title }, origin.workspace_root, origin.docs_root);
    return { identity: origin.id, docsRoot: origin.docs_root, store };
  }
  const catalog = () => knowledge.database().scopes().map(origin => ({ id: origin.id, workspaceId: origin.workspace_id, title: origin.workspace_title, docsRoot: origin.docs_root, ...scopeData(origin).store.status() }));
  const publicJob = job => ({ id: job.id, status: job.status, sessionId: job.sessionId, error: job.error, result: job.result });
  const handler = async (req, res) => {
    try {
      if (closed) throw knowledgeError('写作服务已关闭', 503);
      const url = new URL(req.url, 'http://localhost'), path = url.pathname.slice('/req-hub/writing'.length);
      if (req.method === 'GET' && path === '/options') return json(res, { scopes: catalog(), starters: WRITING_STARTERS });
      const match = path.match(/^\/jobs\/([^/]+)(\/cancel)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) throw knowledgeError('优化任务不存在，请重新优化', 404);
        if (req.method === 'POST' && match[2]) { job.controller.abort(); if (job.status === 'running') job.status = 'cancelled'; return json(res, publicJob(job)); }
        if (req.method === 'GET' && !match[2]) return json(res, publicJob(job));
      }
      if (req.method !== 'POST' || path !== '/optimize') throw knowledgeError('接口不存在', 404);
      let input; try { input = JSON.parse(await readBody(req)); } catch { throw knowledgeError('请求 JSON 无效'); }
      const workspace = registry.list().find(w => w.id === input.workspaceId);
      if (!workspace || !Object.hasOwn(WRITING_STARTERS, input.docType)) throw knowledgeError('工作区或文档类型无效');
      if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 100000 || typeof input.instruction !== 'string' || input.instruction.length > 4000) throw knowledgeError('请输入正文（最多十万字）和有效优化要求');
      if (!Array.isArray(input.scopeIds) || input.scopeIds.some(id => typeof id !== 'string')) throw knowledgeError('知识库选择无效');
      const parentAgent = agents?.get(input.sessionId);
      if (!parentAgent || parentAgent.status === 'stopped') throw knowledgeError('请先选择一个活跃的 DSH 会话');
      if ([...jobs.values()].some(j => j.owner === input.sessionId && j.status === 'running')) throw knowledgeError('当前会话已有优化任务', 409);
      const config = await configLoader();
      const provider = ctx.subagents?.getProvider?.(config.ai?.delegation?.provider || 'spawn');
      if (!provider?.capabilities?.toolFilter || provider.inheritsParentContext !== false) throw knowledgeError('写作需要支持工具隔离且不继承父上下文的 spawn provider', 503);
      installation ||= installWritingTools(ctx);
      const origins = knowledge.database().scopes(), selected = [...new Set(input.scopeIds)].map(id => {
        const origin = origins.find(s => s.id === id); if (!origin) throw knowledgeError('所选知识库已不存在，请刷新'); return origin;
      });
      const documents = []; let characters = 0;
      for (const origin of selected) {
        const scope = scopeData(origin); await knowledge.refreshSources(scope);
        for (const entry of scope.store.list(10001)) {
          characters += entry.body.length;
          if (characters > 20000000 || documents.length >= 10000) throw knowledgeError('所选知识库过大，请减少选择范围', 413);
          documents.push({ ...entry, scopeId: origin.id });
        }
      }
      const scopes = selected.map(s => ({ id: s.id, title: s.workspace_title }));
      if (closed) throw knowledgeError('写作服务已关闭', 503);
      const runtime = new WritingRuntime(scopes, documents); installation.add(runtime);
      // Keep bounded task history; running tasks are never evicted.
      for (const [id, job] of jobs) if (jobs.size >= 50 && job.status !== 'running') jobs.delete(id);
      const job = { id: randomUUID(), owner: input.sessionId, controller: new AbortController(), status: 'running' };
      jobs.set(job.id, job);
      job.task = (async () => {
        try {
          const result = await runTask(ctx, llm, config, {
            promptKey: 'writing', variables: { runtimeId: runtime.id, docTypeName: WRITING_STARTERS[input.docType].label, content: input.content, instruction: input.instruction.trim() || '结合原文和知识库完善表达、边界与可验证性', scopes: JSON.stringify(scopes) },
            runtime, parentAgent, cwd: workspace.path, signal: job.controller.signal, toolFilter: { allow: WRITING_TOOLS },
            description: `优化${WRITING_STARTERS[input.docType].label}`,
          });
          job.controller.signal.throwIfAborted();
          if (result.isError) throw new Error(result.diagnostic || 'Subagent 优化失败');
          if (!runtime.result) throw new Error('Subagent 未提交候选文档或未完成知识库读取');
          job.result = { original: input.content, ...runtime.result }; job.sessionId = result.sessionId; job.status = 'completed';
        } catch (error) { job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; }
        finally { installation.close(runtime); }
      })();
      return json(res, publicJob(job), 202);
    } catch (error) { json(res, { error: error.message }, error.status || 500); }
  };
  return { routes: [{ kind: 'prefix', path: '/req-hub/writing', handler }], async dispose() { closed = true; for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...jobs.values()].map(j => j.task)); installation?.dispose(); } };
}
