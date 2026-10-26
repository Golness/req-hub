import { json, readBody } from '../utils.js';
import { conversationError } from '../conversations/store.js';

export function createConversationRoutes(registry, library, adapters) {
  return ['list', 'detail', 'delete', 'cancel', 'refresh', 'jobs', 'storage', 'cleanup'].map(action => ({
    kind: 'exact', path: '/req-hub/conversations-' + action,
    async handler(req, res) {
      if (req.method !== (['list', 'detail', 'jobs', 'storage'].includes(action) ? 'GET' : 'POST')) return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
      let streaming = false;
      const send = event => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
      try {
        const input = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams) : JSON.parse(await readBody(req));
        if (!registry.list().some(workspace => workspace.id === input.workspaceId)) throw conversationError('WORKSPACE_MISSING', 404);
        if (action === 'cancel') { library.cancel(input.workspaceId); return json(res, { success: true }); }
        if (action === 'refresh') {
          const adapter = adapters.find(item => item.source === input.source);
          if (!adapter) throw conversationError('SESSION_SOURCE_INVALID', 400);
          if (input.stream === true) {
            res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
            streaming = true; res.flushHeaders?.();
            const result = await library.refresh(input.workspaceId, input.source === 'dsh' ? input.workspaceId : input.projectId, adapter, progress => send({ type: 'progress', ...progress }));
            send({ type: 'result', result }); return res.end();
          }
          return json(res, await library.refresh(input.workspaceId, input.source === 'dsh' ? input.workspaceId : input.projectId, adapter));
        }
        if (action === 'storage' || action === 'cleanup') return json(res, {success:true,...await library.storage(input.workspaceId,adapters,action === 'cleanup')});
        const rows = await library.accessible(input.workspaceId, adapters);
        if (action === 'list') {await library.storage(input.workspaceId,adapters,true);return json(res, { sessions:await library.accessible(input.workspaceId,adapters) });}
        if (action === 'jobs') {
          const scopes = new Set(rows.map(row => row.scopeId));
          for (const adapter of adapters) { const bound = await library.store.binding(library.owner, input.workspaceId, adapter.source); if (bound && bound.instance === adapter.instance) scopes.add(bound.id); }
          const db = await library.store.database();
          return json(res, { jobs: db.prepare('SELECT scope,payload FROM jobs ORDER BY rowid DESC').all().map(row => ({ ...JSON.parse(row.payload), scope: row.scope })).filter(job => job.owner === library.owner && job.workspaceId === input.workspaceId && (!job.scope || scopes.has(job.scope))).slice(0, 100) });
        }
        const entry = rows.find(row => row.conversationId === input.id);
        if (!entry) throw conversationError('SESSION_MISSING', 404);
        if (action === 'delete') { await library.store.remove(input.id, input.version); return json(res, { success: true }); }
        const versions = await library.store.versions(input.id);
        const version = input.version || entry.snapshotVersion || versions[0]?.version;
        if (!versions.some(row => row.version === version)) throw conversationError('SESSION_SNAPSHOT_MISSING', 404);
        const snapshot = await library.store.project(input.id, version);
        const references = (await library.store.database()).prepare('SELECT task,version FROM refs WHERE conversation=? AND version=?').all(input.id, version).map(row => {
          let identity; try { identity = JSON.parse(row.task); } catch { /* Standalone callers may use opaque task IDs. */ }
          return { id: row.task, version: row.version, requirementId: Array.isArray(identity) ? identity[1] : row.task };
        });
        return json(res, { entry, versions, snapshot, references });
      } catch (error) {
        if (streaming) { send({ type: 'error', error: error.message }); res.end(); }
        else json(res, { error: error.message }, error.statusCode || error.status || 500);
      }
    },
  }));
}
