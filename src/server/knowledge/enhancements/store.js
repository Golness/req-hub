import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACTIVE, bounded, digest, fail } from './contracts.js';
const owners = new Set();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

/** Plugin-owned derived state only; the knowledge database and original files are never reset here. */
export class EnhancementStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); this.owner = randomUUID(); owners.add(this.owner);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
      // No migrations: reject unknown files rather than risking deletion of a misconfigured database.
      if (![0, 1].includes(version)) fail('ENHANCEMENT_STORAGE_VERSION', 503);
      this.db.exec(`CREATE TABLE IF NOT EXISTS enhancement_scopes(id TEXT PRIMARY KEY, review_seq INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS enhancement_jobs(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES enhancement_scopes(id),kind TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(scope_id,kind,request_key));
        CREATE TABLE IF NOT EXISTS graph_revisions(scope_id TEXT NOT NULL REFERENCES enhancement_scopes(id),id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope_id,id));
        CREATE TABLE IF NOT EXISTS graph_current(scope_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,FOREIGN KEY(scope_id,revision_id) REFERENCES graph_revisions(scope_id,id));
        CREATE TABLE IF NOT EXISTS graph_decisions(scope_id TEXT NOT NULL REFERENCES enhancement_scopes(id),relation_key TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope_id,relation_key,version));
        PRAGMA user_version=1;`);
      for (const row of this.db.prepare("SELECT id,payload FROM enhancement_jobs WHERE json_extract(payload,'$.status') IN ('queued','preparing','running','cancelling')").all()) {
        const job = JSON.parse(row.payload);
        const orphan = job.processId === process.pid ? !owners.has(job.owner) : !job.processId || !alive(job.processId);
        if (ACTIVE.has(job.status) && orphan) { job.status = 'interrupted'; job.error = { code: 'ENHANCEMENT_INTERRUPTED' }; this.saveJob(job); }
      }
    } catch (error) { this.db.close(); owners.delete(this.owner); throw error; }
  }
  scope(id) { this.db.prepare('INSERT OR IGNORE INTO enhancement_scopes(id) VALUES(?)').run(id); }
  transaction(callback) {
    if (this.inTransaction) return callback();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  seq(scope) { return Number(this.db.prepare('SELECT review_seq FROM enhancement_scopes WHERE id=?').get(scope)?.review_seq || 0); }
  saveJob(job) {
    this.scope(job.scopeId); job.seq = (job.seq || 0) + 1; job.updatedAt = new Date().toISOString();
    job.owner ||= this.owner; job.processId ||= process.pid;
    bounded(job, 4_000_000);
    this.db.prepare('INSERT INTO enhancement_jobs VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id, job.scopeId, job.kind || 'unknown', job.requestKey, job.fingerprint, JSON.stringify(job));
  }
  job(scope, id) { const row = this.db.prepare('SELECT payload FROM enhancement_jobs WHERE scope_id=? AND id=?').get(scope, id); return row ? JSON.parse(row.payload) : null; }
  request(scope, key, kind) { const row = this.db.prepare('SELECT payload FROM enhancement_jobs WHERE scope_id=? AND request_key=? AND kind=?').get(scope, key, kind); return row ? JSON.parse(row.payload) : null; }
  jobs(scope, limit = 50) { return this.db.prepare('SELECT payload FROM enhancement_jobs WHERE scope_id=? ORDER BY rowid DESC LIMIT ?').all(scope, limit).map(row => JSON.parse(row.payload)); }
  summaries(scope, limit = 20) { return this.db.prepare("SELECT json_remove(payload,'$.result','$.manifest') AS payload FROM enhancement_jobs WHERE scope_id=? ORDER BY rowid DESC LIMIT ?").all(scope, limit).map(row => JSON.parse(row.payload)); }
  hasActive(scope) { return !!this.db.prepare("SELECT 1 FROM enhancement_jobs WHERE scope_id=? AND json_extract(payload,'$.status') IN ('queued','preparing','running','cancelling') LIMIT 1").get(scope); }
  current(scope) { const row = this.db.prepare('SELECT r.payload FROM graph_current c JOIN graph_revisions r ON r.scope_id=c.scope_id AND r.id=c.revision_id WHERE c.scope_id=?').get(scope); return row ? JSON.parse(row.payload) : null; }
  decision(scope, key) { const row = this.db.prepare('SELECT payload FROM graph_decisions WHERE scope_id=? AND relation_key=? ORDER BY version DESC LIMIT 1').get(scope, key); return row ? JSON.parse(row.payload) : null; }
  project(scope, graph) {
    for (const relation of graph.relations) {
      const decision = this.decision(scope, relation.key);
      relation.reviewState = decision ? (decision.basisHash === relation.basisHash ? decision.decision : 'needs_review') : 'candidate';
      relation.reviewVersion = decision?.version || 0;
    }
    graph.reviewSeq = this.seq(scope); return graph;
  }
  publish(scope, graph, settings) {
    this.transaction(() => {
      const keys = JSON.stringify(graph.entities.map(entity => entity.key));
      const manual = this.db.prepare(`SELECT d.payload FROM graph_decisions d WHERE d.scope_id=? AND d.version=(SELECT MAX(v.version) FROM graph_decisions v WHERE v.scope_id=d.scope_id AND v.relation_key=d.relation_key) AND json_extract(d.payload,'$.manual.sourceKey') IN (SELECT value FROM json_each(?)) AND json_extract(d.payload,'$.manual.targetKey') IN (SELECT value FROM json_each(?)) LIMIT ?`).all(scope, keys, keys, settings.maxEdges + 1);
      if (manual.length > settings.maxEdges) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
      const seen = new Set();
      for (const row of manual) {
        const decision = JSON.parse(row.payload); if (!decision.manual) continue;
        const { sourceKey, targetKey, note } = decision.manual;
        const key = digest([scope, sourceKey, targetKey, 'manual_dependency']); if (seen.has(key)) continue; seen.add(key);
        if (graph.relations.some(item => item.key === key)) continue;
        const source = graph.entities.find(item => item.key === sourceKey), target = graph.entities.find(item => item.key === targetKey);
        if (source && target) graph.relations.push({ id: key, key, sourceId: source.id, targetId: target.id, type: 'manual_dependency', validity: 'valid', reviewState: 'candidate', basisHash: digest([source.documents, target.documents, note]), evidence: [{ note, actor: decision.actor }] });
        if (graph.relations.length > settings.maxEdges) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
      }
      this.project(scope, graph);
      bounded(graph, settings.maxResultBytes);
      this.db.prepare('INSERT INTO graph_revisions VALUES(?,?,?)').run(scope, graph.id, JSON.stringify(graph));
      this.db.prepare('INSERT INTO graph_current VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET revision_id=excluded.revision_id').run(scope, graph.id);
      const old = this.db.prepare('SELECT id FROM graph_revisions WHERE scope_id=? ORDER BY rowid DESC').all(scope).slice(settings.retainedRevisions);
      for (const row of old) this.db.prepare('DELETE FROM graph_revisions WHERE scope_id=? AND id=?').run(scope, row.id);
    });
    return graph;
  }
  review(scope, input, actor) {
    return this.transaction(() => {
      const graph = this.current(scope);
      if (!graph || graph.id !== input.expectedRevision || graph.reviewSeq !== input.expectedReviewSeq) fail('ENHANCEMENT_REVIEW_CONFLICT', 409);
      if (input.sourceId !== undefined) {
        const source = graph.entities.find(item => item.id === input.sourceId), target = graph.entities.find(item => item.id === input.targetId);
        if (!source || !target || source.id === target.id || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 1000) fail('ENHANCEMENT_REFERENCE_INVALID', 422);
        const key = digest([scope, source.key, target.key, 'manual_dependency']);
        if (graph.relations.some(relation => relation.key === key)) fail('ENHANCEMENT_REVIEW_CONFLICT', 409);
        const relation = { id: key, key, sourceId: source.id, targetId: target.id, type: 'manual_dependency', validity: 'valid', reviewState: 'candidate',
          basisHash: digest([source.documents, target.documents, input.note]), evidence: [{ note: input.note, actor }], reviewVersion: 0 };
        graph.relations.push(relation);
        // Preserve the manual relation outside the rebuildable revision.
        this.db.prepare('INSERT INTO graph_decisions VALUES(?,?,?,?)').run(scope, key, 1, JSON.stringify({ version: 1, decision: 'needs_review', basisHash: relation.basisHash, manual: { sourceKey: source.key, targetKey: target.key, note: input.note }, actor }));
        this.db.prepare('UPDATE enhancement_scopes SET review_seq=review_seq+1 WHERE id=?').run(scope);
        this.project(scope, graph);
        this.db.prepare('UPDATE graph_revisions SET payload=? WHERE scope_id=? AND id=?').run(JSON.stringify(graph), scope, graph.id);
        return graph;
      }
      const relation = graph.relations.find(item => item.id === input.resultId);
      if (!relation || relation.basisHash !== input.basisHash) fail('ENHANCEMENT_REFERENCE_INVALID', 422);
      if (!['confirmed', 'rejected', 'needs_review'].includes(input.decision)) fail('ENHANCEMENT_INVALID_INPUT');
      const version = (this.decision(scope, relation.key)?.version || 0) + 1;
      const previous = this.decision(scope, relation.key);
      const record = { version, decision: input.decision, basisHash: relation.basisHash, ...(previous?.manual ? { manual: previous.manual } : {}), actor, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO graph_decisions VALUES(?,?,?,?)').run(scope, relation.key, version, JSON.stringify(record));
      this.db.prepare('UPDATE enhancement_scopes SET review_seq=review_seq+1 WHERE id=?').run(scope);
      this.project(scope, graph);
      this.db.prepare('UPDATE graph_revisions SET payload=? WHERE scope_id=? AND id=?').run(JSON.stringify(graph), scope, graph.id);
      return graph;
    });
  }
  retain(scope, max) {
    const rows = this.db.prepare("SELECT id,json_extract(payload,'$.status') AS status FROM enhancement_jobs WHERE scope_id=? ORDER BY rowid DESC LIMIT -1 OFFSET ?").all(scope, max);
    for (const row of rows) if (!ACTIVE.has(row.status)) this.db.prepare('DELETE FROM enhancement_jobs WHERE id=? AND scope_id=?').run(row.id, scope);
  }
  close() { owners.delete(this.owner); this.db.close(); }
}
