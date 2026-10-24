import { json, readBody } from '../utils.js';
import { codexError } from '../codex-sessions/source.js';

export function createCodexSessionRoutes(registry, service) {
  return ['workspaces', 'sessions', 'refresh'].map(action => ({
    kind: 'exact', path: '/req-hub/codex/' + action,
    async handler(req, res) {
      if (req.method !== (action === 'refresh' ? 'POST' : 'GET')) return json(res, { error: 'method not allowed' }, 405);
      let streaming = false;
      const send = event => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
      try {
        let input;
        if (req.method === 'POST') {
          try { input = JSON.parse(await readBody(req)); } catch { throw codexError('请求 JSON 无效'); }
        } else input = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        if (!registry.list().some(workspace => workspace.id === input.workspaceId)) throw codexError('工作区不存在', 404);
        if (input.codexWorkspaceId !== undefined && typeof input.codexWorkspaceId !== 'string') throw codexError('Codex 工作区标识无效');
        if (action === 'refresh' && input.stream === true) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
          streaming = true;
          res.flushHeaders?.();
          const result = await service.refresh(input.workspaceId, input.codexWorkspaceId, progress => send({ type: 'progress', ...progress }));
          send({ type: 'result', result });
          return res.end();
        }
        const result = action === 'workspaces' ? await service.workspaces() : action === 'sessions' ? await service.list(input.workspaceId) : await service.refresh(input.workspaceId, input.codexWorkspaceId);
        json(res, result);
      } catch (error) {
        if (streaming) { send({ type: 'error', error: error.message }); res.end(); }
        else json(res, { error: error.message }, error.statusCode || 500);
      }
    },
  }));
}
