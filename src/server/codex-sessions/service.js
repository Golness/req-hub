import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { atomicWrite } from '../sync-document-validator.js';
import { CodexSource, codexError } from './source.js';

const digest = text => createHash('sha256').update(text).digest('hex');

/** Read-only Codex source, independent ReqHub SQLite + immutable Markdown snapshots. */
export class CodexSessionService {
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), databasePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'req-hub', 'codex', 'codex.sqlite') } = {}) {
    this.source = new CodexSource(codexHome);
    this.databasePath = databasePath;
    this.queue = Promise.resolve();
  }
  async database() {
    if (!this.opening) this.opening = (async () => {
      await mkdir(dirname(this.databasePath), { recursive: true });
      const db = new DatabaseSync(this.databasePath);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS selections (workspace_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL, refreshed_at TEXT);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL, version TEXT, active INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshots (session_id TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL, markdown TEXT NOT NULL, file TEXT NOT NULL, PRIMARY KEY(session_id,version));`);
      this.db = db; return db;
    })();
    return this.opening;
  }
  async workspaces() {
    const inventory = await this.source.inventory();
    return { workspaces: inventory.workspaces, warnings: inventory.warnings };
  }
  async list(workspaceId) {
    const db = await this.database();
    const selection = db.prepare('SELECT project_id FROM selections WHERE workspace_id=?').get(workspaceId);
    const project = selection && db.prepare('SELECT payload,refreshed_at FROM projects WHERE id=?').get(selection.project_id);
    return { workspace: project ? JSON.parse(project.payload) : null, refreshedAt: project?.refreshed_at || null,
      sessions: project ? db.prepare('SELECT payload FROM sessions WHERE project_id=? AND active=1').all(selection.project_id).map(row => JSON.parse(row.payload)).sort((a, b) => b.updatedAt - a.updatedAt) : [] };
  }
  refresh(workspaceId, projectId) {
    const operation = this.queue.then(() => this.importProject(workspaceId, projectId));
    this.queue = operation.catch(() => {});
    return operation;
  }
  async importProject(workspaceId, projectId) {
    const db = await this.database();
    projectId ||= db.prepare('SELECT project_id FROM selections WHERE workspace_id=?').get(workspaceId)?.project_id;
    const inventory = await this.source.inventory();
    const cachedProject = projectId && db.prepare('SELECT payload FROM projects WHERE id=?').get(projectId);
    const project = inventory.workspaces.find(item => item.id === projectId) || (cachedProject && JSON.parse(cachedProject.payload));
    if (!project) throw codexError('CODEX_WORKSPACE_MISSING: 工作区不存在，请重新选择 Codex 工作区', 404);
    const warnings = [...inventory.warnings], rows = [];
    let importedCount = 0;
    for (const session of inventory.sessions.filter(item => item.workspaceId === project.id)) {
      const details = { ...session, source: 'codex', isPersisted: true };
      delete details.sourcePath; delete details.nativeId;
      try {
        const snapshot = await this.source.snapshot(session);
        const file = join('documents', digest(project.id).slice(0, 24), digest(session.id).slice(0, 24) + '-' + snapshot.version + '.md');
        const previous = db.prepare('SELECT 1 FROM snapshots WHERE session_id=? AND version=?').get(session.id, snapshot.version);
        if (!previous || !existsSync(join(dirname(this.databasePath), file))) {
          await mkdir(join(dirname(this.databasePath), dirname(file)), { recursive: true });
          await atomicWrite(join(dirname(this.databasePath), file), Buffer.from(snapshot.markdown, 'utf8'));
        }
        const { markdown, ...payload } = snapshot;
        details.turnCount = snapshot.turnCount; details.syncTurnCount = snapshot.syncTurnCount;
        details.snapshotVersion = snapshot.version; details.markdownFile = file.replaceAll('\\', '/');
        // Persist one transcript at a time so importing a large workspace does not retain every body in memory.
        db.prepare('INSERT OR IGNORE INTO snapshots(session_id,version,payload,markdown,file) VALUES(?,?,?,?,?)').run(session.id, snapshot.version, JSON.stringify(payload), snapshot.markdown, file);
        importedCount++;
      } catch (error) {
        details.snapshotError = error.message; details.syncTurnCount = 0;
        warnings.push(`${session.title}：${error.message}`);
      }
      rows.push({ session, details });
    }
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE sessions SET active=0 WHERE project_id=?').run(project.id);
      db.prepare('INSERT INTO projects(id,payload,refreshed_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,refreshed_at=excluded.refreshed_at').run(project.id, JSON.stringify(project), now);
      for (const { session, details } of rows) db.prepare('INSERT INTO sessions(id,project_id,payload,version,active) VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,payload=excluded.payload,version=excluded.version,active=1').run(session.id, project.id, JSON.stringify({ ...details, importedAt: now }), details.snapshotVersion || null);
      db.prepare('INSERT INTO selections(workspace_id,project_id) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET project_id=excluded.project_id').run(workspaceId, project.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { ...await this.list(workspaceId), warnings, importedCount };
  }
  async snapshots(ids) {
    if (!ids.length) return [];
    const inventory = await this.source.inventory();
    const snapshots = [];
    for (const id of ids) snapshots.push(await this.snapshot(id, inventory));
    return snapshots;
  }
  async snapshot(id, inventory) {
    const db = await this.database();
    const stored = db.prepare('SELECT version FROM sessions WHERE id=? AND active=1').get(id);
    if (!stored?.version) throw codexError('CODEX_SESSION_MISSING: 会话尚未拉取或已失效，请刷新 Codex 会话', 409);
    inventory ||= await this.source.inventory();
    const source = inventory.sessions.find(session => session.id === id);
    if (!source) throw codexError('CODEX_SESSION_ARCHIVED: 会话已归档或移除，请刷新 Codex 会话', 409);
    let current;
    try { current = await this.source.snapshot(source); }
    catch (error) { throw codexError(error.message, 409); }
    if (current.version !== stored.version) throw codexError('SESSION_CHANGED: Codex 会话已变化，请刷新会话列表后重新选择', 409);
    const row = db.prepare('SELECT payload FROM snapshots WHERE session_id=? AND version=?').get(id, stored.version);
    if (!row) throw codexError('CODEX_SNAPSHOT_MISSING: 会话快照缺失，请刷新 Codex 会话', 409);
    const snapshot = JSON.parse(row.payload);
    if (digest(JSON.stringify(snapshot.turns)) !== snapshot.version) throw codexError('CODEX_SNAPSHOT_INVALID: 会话快照损坏，请重新拉取', 409);
    return snapshot;
  }
  async close() { await this.queue; if (this.opening) { await this.opening; this.db?.close(); } }
}
