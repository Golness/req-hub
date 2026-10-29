import { EnhancementService } from '../knowledge/enhancements/service.js';
import { integer, publicError, fail } from '../knowledge/enhancements/contracts.js';
import { json, readBody } from '../utils.js';
import { loadConfig } from '../config.js';

export function createEnhancementRoutes(knowledge, ctx, options = {}) {
  const service = new EnhancementService({ knowledge, ctx, configLoader: options.configLoader || loadConfig, runTask: options.runTask });
  let closing = false; const pending = new Set(), requests = new Set();
  const dispatch = async (req, res) => {
    try {
      if (closing) fail('ENHANCEMENT_CLOSED', 503);
      const url = new URL(req.url, 'http://localhost');
      let body = {};
      if (req.method === 'POST') { try { body = JSON.parse(await readBody(req)); } catch { fail('ENHANCEMENT_INVALID_INPUT'); } }
      const input = req.method === 'POST' ? body : Object.fromEntries(url.searchParams);
      if (typeof input.workspaceId !== 'string' || !input.workspaceId) fail('ENHANCEMENT_INVALID_INPUT');
      const scope = await knowledge.scope(input.workspaceId);
      const path = url.pathname.slice('/req-hub/knowledge/'.length);
      if (path === 'enhancements/context' && req.method === 'GET') return json(res, await service.context(scope, input));
      if (path === 'enhancements/jobs' && req.method === 'GET') return json(res, input.recommendQuery !== undefined ? await service.recommend(scope, input) : await service.catalog(scope, input, req.operationExec?.agent?.session?.id || req.headers['x-session-id']));
      if (path === 'enhancements/jobs' && req.method === 'POST') return json(res, await service.start(scope, input, req.operationExec?.agent?.session?.id || req.headers['x-session-id']), 202);
      const job = path.match(/^enhancements\/jobs\/([a-zA-Z0-9-]+)(\/cancel)?$/);
      if (job) {
        if (req.method === 'POST' && job[2]) return json(res, service.cancel(scope, job[1]));
        if (req.method === 'GET' && !job[2]) { const result = service.database().job(scope.identity, job[1]); if (!result) fail('ENHANCEMENT_NOT_FOUND', 404); return json(res, result); }
      }
      if (path === 'enhancements/reviews' && req.method === 'POST') return json(res, await service.review(scope, input, { sessionId: req.headers['x-session-id'] || null, origin: 'authenticated-operation' }));
      if (req.method === 'GET' && path === 'graph/impact') return json(res, await service.impact(scope, input));
      if (req.method === 'GET' && ['graph/entities', 'graph/relations'].includes(path)) {
        const graph = await service.graph(scope, input);
        const limit = integer(input.limit, 50, 200), offset = input.cursor ? Number(input.cursor) : 0;
        if (offset > 0 && (!input.revision || input.reviewSeq === undefined)) fail('ENHANCEMENT_REVIEW_CONFLICT', 409);
        if (!Number.isSafeInteger(offset) || offset < 0) fail('ENHANCEMENT_INVALID_INPUT');
        let items = path.endsWith('entities') ? graph?.entities || [] : graph?.relations || [];
        if (input.entityId) items = items.filter(item => item.sourceId === input.entityId || item.targetId === input.entityId);
        if (input.reviewState) items = items.filter(item => item.reviewState === input.reviewState);
        if (input.validity) items = items.filter(item => item.validity === input.validity);
        return json(res, { revision: graph?.id, reviewSeq: graph?.reviewSeq, stale: graph?.stale, code: graph?.code, items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null });
      }
      fail('ENHANCEMENT_NOT_FOUND', 404);
    } catch (error) { json(res, { error: publicError(error).code, details: error.details || {} }, error.status || 500); }
  };
  const handler = (req, res) => {
    requests.add(req);
    const task = dispatch(req, res).finally(() => { pending.delete(task); requests.delete(req); });
    pending.add(task); return task;
  };
  return { service, routes: [{ kind: 'prefix', path: '/req-hub/knowledge/enhancements', handler }, { kind: 'prefix', path: '/req-hub/knowledge/graph', handler }], async dispose() { closing = true; service.beginClose(); for (const req of requests) if (req.method === 'POST' && !req.readableEnded) req.destroy(new Error('ENHANCEMENT_CLOSED')); await Promise.allSettled([...pending]); await service.close(); } };
}
