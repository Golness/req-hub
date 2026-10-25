import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath, rm } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { atomicWrite, withDocumentLock } from '../sync-document-validator.js';
import { renderSessionDocument } from '../session-utils.js';
import { safeDocumentPath } from '../safe-path.js';
import { removeRetiredCodexStore } from './retired-storage.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const conversationError = (code, statusCode = 409) => Object.assign(new Error(code), { statusCode });
export function conversationDatabasePath(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return join(home, 'req-hub', 'conversations', 'conversations.sqlite');
}

/** Global source-scoped snapshots. SQLite owns content; Markdown is a projection. */
export class ConversationStore {
  constructor(path = conversationDatabasePath()) { this.path = resolve(path); }
  async database() {
    if (!this.opening) this.opening = (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      if (this.path === resolve(conversationDatabasePath(resolve(dirname(this.path), '../..')))) await removeRetiredCodexStore(resolve(dirname(this.path), '../..'));
      const db = new DatabaseSync(this.path);
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY, source TEXT NOT NULL, instance TEXT NOT NULL, project TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bindings(owner TEXT NOT NULL, workspace TEXT NOT NULL, source TEXT NOT NULL, scope TEXT NOT NULL REFERENCES scopes(id), PRIMARY KEY(owner,workspace,source));
        CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, scope TEXT NOT NULL REFERENCES scopes(id), native_id TEXT NOT NULL, payload TEXT NOT NULL, version TEXT, status TEXT NOT NULL, UNIQUE(scope,native_id));
        CREATE TABLE IF NOT EXISTS snapshots(conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, version TEXT NOT NULL, payload TEXT NOT NULL, file TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(conversation,version));
        CREATE TABLE IF NOT EXISTS refs(task TEXT NOT NULL, conversation TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(task,conversation), FOREIGN KEY(conversation,version) REFERENCES snapshots(conversation,version));
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, payload TEXT NOT NULL);
        PRAGMA user_version=1;`);
      this.db = db; return db;
    })();
    return this.opening;
  }
  async scope(source, instance, project) {
    const db = await this.database(), id = hash(JSON.stringify([source, instance, project.id]));
    db.prepare('INSERT INTO scopes VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id, source, instance, project.id, JSON.stringify(project));
    return id;
  }
  async bind(owner, workspace, source, scope) {
    (await this.database()).prepare('INSERT INTO bindings VALUES(?,?,?,?) ON CONFLICT(owner,workspace,source) DO UPDATE SET scope=excluded.scope').run(owner, workspace, source, scope);
  }
  async binding(owner, workspace, source) {
    const db = await this.database();
    return db.prepare('SELECT s.* FROM bindings b JOIN scopes s ON s.id=b.scope WHERE b.owner=? AND b.workspace=? AND b.source=?').get(owner, workspace, source);
  }
  async put(scope, details, snapshot) {
    return withDocumentLock(this.path, () => this.putLocked(scope, details, snapshot));
  }
  async putLocked(scope, details, snapshot) {
    const db = await this.database(), id = hash(JSON.stringify([scope, details.id]));
    const file = snapshot ? `documents/${scope}/${id}/versions/${snapshot.version}.md` : null;
    const payload = { ...details, conversationId: id, ...(snapshot ? { snapshotVersion: snapshot.version, markdownFile: file, turnCount: snapshot.turnCount, syncTurnCount: snapshot.syncTurnCount } : { syncTurnCount: 0 }) };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,version=excluded.version,status=excluded.status').run(id, scope, details.id, JSON.stringify(payload), snapshot?.version || null, snapshot ? 'active' : 'unavailable');
      if (snapshot) {
        const { markdown, ...body } = snapshot;
        if (hash(JSON.stringify(body.turns)) !== body.version) throw conversationError('SESSION_SNAPSHOT_INVALID');
        db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?)').run(id, body.version, JSON.stringify(body), file, new Date().toISOString());
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (snapshot) await this.projectLocked(id, snapshot.version);
    return payload;
  }
  async project(id, version) {
    return withDocumentLock(this.path, () => this.projectLocked(id, version));
  }
  async projectLocked(id, version) {
    const db = await this.database(), row = db.prepare('SELECT * FROM snapshots WHERE conversation=? AND version=?').get(id, version);
    if (!row) throw conversationError('SESSION_SNAPSHOT_MISSING');
    const snapshot = JSON.parse(row.payload);
    if (hash(JSON.stringify(snapshot.turns)) !== row.version) throw conversationError('SESSION_SNAPSHOT_INVALID');
    const path = await safeDocumentPath(dirname(this.path), row.file, { allowMissing: true });
    await mkdir(dirname(path), { recursive: true });
    await safeDocumentPath(dirname(this.path), row.file, { allowMissing: true });
    const origin = db.prepare('SELECT s.* FROM scopes s JOIN conversations c ON c.scope=s.id WHERE c.id=?').get(id);
    const metadata = { conversationId: id, source: origin.source, workspaceId: origin.project, version };
    const text = '---\n' + Object.entries(metadata).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n') + '\n---\n\n' + renderSessionDocument(snapshot.sessionId, snapshot.turns);
    await atomicWrite(path, Buffer.from(text));
    // Current is disposable; historical version projections never change content.
    const current = join(dirname(dirname(path)), 'current.md');
    if (db.prepare('SELECT version FROM conversations WHERE id=?').get(id)?.version === version) {
      await safeDocumentPath(dirname(this.path), relative(dirname(this.path), current), { allowMissing: true });
      await atomicWrite(current, Buffer.from(text));
    }
    return snapshot;
  }
  async list(scope) {
    return (await this.database()).prepare('SELECT payload,status FROM conversations WHERE scope=? ORDER BY rowid DESC').all(scope).map(row => ({ ...JSON.parse(row.payload), sourceStatus: row.status }));
  }
  async find(scope, nativeId) {
    return (await this.database()).prepare('SELECT * FROM conversations WHERE scope=? AND native_id=?').get(scope, nativeId);
  }
  async finish(scope, ids) {
    const db = await this.database(), keep = new Set(ids);
    for (const row of db.prepare('SELECT id,native_id FROM conversations WHERE scope=?').all(scope)) if (!keep.has(row.native_id)) db.prepare("UPDATE conversations SET status='missing',version=NULL WHERE id=?").run(row.id);
  }
  async pin(task, snapshots) {
    if (!snapshots.length) return;
    return withDocumentLock(this.path, () => this.pinLocked(task, snapshots));
  }
  async pinLocked(task, snapshots) {
    const db = await this.database();
    db.exec('BEGIN IMMEDIATE');
    try { for (const snapshot of snapshots) db.prepare('INSERT OR REPLACE INTO refs VALUES(?,?,?)').run(task, snapshot.conversationId, snapshot.version); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async unpin(task) { (await this.database()).prepare('DELETE FROM refs WHERE task=?').run(task); }
  async versions(id) {
    return (await this.database()).prepare('SELECT version,created_at,(SELECT count(*) FROM refs r WHERE r.conversation=s.conversation AND r.version=s.version) AS references_count FROM snapshots s WHERE conversation=? ORDER BY created_at DESC,rowid DESC').all(id);
  }
  async remove(id, version) {
    return withDocumentLock(this.path, () => this.removeLocked(id, version));
  }
  async removeLocked(id, version) {
    const db = await this.database();
    if (db.prepare('SELECT 1 FROM refs WHERE conversation=? AND (? IS NULL OR version=?)').get(id, version || null, version || null)) throw conversationError('SESSION_VERSION_IN_USE');
    if (version) {
      if (db.prepare('SELECT version FROM conversations WHERE id=?').get(id)?.version === version) throw conversationError('SESSION_CURRENT_VERSION');
      const row = db.prepare('SELECT file FROM snapshots WHERE conversation=? AND version=?').get(id, version);
      if (row) { const path = await safeDocumentPath(dirname(this.path), row.file, { allowMissing: true }); await rm(path, { force: true }); }
      db.prepare('DELETE FROM snapshots WHERE conversation=? AND version=?').run(id, version);
    } else {
      const row = db.prepare('SELECT scope FROM conversations WHERE id=?').get(id);
      if (!row) return;
      const path = await safeDocumentPath(dirname(this.path), `documents/${row.scope}/${id}`, { allowMissing: true });
      // Canonical target was checked beneath the owned database directory.
      if (await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
        const actual = await realpath(path), root = await realpath(dirname(this.path));
        if (!relative(root, actual) || relative(root, actual).startsWith('..')) throw conversationError('SESSION_STORAGE_PATH');
        await rm(path, { recursive: true, force: true });
      }
      db.prepare('DELETE FROM conversations WHERE id=?').run(id);
    }
  }
  async close() { if (this.opening) { await this.opening; this.db.close(); this.opening = null; } }
}
