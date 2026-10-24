import { json, readBody } from '../utils.js';
import { codexError } from '../codex-sessions/source.js';

export function createCodexSessionRoutes(registry, service) {
  return ['workspaces', 'sessions', 'refresh'].map(action => ({
    kind: 'exact', path: '/req-hub/codex/' + action,
    async handler(req, res) {
      if (req.method !== (action === 'refresh' ? 'POST' : 'GET')) return json(res, { error: 'method not allowed' }, 405);
      try {
        let input;
        if (req.method === 'POST') {
          try { input = JSON.parse(await readBody(req)); } catch { throw codexError('请求 JSON 无效'); }
        } else input = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        if (!registry.list().some(workspace => workspace.id === input.workspaceId)) throw codexError('工作区不存在', 404);
        if (input.codexWorkspaceId !== undefined && typeof input.codexWorkspaceId !== 'string') throw codexError('Codex 工作区标识无效');
        const result = action === 'workspaces' ? await service.workspaces() : action === 'sessions' ? await service.list(input.workspaceId) : await service.refresh(input.workspaceId, input.codexWorkspaceId);
        json(res, result);
      } catch (error) { json(res, { error: error.message }, error.statusCode || 500); }
    },
  }));
}
