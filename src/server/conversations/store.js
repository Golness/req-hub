import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { withDocumentLock } from '../sync-document-validator.js';
import { renderSessionDocument } from '../session-utils.js';
import { removeRetiredCodexStore } from './retired-storage.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const conversationError = (code, statusCode = 409) => Object.assign(new Error(code), { statusCode });
export const CONVERSATION_POLICY = Object.freeze({ retainedVersions: 3, versionRetentionDays: 7, missingRetentionDays: 30, jobRetentionDays: 7, retainedJobs: 100, graceHours: 1 });
export function conversationDatabasePath(home = process.env.DSH_HOME || join(homedir(), '.dsh')) { return join(home, 'req-hub', 'conversations', 'conversations.sqlite'); }
const openJobs = new Set(['running', 'queued', 'cancelling']);
const normalized = path => process.platform === 'win32' ? path.toLowerCase() : path;

/** SQLite owns immutable shared turns and version membership. Markdown is one current projection. */
export class ConversationStore {
  constructor(path = conversationDatabasePath()) { this.path = resolve(path); }
  owned(path) {
    const root = dirname(this.path), full = resolve(path), rel = relative(root, full);
    if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw conversationError('SESSION_STORAGE_PATH');
    if (normalized(realpathSync(root)) !== normalized(root)) throw conversationError('SESSION_STORAGE_LINK');
    let cursor = root;
    for (const part of rel.split(/[\\/]/)) {
      cursor = join(cursor, part);
      try { if (lstatSync(cursor).isSymbolicLink()) throw conversationError('SESSION_STORAGE_LINK'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return full;
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async database() {
    if (!this.opening) this.opening = (async () => {
      mkdirSync(dirname(this.path), { recursive: true });
      if (this.path === resolve(conversationDatabasePath(resolve(dirname(this.path), '../..')))) await removeRetiredCodexStore(resolve(dirname(this.path), '../..'));
      for (const suffix of ['', '-wal', '-shm']) {const path=this.owned(this.path+suffix);try{if(lstatSync(path).nlink>1)throw conversationError('SESSION_STORAGE_LINK');}catch(error){if(error.code!=='ENOENT')throw error;}}
      const db = this.db = new DatabaseSync(this.path);
      try {
        db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;');
        this.transaction(() => {
          const version = db.prepare('PRAGMA user_version').get().user_version;
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
          if (![0, 1, 2].includes(version) || version === 0 && tables.length) throw conversationError('SESSION_STORAGE_SCHEMA');
          const retired = version === 1;
          if (retired) {
            // Retire the entire old library atomically. No old payloads or references are imported.
            for (const table of ['refs', 'snapshots', 'conversations', 'bindings', 'jobs', 'scopes']) db.exec('DROP TABLE IF EXISTS ' + table);
          }
          db.exec(`CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY,source TEXT NOT NULL,instance TEXT NOT NULL,project TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bindings(owner TEXT NOT NULL,workspace TEXT NOT NULL,source TEXT NOT NULL,scope TEXT NOT NULL REFERENCES scopes(id),PRIMARY KEY(owner,workspace,source));
            CREATE TABLE IF NOT EXISTS scope_access(owner TEXT NOT NULL,workspace TEXT NOT NULL,scope TEXT NOT NULL REFERENCES scopes(id),PRIMARY KEY(owner,workspace,scope));
            CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,scope TEXT NOT NULL REFERENCES scopes(id),native_id TEXT NOT NULL,payload TEXT NOT NULL,version TEXT,status TEXT NOT NULL,missing_at INTEGER,UNIQUE(scope,native_id));
            CREATE TABLE IF NOT EXISTS snapshots(conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,version TEXT NOT NULL,payload TEXT NOT NULL,file TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(conversation,version));
            CREATE TABLE IF NOT EXISTS objects(scope TEXT NOT NULL REFERENCES scopes(id),hash TEXT NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(scope,hash));
            CREATE TABLE IF NOT EXISTS snapshot_objects(conversation TEXT NOT NULL,version TEXT NOT NULL,position INTEGER NOT NULL,scope TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(conversation,version,position),FOREIGN KEY(conversation,version) REFERENCES snapshots(conversation,version) ON DELETE CASCADE,FOREIGN KEY(scope,hash) REFERENCES objects(scope,hash));
            CREATE INDEX IF NOT EXISTS snapshot_object_hash ON snapshot_objects(scope,hash);
            CREATE TABLE IF NOT EXISTS refs(task TEXT NOT NULL,conversation TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(task,conversation),FOREIGN KEY(conversation,version) REFERENCES snapshots(conversation,version));
            CREATE INDEX IF NOT EXISTS conversation_refs ON refs(conversation,version);
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS storage_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
          db.prepare('INSERT OR IGNORE INTO storage_meta VALUES(?,?)').run('retired_documents', version === 2 ? 1 : 0);
          db.prepare('INSERT OR IGNORE INTO storage_meta VALUES(?,?)').run('compact_legacy', retired ? 1 : 0);
          if (!db.prepare("SELECT value FROM storage_meta WHERE key='retired_documents'").get().value) {
            const target = this.owned(join(dirname(this.path), 'documents'));
            rmSync(target, { recursive: true, force: true });
            db.exec("UPDATE storage_meta SET value=1 WHERE key='retired_documents'");
          }
          db.exec('PRAGMA user_version=2;');
        });
        if (db.prepare("SELECT value FROM storage_meta WHERE key='compact_legacy'").get().value) {
          db.exec("PRAGMA auto_vacuum=INCREMENTAL; VACUUM; PRAGMA wal_checkpoint(TRUNCATE); UPDATE storage_meta SET value=0 WHERE key='compact_legacy';");
        }
        return db;
      } catch (error) { db.close(); this.db = undefined; throw error; }
    })().catch(error => { this.opening = null; throw error; });
    return this.opening;
  }
  async scope(source, instance, project) {
    const db = await this.database(), id = hash(JSON.stringify([source, instance, project.id]));
    db.prepare('INSERT INTO scopes VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id, source, instance, project.id, JSON.stringify(project)); return id;
  }
  async bind(owner, workspace, source, scope, {signal} = {}) {
    await this.database();
    this.transaction(() => {
      signal?.throwIfAborted();
      this.db.prepare('INSERT INTO bindings VALUES(?,?,?,?) ON CONFLICT(owner,workspace,source) DO UPDATE SET scope=excluded.scope').run(owner, workspace, source, scope);
      this.db.prepare('INSERT OR IGNORE INTO scope_access VALUES(?,?,?)').run(owner, workspace, scope);
    });
  }
  async binding(owner, workspace, source) {
    return (await this.database()).prepare('SELECT s.* FROM bindings b JOIN scopes s ON s.id=b.scope WHERE b.owner=? AND b.workspace=? AND b.source=?').get(owner, workspace, source);
  }
  async allow(owner, workspace, scope) {
    (await this.database()).prepare('INSERT OR IGNORE INTO scope_access VALUES(?,?,?)').run(owner, workspace, scope);
  }
  async put(scope, details, snapshot, options) { return withDocumentLock(this.path, () => this.putLocked(scope, details, snapshot, options)); }
  async putLocked(scope, details, snapshot, {signal} = {}) {
    await this.database(); const db = this.db, id = hash(JSON.stringify([scope, details.id]));
    const file = `documents/${scope}/${id}/current.md`;
    const payload = { ...details, conversationId: id, ...(snapshot ? { snapshotVersion: snapshot.version, markdownFile: file, turnCount: snapshot.turnCount, syncTurnCount: snapshot.syncTurnCount } : { syncTurnCount: 0 }) };
    this.transaction(() => {
      signal?.throwIfAborted();
      if (snapshot && hash(JSON.stringify(snapshot.turns)) !== snapshot.version) throw conversationError('SESSION_SNAPSHOT_INVALID');
      db.prepare(`INSERT INTO conversations VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,version=excluded.version,status=excluded.status,missing_at=CASE WHEN excluded.status='active' THEN NULL ELSE COALESCE(conversations.missing_at,excluded.missing_at) END`).run(id, scope, details.id, JSON.stringify(payload), snapshot?.version || null, snapshot ? 'active' : 'unavailable', snapshot ? null : Date.now());
      if (snapshot) {
        const { markdown, turns, ...metadata } = snapshot;
        const inserted = db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?)').run(id, snapshot.version, JSON.stringify(metadata), file, new Date().toISOString()).changes;
        const putObject = db.prepare('INSERT OR IGNORE INTO objects VALUES(?,?,?,?)'), putReference = db.prepare('INSERT INTO snapshot_objects VALUES(?,?,?,?,?)');
        if (inserted) for (const [position, turn] of turns.entries()) {
          const text = JSON.stringify(turn), digest = hash(text);
          putObject.run(scope, digest, text, Buffer.byteLength(text));
          putReference.run(id, snapshot.version, position, scope, digest);
        }
        this.projectInTransaction(id, snapshot.version);
      }
    });
    return payload;
  }
  async project(id, version) { return withDocumentLock(this.path, () => this.projectLocked(id, version)); }
  async projectLocked(id, version) { await this.database(); return this.transaction(() => this.projectInTransaction(id, version)); }
  projectInTransaction(id, version) {
    const db = this.db, row = db.prepare('SELECT * FROM snapshots WHERE conversation=? AND version=?').get(id, version);
    if (!row) throw conversationError('SESSION_SNAPSHOT_MISSING');
    const metadata = JSON.parse(row.payload), turns = db.prepare('SELECT o.hash,o.payload FROM snapshot_objects r JOIN objects o ON o.scope=r.scope AND o.hash=r.hash WHERE r.conversation=? AND r.version=? ORDER BY r.position').all(id, version).map(object => { if (hash(object.payload) !== object.hash) throw conversationError('SESSION_SNAPSHOT_INVALID'); return JSON.parse(object.payload); });
    if (hash(JSON.stringify(turns)) !== version) throw conversationError('SESSION_SNAPSHOT_INVALID');
    const snapshot = { ...metadata, turns };
    if (db.prepare('SELECT version FROM conversations WHERE id=?').get(id)?.version === version) {
      const origin = db.prepare('SELECT s.* FROM scopes s JOIN conversations c ON c.scope=s.id WHERE c.id=?').get(id);
      const header = { conversationId: id, source: origin.source, workspaceId: origin.project, version };
      const text = '---\n' + Object.entries(header).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n') + '\n---\n\n' + renderSessionDocument(snapshot.sessionId, turns);
      const path = this.owned(join(dirname(this.path), row.file)); mkdirSync(dirname(path), { recursive: true }); this.owned(path);
      try { if (readFileSync(path, 'utf8') === text) return snapshot; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temp = this.owned(path + '.' + randomUUID() + '.tmp');
      try { writeFileSync(temp, text, { flag: 'wx' }); renameSync(temp, path); } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    return snapshot;
  }
  async list(scope) { return (await this.database()).prepare('SELECT payload,status FROM conversations WHERE scope=? ORDER BY rowid DESC').all(scope).map(row => ({ ...JSON.parse(row.payload), sourceStatus: row.status })); }
  async find(scope, nativeId) { return (await this.database()).prepare('SELECT * FROM conversations WHERE scope=? AND native_id=?').get(scope, nativeId); }
  async finish(scope, ids, {signal} = {}) {
    const db = await this.database(), keep = new Set(ids);
    this.transaction(() => { signal?.throwIfAborted(); for (const row of db.prepare('SELECT id,native_id FROM conversations WHERE scope=?').all(scope)) if (!keep.has(row.native_id)) db.prepare("UPDATE conversations SET status='missing',version=NULL,missing_at=COALESCE(missing_at,?) WHERE id=?").run(Date.now(), row.id); });
  }
  async pin(task, snapshots) { if (snapshots.length) return withDocumentLock(this.path, () => this.pinLocked(task, snapshots)); }
  async pinLocked(task, snapshots) { await this.database(); return this.transaction(() => { for (const snapshot of snapshots) {if (!this.db.prepare('SELECT 1 FROM snapshots WHERE conversation=? AND version=?').get(snapshot.conversationId,snapshot.version)) throw conversationError('SESSION_SNAPSHOT_MISSING');this.db.prepare('INSERT OR REPLACE INTO refs VALUES(?,?,?)').run(task, snapshot.conversationId, snapshot.version);} }); }
  async unpin(task, policy) {
    const scopes = await withDocumentLock(this.path, async () => {await this.database(); return this.transaction(() => {const scopes=this.db.prepare('SELECT DISTINCT c.scope FROM refs r JOIN conversations c ON c.id=r.conversation WHERE r.task=?').all(task).map(row=>row.scope);this.db.prepare('DELETE FROM refs WHERE task=?').run(task);return scopes;});});
    return this.maintain(scopes, policy);
  }
  async unpinRetiredSync(workspaceId) {
    const db = await this.database();
    for (const row of db.prepare('SELECT DISTINCT task FROM refs').all()) { let identity; try { identity = JSON.parse(row.task); } catch { continue; } if (Array.isArray(identity) && identity.length === 3 && identity[0] === workspaceId && /^v2\//.test(identity[2])) db.prepare('DELETE FROM refs WHERE task=?').run(row.task); }
  }
  async versions(id) { return (await this.database()).prepare('SELECT version,created_at,(SELECT count(*) FROM refs r WHERE r.conversation=s.conversation AND r.version=s.version) AS references_count FROM snapshots s WHERE conversation=? ORDER BY created_at DESC,rowid DESC').all(id); }
  async remove(id, version) { return withDocumentLock(this.path, () => this.removeLocked(id, version)); }
  async removeLocked(id, version) { await this.database(); return this.transaction(() => { this.removeInTransaction(id, version); this.collectObjects(); }); }
  removeInTransaction(id, version) {
    const db = this.db;
    if (db.prepare('SELECT 1 FROM refs WHERE conversation=? AND (? IS NULL OR version=?)').get(id, version || null, version || null)) throw conversationError('SESSION_VERSION_IN_USE');
    if (version) {
      if (db.prepare('SELECT version FROM conversations WHERE id=?').get(id)?.version === version) throw conversationError('SESSION_CURRENT_VERSION');
      db.prepare('DELETE FROM snapshots WHERE conversation=? AND version=?').run(id, version);
    } else {
      const row = db.prepare('SELECT scope FROM conversations WHERE id=?').get(id); if (!row) return;
      const target = this.owned(join(dirname(this.path), `documents/${row.scope}/${id}`)); rmSync(target, { recursive: true, force: true });
      db.prepare('DELETE FROM conversations WHERE id=?').run(id);
    }
  }
  collectObjects() { this.db.exec('DELETE FROM objects WHERE NOT EXISTS(SELECT 1 FROM snapshot_objects r WHERE r.scope=objects.scope AND r.hash=objects.hash)'); }
  async maintain(scopes, policy = {}, identity = {}) {
    return withDocumentLock(this.path, async () => {
      await this.database(); const config = { ...CONVERSATION_POLICY, ...policy }, db = this.db, now = Date.now(), result = { versions: 0, conversations: 0, jobs: 0 };
      this.transaction(() => {
        for (const scope of new Set(scopes)) {
          for (const conversation of db.prepare('SELECT * FROM conversations WHERE scope=?').all(scope)) {
            if (conversation.status !== 'active' && conversation.missing_at != null && conversation.missing_at <= now - Math.max(config.missingRetentionDays * 86400000, config.graceHours * 3600000) && !db.prepare('SELECT 1 FROM refs WHERE conversation=?').get(conversation.id)) { this.removeInTransaction(conversation.id); result.conversations++; continue; }
            const versions = db.prepare('SELECT s.*,EXISTS(SELECT 1 FROM refs r WHERE r.conversation=s.conversation AND r.version=s.version) pinned FROM snapshots s WHERE conversation=? ORDER BY created_at DESC,rowid DESC').all(conversation.id);
            for (const [index, version] of versions.entries()) {
              if (version.version === conversation.version || version.pinned || Date.parse(version.created_at) > now - config.graceHours * 3600000) continue;
              if (index >= config.retainedVersions || Date.parse(version.created_at) <= now - config.versionRetentionDays * 86400000) { this.removeInTransaction(conversation.id, version.version); result.versions++; }
            }
          }
        }
        if (identity.owner && identity.workspace) {
          const jobs = db.prepare("SELECT id,payload FROM jobs WHERE json_extract(payload,'$.owner')=? AND json_extract(payload,'$.workspaceId')=? ORDER BY rowid DESC").all(identity.owner, identity.workspace);
          let completed = 0;
          for (const row of jobs) { const job = JSON.parse(row.payload); if (openJobs.has(job.status)) continue; completed++; if (completed > config.retainedJobs || Date.parse(job.updatedAt) <= now - config.jobRetentionDays * 86400000) { db.prepare('DELETE FROM jobs WHERE id=?').run(row.id); result.jobs++; } }
        }
        this.collectObjects();
      });
      db.exec('PRAGMA incremental_vacuum(128);');
      return result;
    });
  }
  async usage(scopes) {
    await this.database(); return this.transaction(() => {
      const db = this.db, result = { conversations: 0, versions: 0, objectCount: 0, objectBytes: 0, projectionBytes: 0, metadataBytes: 0, pinnedVersions: 0 };
      for (const scope of new Set(scopes)) {
        const conversations = db.prepare('SELECT id FROM conversations WHERE scope=?').all(scope); result.conversations += conversations.length;
        const objects = db.prepare('SELECT count(*) count,COALESCE(sum(bytes),0) bytes FROM objects WHERE scope=?').get(scope); result.objectCount += objects.count; result.objectBytes += objects.bytes;
        for (const { id } of conversations) {
          const versions = db.prepare('SELECT s.payload,EXISTS(SELECT 1 FROM refs r WHERE r.conversation=s.conversation AND r.version=s.version) pinned FROM snapshots s WHERE conversation=?').all(id); result.versions += versions.length; result.pinnedVersions += versions.filter(row => row.pinned).length; result.metadataBytes += versions.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0);
          const directory = this.owned(join(dirname(this.path), `documents/${scope}/${id}`));
          try { for (const name of readdirSync(directory)) { const path = this.owned(join(directory, name)); if (lstatSync(path).isFile()) result.projectionBytes += statSync(path).size; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      result.sharedDatabaseBytes = 0;
      for(const suffix of ['', '-wal', '-shm']) {try{result.sharedDatabaseBytes += statSync(this.owned(this.path+suffix)).size;}catch(error){if(error.code !== 'ENOENT')throw error;}}
      result.sharedReusableBytes = db.prepare('PRAGMA freelist_count').get().freelist_count * db.prepare('PRAGMA page_size').get().page_size;
      return result;
    });
  }
  async close() { if (this.opening) { await this.opening; this.db.close(); this.db = undefined; this.opening = null; } }
}
