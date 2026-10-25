import { randomUUID } from 'node:crypto';
import { ConversationStore, conversationError } from './store.js';

/** Both providers share import, version, projection and task lifecycle. */
export class ConversationService {
  constructor({ store = new ConversationStore(), owner = 'standalone' } = {}) {
    this.store = store; this.owner = owner; this.queue = Promise.resolve(); this.controllers = new Map(); this.closed = false;
  }
  ready() {
    return this.initializing ||= (async () => {
      const db = await this.store.database();
      db.prepare("UPDATE jobs SET payload=json_set(payload,'$.status','interrupted') WHERE json_extract(payload,'$.owner')=? AND json_extract(payload,'$.status') IN ('queued','running','cancelling')").run(this.owner);
    })();
  }
  async list(workspace, adapter) {
    await this.ready();
    const binding = await this.store.binding(this.owner, workspace, adapter.source);
    if (!binding || binding.instance !== adapter.instance) return { workspace: null, sessions: [] };
    return { workspace: JSON.parse(binding.payload), sessions: (await this.store.list(binding.id)).filter(item => item.sourceStatus !== 'missing'), refreshedAt: JSON.parse(binding.payload).refreshedAt || null };
  }
  refresh(workspace, project, adapter, onProgress = () => {}) {
    if (this.closed) return Promise.reject(conversationError('SESSION_SERVICE_CLOSED', 503));
    onProgress({ phase: 'queued', completed: 0, total: null });
    const controller = new AbortController(); this.controllers.set(controller, workspace);
    const job = { id: randomUUID(), owner: this.owner, workspaceId: workspace, scope: '', source: adapter.source, status: 'queued', completed: 0, total: null, warnings: [] };
    let db;
    const save = () => db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,payload=excluded.payload').run(job.id, job.scope, JSON.stringify({ ...job, updatedAt: new Date().toISOString() }));
    const scheduled = this.ready().then(async () => { db = await this.store.database(); save(); });
    const pending = this.queue.then(async () => {
      await scheduled; let importedCount = 0;
      try {
        controller.signal.throwIfAborted(); job.status = 'running'; save();
        onProgress({ phase: 'inventory', completed: 0, total: null });
        project ||= (await this.store.binding(this.owner, workspace, adapter.source))?.project;
        const inventory = await adapter.inventory(project);
        const origin = inventory.workspaces.find(item => item.id === project);
        if (!origin) throw conversationError('SESSION_WORKSPACE_MISSING', 404);
        const scope = await this.store.scope(adapter.source, adapter.instance, origin);
        const warnings = job.warnings = [...inventory.warnings];
        const sessions = inventory.sessions.filter(item => item.workspaceId === origin.id);
        job.scope = scope; job.total = sessions.length; save();
        onProgress({ phase: 'importing', completed: 0, total: sessions.length });
        for (const session of sessions) {
          controller.signal.throwIfAborted();
          const details = { ...session, source: adapter.source, isPersisted: true, importedAt: new Date().toISOString() };
          delete details.sourcePath; delete details.nativeId;
          try {
            const snapshot = await adapter.snapshot(session);
            controller.signal.throwIfAborted();
            await this.store.put(scope, details, snapshot); importedCount++;
          } catch (error) {
            controller.signal.throwIfAborted(); warnings.push(`${session.title}: ${error.message}`);
            await this.store.put(scope, { ...details, snapshotError: error.message }, null);
          }
          job.completed++; save(); onProgress({ phase: 'importing', completed: job.completed, total: job.total });
        }
        controller.signal.throwIfAborted();
        onProgress({ phase: 'saving', completed: job.completed, total: job.total });
        await this.store.finish(scope, sessions.map(item => item.id));
        await this.store.scope(adapter.source, adapter.instance, { ...origin, refreshedAt: new Date().toISOString() });
        await this.store.bind(this.owner, workspace, adapter.source, scope);
        job.status = 'completed'; save();
        return { ...await this.list(workspace, adapter), warnings, importedCount, jobId: job.id };
      } catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = error.message; save(); throw error; }
    });
    this.queue = pending.catch(() => {}).finally(() => this.controllers.delete(controller));
    return pending;
  }
  async snapshots(workspace, ids, adapter) {
    if (!ids.length) return [];
    const binding = await this.store.binding(this.owner, workspace, adapter.source);
    if (!binding || binding.instance !== adapter.instance) throw conversationError('SESSION_WORKSPACE_MISSING');
    const inventory = await adapter.inventory(binding.project);
    const results = await Promise.allSettled(ids.map(id => this.snapshot(workspace, id, adapter, inventory)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return results.map(result => result.value);
  }
  async snapshot(workspace, id, adapter, inventory) {
    const binding = await this.store.binding(this.owner, workspace, adapter.source);
    if (!binding || binding.instance !== adapter.instance) throw conversationError('SESSION_WORKSPACE_MISSING');
    const row = await this.store.find(binding.id, id);
    if (!row?.version || row.status !== 'active') throw conversationError(adapter.source === 'codex' ? 'CODEX_SESSION_MISSING' : 'SESSION_MISSING');
    inventory ||= await adapter.inventory(binding.project);
    const source = inventory.sessions.find(item => item.id === id && item.workspaceId === binding.project);
    if (!source) throw conversationError(adapter.source === 'codex' ? 'CODEX_SESSION_ARCHIVED' : 'SESSION_ARCHIVED');
    const fresh = await adapter.snapshot(source);
    if (fresh.version !== row.version) throw conversationError('SESSION_CHANGED');
    return { ...await this.store.project(row.id, row.version), conversationId: row.id };
  }
  async accessible(workspace, adapters) {
    await this.ready();
    const result = [], scopes = new Set();
    const db = await this.store.database();
    for (const adapter of adapters) {
      const binding = await this.store.binding(this.owner, workspace, adapter.source);
      if (binding?.instance === adapter.instance) scopes.add(binding.id);
      for (const row of db.prepare("SELECT s.* FROM jobs j JOIN scopes s ON s.id=j.scope WHERE json_extract(j.payload,'$.owner')=? AND json_extract(j.payload,'$.workspaceId')=? AND s.source=? AND s.instance=?").all(this.owner, workspace, adapter.source, adapter.instance)) scopes.add(row.id);
    }
    for (const scope of scopes) {
      const origin = db.prepare('SELECT * FROM scopes WHERE id=?').get(scope);
      result.push(...(await this.store.list(scope)).map(item => ({ ...item, scopeId: scope, workspaceTitle: JSON.parse(origin.payload).title || origin.project })));
    }
    return result;
  }
  cancel(workspace) { for (const [controller, owner] of this.controllers) if (owner === workspace) controller.abort(conversationError('SESSION_REFRESH_CANCELLED')); }
  async close() { this.closed = true; for (const controller of this.controllers.keys()) controller.abort(conversationError('SESSION_SERVICE_CLOSED')); await this.queue; }
}
