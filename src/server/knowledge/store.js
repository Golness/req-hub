/** Document-oriented SQLite/FTS storage; retrieval adapted from dsh-knowledge (MIT). See NOTICE.md. */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, posix, join } from 'node:path';
import { writeKnowledgeDocument } from './document-files.js';
import { knowledgeError } from './source-reader.js';
import { fallbackTerms, toFtsQuery, relevanceScore } from './retrieval.js';

const require = createRequire(import.meta.url);
const now = () => new Date().toISOString();
const ACTIVE = new Set(['queued', 'running', 'cancelling']);

export class KnowledgeStore {
  constructor(path, identity = null) {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch { throw knowledgeError('知识库需要支持 node:sqlite 的 Node.js 22.19+ / 24+ 运行环境', 503); }
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path); this.scopeId = identity; this.ownsDatabase = true;
    this.documentRoot = join(dirname(path), 'documents');
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
      if (version !== 0 && version !== 3) throw knowledgeError('旧版知识库数据库请删除后重新构建，不做历史数据适配', 503);
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_title TEXT NOT NULL, workspace_root TEXT NOT NULL, docs_root TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sources (scope_id TEXT NOT NULL REFERENCES scopes(id), path TEXT NOT NULL, hash TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope_id,path));
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id), request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(scope_id,request_key));
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, coordinate TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(scope_id,path), FOREIGN KEY(scope_id,path) REFERENCES sources(scope_id,path));
        CREATE TABLE IF NOT EXISTS document_versions (document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(document_id,version));
        CREATE TABLE IF NOT EXISTS conversation_imports(scope_id TEXT NOT NULL REFERENCES scopes(id), conversation_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id), payload TEXT NOT NULL, PRIMARY KEY(scope_id,conversation_id));
        CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(id UNINDEXED,title,body,path,tokenize='unicode61 remove_diacritics 2');
        PRAGMA user_version=3;
        COMMIT;
      `);
      if (identity !== null) this.scoped(identity, { id: identity, title: identity }, '', '');
      for (const job of this.jobs()) {
        if (!ACTIVE.has(job.status)) continue;
        job.status = 'interrupted';
        for (const file of job.files) if (['pending', 'running'].includes(file.status)) file.status = 'interrupted';
        this.saveJob(job);
      }
      this.syncDocuments();
    } catch (error) { this.db.close(); throw error; }
  }

  scoped(identity, workspace, workspaceRoot, docsRoot) {
    this.db.prepare('INSERT INTO scopes VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace_title=excluded.workspace_title').run(identity, workspace.id, workspace.title || workspace.id, workspaceRoot, docsRoot);
    return Object.assign(Object.create(KnowledgeStore.prototype), { db: this.db, scopeId: identity, ownsDatabase: false, documentRoot: this.documentRoot });
  }
  scopeFilter(alias = 'd') { return `(? IS NULL OR ${alias}.scope_id=?)`; }
  scopeArgs() { return [this.scopeId, this.scopeId]; }
  scopes() { return this.db.prepare('SELECT * FROM scopes').all(); }
  sources() { return this.db.prepare('SELECT path,hash,status FROM sources WHERE scope_id=?').all(this.scopeId); }
  setSourceStatus(path, status) { this.db.prepare('UPDATE sources SET status=? WHERE scope_id=? AND path=?').run(status, this.scopeId, path); }
  syncDocuments() {
    for (const row of this.db.prepare('SELECT * FROM documents').all()) this.projectDocument(row);
  }
  projectDocument(row) {
    const origin = this.db.prepare('SELECT * FROM scopes WHERE id=?').get(row.scope_id);
    const saved = this.db.prepare('SELECT snapshot FROM document_versions WHERE document_id=? AND version=?').get(row.id, row.version);
    const conversation = saved && JSON.parse(saved.snapshot).conversation;
    writeKnowledgeDocument(this.documentRoot, { ...row, workspaceId: origin.workspace_id, workspaceTitle: origin.workspace_title, conversation });
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  jobs() { return this.db.prepare(`SELECT payload FROM jobs j WHERE ${this.scopeFilter('j')} ORDER BY rowid DESC`).all(...this.scopeArgs()).map(r => JSON.parse(r.payload)); }
  job(id) { const row = this.db.prepare(`SELECT payload FROM jobs j WHERE id=? AND ${this.scopeFilter('j')}`).get(id, ...this.scopeArgs()); return row ? JSON.parse(row.payload) : null; }
  request(key) { const row = this.db.prepare('SELECT payload FROM jobs WHERE scope_id=? AND request_key=?').get(this.scopeId, key); return row ? JSON.parse(row.payload) : null; }
  saveJob(job) {
    job.updatedAt = now(); job.seq = (job.seq || 0) + 1; job.counts = {};
    for (const file of job.files) job.counts[file.status] = (job.counts[file.status] || 0) + 1;
    const scopeId = this.scopeId ?? this.db.prepare('SELECT scope_id FROM jobs WHERE id=?').get(job.id)?.scope_id;
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(job.id, scopeId, job.requestKey, job.fingerprint, JSON.stringify(job));
  }
  source(path) { return this.db.prepare('SELECT * FROM sources WHERE scope_id=? AND path=?').get(this.scopeId, path); }
  markMissing(path) { this.setSourceStatus(path, 'missing'); }

  rowEntry(row) {
    if (!row) return null;
    const origin = this.db.prepare('SELECT workspace_id,workspace_title FROM scopes WHERE id=?').get(row.scope_id);
    const provenance = { workspaceId: origin.workspace_id, workspaceTitle: origin.workspace_title };
    const snapshot = this.db.prepare('SELECT snapshot FROM document_versions WHERE document_id=? AND version=?').get(row.id, row.version);
    const saved = snapshot ? JSON.parse(snapshot.snapshot) : {};
    const { locations, conversation } = saved;
    return { id: row.id, ...provenance, title: row.title, body: row.body, type: conversation ? 'conversation' : 'document', ...(conversation ? { conversation } : {}), tags: [], version: row.version, updatedAt: row.updated_at,
      sources: [{ ...provenance, relativePath: row.path, sourceHash: row.source_hash, status: row.source_status, coordinate: row.coordinate, startLine: 1, endLine: row.body.split('\n').length, ...(conversation ? { conversation } : {}), ...(locations?.length ? { locations } : {}) }] };
  }
  entry(id) {
    const entry = this.rowEntry(this.db.prepare('SELECT d.*,s.hash AS source_hash,s.status AS source_status FROM documents d JOIN sources s ON s.scope_id=d.scope_id AND s.path=d.path WHERE d.id=? AND (? IS NULL OR d.scope_id=?)').get(id, ...this.scopeArgs()));
    if (entry) entry.versions = this.db.prepare('SELECT version,snapshot FROM document_versions WHERE document_id=? ORDER BY version DESC').all(id).map(v => ({ version: v.version, ...JSON.parse(v.snapshot) }));
    return entry;
  }
  publishDocument(source, fingerprint) {
    const result = this.transaction(() => this.publishDocumentRow(source, fingerprint));
    this.projectDocument(this.db.prepare('SELECT * FROM documents WHERE id=?').get(result.documentId));
    return result;
  }
  publishDocumentRow(source, fingerprint) {
      const previous = this.source(source.relativePath);
      const old = this.db.prepare('SELECT * FROM documents WHERE scope_id=? AND path=?').get(this.scopeId, source.relativePath);
      const title = source.title || posix.basename(source.relativePath);
      const id = old?.id || randomUUID();
      const changed = !old || old.title !== title || previous?.hash !== source.contentHash || old.body !== source.text || previous?.fingerprint !== fingerprint;
      const version = old ? old.version + (changed ? 1 : 0) : 1;
      const timestamp = now();
      this.db.prepare("INSERT INTO sources VALUES (?,?,?,?,'active',?) ON CONFLICT(scope_id,path) DO UPDATE SET hash=excluded.hash,fingerprint=excluded.fingerprint,status='active',updated_at=excluded.updated_at").run(this.scopeId, source.relativePath, source.contentHash, fingerprint, timestamp);
      this.db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,path) DO UPDATE SET title=excluded.title,body=excluded.body,version=excluded.version,coordinate=excluded.coordinate,updated_at=excluded.updated_at').run(id, this.scopeId, source.relativePath, title, source.text, version, source.coordinate || 'source', timestamp);
      this.db.prepare('INSERT OR IGNORE INTO document_versions VALUES (?,?,?)').run(id, version, JSON.stringify({ title, body: source.text, relativePath: source.relativePath, sourceHash: source.contentHash, updatedAt: timestamp, locations: source.locations, warnings: source.warnings, conversation: source.conversation }));
      this.db.prepare('DELETE FROM document_fts WHERE id=?').run(id);
      if (source.text.trim()) this.db.prepare('INSERT INTO document_fts VALUES (?,?,?,?)').run(id, title, source.text, source.relativePath);
      return { entryIds: [id], documentId: id, characterCount: source.text.length };
  }
  isConversationSource(path) { return !!this.db.prepare('SELECT 1 FROM conversation_imports i JOIN documents d ON d.id=i.document_id WHERE i.scope_id=? AND d.path=?').get(this.scopeId, path); }
  activeWhere() { return "s.status IN ('active','stale') AND EXISTS(SELECT 1 FROM document_fts AS ft_source WHERE ft_source.id=d.id)"; }
  status() {
    const count = this.db.prepare(`SELECT count(*) AS n FROM documents d JOIN sources s ON s.scope_id=d.scope_id AND s.path=d.path WHERE ${this.scopeFilter()} AND ${this.activeWhere()}`).get(...this.scopeArgs()).n;
    const jobs = this.jobs().filter(job => job.ingestionMode === 'full-document');
    return { ready: count > 0, entryCount: count, sourceCount: count, lastBuiltAt: this.db.prepare('SELECT max(updated_at) AS t FROM documents d WHERE (? IS NULL OR d.scope_id=?)').get(...this.scopeArgs()).t,
      activeJobId: jobs.find(j => ACTIVE.has(j.status))?.id || null, latestJobId: jobs[0]?.id || null, ingestionMode: 'full-document' };
  }
  list(limit = 100) {
    return this.db.prepare(`SELECT d.*,s.hash AS source_hash,s.status AS source_status FROM documents d JOIN sources s ON s.scope_id=d.scope_id AND s.path=d.path WHERE ${this.scopeFilter()} AND ${this.activeWhere()} ORDER BY d.updated_at DESC,d.id LIMIT ?`).all(...this.scopeArgs(), limit).map(r => this.rowEntry(r));
  }
  search(text, limit = 20) {
    text = text.trim().slice(0, 1000); limit = Math.max(1, Math.min(100, Number(limit) || 20));
    if (!text) return { hits: [], hasMore: false, knowledgeReady: this.status().ready };
    const candidateLimit = Math.min(404, (limit + 1) * 4);
    const columns = 'd.*,s.hash AS source_hash,s.status AS source_status';
    let rows = this.db.prepare(`SELECT ${columns},bm25(document_fts,0.0,4.0,1.0,0.5) AS rank FROM document_fts JOIN documents d ON d.id=document_fts.id JOIN sources s ON s.scope_id=d.scope_id AND s.path=d.path WHERE document_fts MATCH ? AND ${this.scopeFilter()} AND ${this.activeWhere()} ORDER BY rank,d.updated_at DESC LIMIT ?`).all(toFtsQuery(text), ...this.scopeArgs(), candidateLimit);
    const terms = fallbackTerms(text);
    if (terms.length) {
      const clauses = terms.map(() => "(d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\' OR d.path LIKE ? ESCAPE '\\')");
      const args = terms.flatMap(t => { const like = `%${t.replace(/[\\%_]/g, c => '\\' + c)}%`; return [like, like, like]; });
      const extras = this.db.prepare(`SELECT ${columns} FROM documents d JOIN sources s ON s.scope_id=d.scope_id AND s.path=d.path WHERE ${this.scopeFilter()} AND ${this.activeWhere()} AND (${clauses.join(' OR ')}) ORDER BY d.updated_at DESC,d.id LIMIT ?`).all(...this.scopeArgs(), ...args, candidateLimit);
      const seen = new Set(rows.map(r => r.id)); rows.push(...extras.filter(r => !seen.has(r.id)));
    }
    const hits = rows.map(row => {
      const entry = this.rowEntry(row), lower = entry.body.toLowerCase();
      let index = lower.indexOf(text.toLowerCase());
      if (index < 0) index = terms.map(t => lower.indexOf(t)).filter(i => i >= 0).sort((a,b) => a-b)[0] ?? 0;
      const start = Math.max(0, index - 60);
      // Search returns an excerpt; full body remains available through the detail endpoint.
      const { body, ...summary } = entry;
      const line = body.slice(0, index).split('\n').length;
      summary.sources = summary.sources.map(source => ({ ...source, ...(source.locations ? { locations: source.locations.filter(location => location.startLine <= line && location.endLine >= line).slice(0, 3) } : {}) }));
      return { ...summary, score: relevanceScore({ ...entry, tags: [row.path] }, text), snippet: body.slice(start, start + 240) };
    }).sort((a,b) => b.score-a.score || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { hits: hits.slice(0, limit), hasMore: hits.length > limit, knowledgeReady: this.status().ready };
  }
  close() { if (this.ownsDatabase) this.db.close(); }
}
