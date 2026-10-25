import { KnowledgeService } from '../knowledge/build-service.js';
import { loadConfig } from '../config.js';
import { json, readBody } from '../utils.js';
import { knowledgeError, normalizeSourcePath } from '../knowledge/source-reader.js';

/** One prefix route, lifecycle-owned by the plugin; old search/analyze routes stay compatible. */
export function createKnowledgeRoutes(registry, options = {}) {
  const service = new KnowledgeService({ registry, configLoader: options.configLoader || loadConfig, readSourceFile: options.readSourceFile, databasePath: options.databasePath });
  const streams = new Set();
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.slice('/req-hub/knowledge'.length);
      let body = {};
      if (req.method === 'POST') {
        try { body = JSON.parse(await readBody(req)); } catch { throw knowledgeError('请求 JSON 无效'); }
      }
      const workspaceId = req.method === 'POST' ? body.workspaceId : url.searchParams.get('workspaceId');
      // Search is global even when an older client includes workspaceId.
      if (req.method === 'GET' && ['/search', '/search/status'].includes(path)) {
        const result = await service.searchAll(path === '/search' ? url.searchParams.get('q') || '' : '', url.searchParams.get('limit'));
        return json(res, path === '/search' ? result : { ready: result.knowledgeReady, warnings: result.warnings });
      }
      if (!workspaceId) throw knowledgeError('缺少 workspaceId');
      const scope = await service.scope(workspaceId);
      if (req.method === 'GET' && path === '/source') {
        const relativePath = normalizeSourcePath(url.searchParams.get('path'));
        await service.refreshSources(scope, relativePath);
        const source = scope.store.source(relativePath);
        return json(res, { relativePath, indexed: !!source, status: source?.status || 'not_imported' });
      }
      if (req.method === 'POST' && path === '/builds') {
        const { job, duplicate } = await service.build(scope, body);
        return json(res, { ...job, jobId: job.id }, duplicate ? 200 : 202);
      }
      if (req.method === 'GET' && ['/status', '/entries'].includes(path)) {
        await service.refreshSources(scope);
        if (path === '/status') return json(res, scope.store.status());
        return json(res, { entries: scope.store.list(100, url.searchParams.get('type')) });
      }
      const entry = path.match(/^\/entries\/([^/]+)$/);
      if (entry && req.method === 'GET') {
        await service.refreshSources(scope);
        const result = scope.store.entry(entry[1]);
        if (!result) throw knowledgeError('知识条目不存在', 404);
        return json(res, result);
      }
      const build = path.match(/^\/builds\/([^/]+)(?:\/(events|cancel))?$/);
      if (build) {
        const job = scope.store.job(build[1]);
        if (!job) throw knowledgeError('任务不存在', 404);
        if (req.method === 'POST' && build[2] === 'cancel') return json(res, service.cancel(scope, job.id));
        if (req.method === 'GET' && !build[2]) return json(res, job);
        if (req.method === 'GET' && build[2] === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          let seq = Number(url.searchParams.get('afterSeq')) || 0;
          let timer;
          const close = () => { clearInterval(timer); streams.delete(close); if (!res.writableEnded) res.end(); };
          const send = () => {
            const current = scope.store.job(job.id);
            if (current.seq > seq) { seq = current.seq; res.write(`id: ${seq}\ndata: ${JSON.stringify({ type: 'task', ...current })}\n\n`); }
            if (!['queued', 'running', 'cancelling'].includes(current.status)) close();
            else res.write(': heartbeat\n\n');
          };
          streams.add(close); res.on('close', close); timer = setInterval(send, 1000); timer.unref?.(); send(); return;
        }
      }
      throw knowledgeError('接口或请求方法不存在', 404);
    } catch (error) { if (!res.headersSent) json(res, { error: error.message }, error.status || 500); else res.end(); }
  };
  return { routes: [{ kind: 'prefix', path: '/req-hub/knowledge', handler }], service, dispose: async () => { for (const close of [...streams]) close(); await service.close(); } };
}
