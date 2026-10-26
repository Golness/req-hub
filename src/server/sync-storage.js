/** Global, workspace-isolated sync storage. SQLite owns identity, leases and references. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { mkdirSync, realpathSync, lstatSync, readFileSync, writeFileSync, unlinkSync, linkSync, readdirSync, rmSync, statSync } from 'node:fs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = path => process.platform === 'win32' ? path.toLowerCase() : path;
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
const fail = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const ACTIVE = new Set(['running', 'cancelling']);
const stores = new Map();
const PROCESS_OWNER = randomUUID();
export function syncStorageRoot() { return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'req-hub', 'sync'); }
export function getSyncStorage(root = syncStorageRoot()) {
  root = resolve(root);
  if (!stores.has(root) || stores.get(root).closed) stores.set(root, new SyncStorage(root));
  return stores.get(root);
}
export function retainSyncStorage(root) {
  const store = getSyncStorage(root); store.users = (store.users || 0) + 1;
  return { store, release() { if (--store.users === 0) { store.close(); stores.delete(store.root); } } };
}
export function closeSyncStorages() { for (const store of stores.values()) store.close(); stores.clear(); }

export class SyncStorage {
  constructor(root) {
    this.root = resolve(root); this.owner = PROCESS_OWNER; this.localLeases = new Map();
    mkdirSync(this.root, { recursive: true });
    if (normalize(realpathSync(this.root)) !== normalize(this.root)) throw fail('SYNC_STORAGE_LINK');
    this.db = new DatabaseSync(this.directory('sync.sqlite'));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspaces(key TEXT PRIMARY KEY,id TEXT NOT NULL,root TEXT NOT NULL,title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scopes(key TEXT PRIMARY KEY,workspace TEXT NOT NULL REFERENCES workspaces(key),requirement TEXT NOT NULL,path TEXT NOT NULL,docs_root TEXT NOT NULL,cleaned INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,scope TEXT NOT NULL REFERENCES scopes(key),status TEXT NOT NULL,payload TEXT NOT NULL,removed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS leases(workspace TEXT PRIMARY KEY,attempt TEXT NOT NULL,token TEXT NOT NULL,owner TEXT NOT NULL,pid INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(workspace TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(workspace,hash));
      CREATE TABLE IF NOT EXISTS evidence(attempt TEXT NOT NULL REFERENCES attempts(id),id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(attempt,id));
      CREATE TABLE IF NOT EXISTS refs(attempt TEXT NOT NULL REFERENCES attempts(id),id TEXT NOT NULL,workspace TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(attempt,id,hash),FOREIGN KEY(workspace,hash) REFERENCES objects(workspace,hash));
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,attempt TEXT NOT NULL REFERENCES attempts(id),path TEXT,name TEXT NOT NULL,logical_id TEXT,UNIQUE(attempt,name));
      PRAGMA user_version=1;`);
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  directory(path) {
    const full = resolve(this.root, path);
    if (!inside(this.root, full)) throw fail('SYNC_STORAGE_PATH');
    let cursor = this.root;
    for (const part of relative(this.root, full).split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, part);
      try { if (lstatSync(cursor).isSymbolicLink()) throw fail('SYNC_STORAGE_LINK'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (normalize(realpathSync(this.root)) !== normalize(this.root)) throw fail('SYNC_STORAGE_LINK');
    return full;
  }
  bind(workspace, requirementId, requirementPath, docsRoot = requirementPath) {
    const root = realpathSync(workspace.path), path = realpathSync(requirementPath), docs = realpathSync(docsRoot);
    if (!inside(root, docs) || !inside(docs, path)) throw fail('SYNC_SCOPE_PATH');
    const workspaceKey = hash(JSON.stringify([workspace.id, normalize(root)]));
    const key = hash(JSON.stringify([workspaceKey, requirementId, normalize(docs), normalize(path)]));
    this.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET title=excluded.title').run(workspaceKey, workspace.id, root, workspace.title || workspace.id);
    this.db.prepare('INSERT OR IGNORE INTO scopes(key,workspace,requirement,path,docs_root) VALUES(?,?,?,?,?)').run(key, workspaceKey, requirementId, path, docs);
    return { key, workspaceKey, workspaceId: workspace.id, requirementId, path, docsRoot: docs, store: this };
  }
  retire(scope) {
    this.transaction(() => {
      if (this.db.prepare('SELECT cleaned FROM scopes WHERE key=?').get(scope.key).cleaned) return;
      const live = this.db.prepare('SELECT * FROM leases WHERE workspace=?').get(scope.workspaceKey);
      // The only recursive deletion target is this explicitly named retired directory.
      const target = resolve(scope.path, 'sync-logs');
      if (basename(target) !== 'sync-logs' || !inside(scope.docsRoot, target) || target === scope.docsRoot) throw fail('SYNC_RETIRE_PATH');
      let cursor = scope.docsRoot;
      for (const part of relative(scope.docsRoot, target).split(/[\\/]/).filter(Boolean)) {
        cursor = join(cursor, part);
        try { if (lstatSync(cursor).isSymbolicLink()) throw fail('SYNC_RETIRE_LINK'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      try {
        const actual = realpathSync(target);
        if (live && live.expires > Date.now()) throw fail('SYNC_STORAGE_BUSY');
        if (!inside(scope.docsRoot, actual) || normalize(actual) !== normalize(target)) throw fail('SYNC_RETIRE_PATH');
        rmSync(target, { recursive: true, force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.db.prepare('UPDATE scopes SET cleaned=1 WHERE key=?').run(scope.key);
    });
  }
  state(scope) {
    const tasks = this.db.prepare('SELECT payload FROM attempts WHERE scope=? AND removed=0 ORDER BY rowid DESC').all(scope.key).map(row => JSON.parse(row.payload));
    return { schemaVersion: 2, activeSync: tasks.find(task => ACTIVE.has(task.status)) || null, history: tasks.filter(task => !ACTIVE.has(task.status)) };
  }
  live(task) {
    const row = this.db.prepare('SELECT * FROM leases WHERE attempt=?').get(task.id);
    return !!row && row.expires > Date.now();
  }
  owned(task) { return this.localLeases.get(task.id) === task.executionToken && this.live(task); }
  assert(task) {
    const row = this.db.prepare('SELECT a.removed,l.token,l.expires FROM attempts a LEFT JOIN leases l ON l.attempt=a.id WHERE a.id=?').get(task.id);
    if (!row || row.removed || row.token !== task.executionToken || row.expires <= Date.now()) throw fail('SYNC_EXECUTION_REVOKED');
  }
  start(scope, task) {
    this.transaction(() => {
      const lease = this.db.prepare('SELECT * FROM leases WHERE workspace=?').get(scope.workspaceKey);
      if (lease && lease.expires > Date.now()) throw fail('SYNC_STORAGE_BUSY');
      task.id = task.attemptId = randomUUID(); task.executionToken = randomUUID();
      task.workspaceKey = scope.workspaceKey; task.scopeKey = scope.key; task.storageVersion = 1;
      task.snapshotDir = `attempts/${task.id}`; task.owner = this.owner;
      this.attemptRoot(task, true);
      this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,0)').run(task.id, task.taskId || task.id, scope.key, task.status, JSON.stringify(task));
      this.db.prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?,?)').run(scope.workspaceKey, task.id, task.executionToken, this.owner, process.pid, Date.now() + 90000);
      this.localLeases.set(task.id, task.executionToken);
    });
  }
  save(task) {
    this.transaction(() => {
      const saved = this.db.prepare('SELECT removed,status FROM attempts WHERE id=?').get(task.id);
      if (!saved || saved.removed || !ACTIVE.has(saved.status)) return;
      this.assert(task);
      this.db.prepare('UPDATE attempts SET status=?,payload=? WHERE id=?').run(task.status, JSON.stringify(task), task.id);
      if (!ACTIVE.has(task.status)) { this.db.prepare('DELETE FROM leases WHERE attempt=? AND token=?').run(task.id, task.executionToken); this.localLeases.delete(task.id); }
      else this.db.prepare('UPDATE leases SET expires=? WHERE attempt=? AND token=?').run(Date.now() + 90000, task.id, task.executionToken);
    });
  }
  recover(task) {
    this.transaction(() => {
      if (this.live(task)) return;
      this.db.prepare('UPDATE attempts SET status=?,payload=? WHERE id=? AND removed=0').run(task.status, JSON.stringify(task), task.id);
      this.db.prepare('DELETE FROM leases WHERE attempt=?').run(task.id);
    });
  }
  heartbeat() {
    for (const [id, token] of this.localLeases) this.db.prepare('UPDATE leases SET expires=? WHERE attempt=? AND token=?').run(Date.now() + 90000, id, token);
  }
  attemptRoot(task, create = false) {
    if (!/^[a-f0-9]{64}$/.test(task.workspaceKey || '') || !/^[a-f0-9-]{36}$/.test(task.id || '')) throw fail('SYNC_ATTEMPT_ID');
    const path = this.directory(`workspaces/${task.workspaceKey}/attempts/${task.id}`);
    if (create) { mkdirSync(join(path, 'reports'), { recursive: true }); mkdirSync(join(path, 'outputs'), { recursive: true }); }
    return path;
  }
  file(task, name) {
    if (!/^[\w.-]+$/.test(name) || ['.', '..'].includes(name)) throw fail('SYNC_ARTIFACT_NAME');
    const folder = /^(?:code-\d+|discussion-\d+|summary-\d+|code-diffs|discussion-diffs)\.(?:md|json)$/.test(name) ? 'reports' : 'outputs';
    return this.directory(relative(this.root, name === 'manifest.json' ? join(this.attemptRoot(task), name) : join(this.attemptRoot(task), folder, name)));
  }
  objectPath(workspace, digest) {
    if (!/^[a-f0-9]{64}$/.test(workspace) || !/^[a-f0-9]{64}$/.test(digest)) throw fail('SYNC_OBJECT_ID');
    return this.directory(`workspaces/${workspace}/objects/${digest.slice(0, 2)}/${digest}`);
  }
  putObject(task, logicalId, bytes) {
    const digest = hash(bytes), path = this.objectPath(task.workspaceKey, digest);
    mkdirSync(dirname(path), { recursive: true });
    try { if (!readFileSync(path).equals(bytes)) throw fail('SYNC_OBJECT_HASH'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = path + '.' + randomUUID() + '.tmp';
      try { writeFileSync(temporary, bytes, { flag: 'wx' }); try { linkSync(temporary, path); } catch (error) { if (error.code !== 'EEXIST') throw error; if (!readFileSync(path).equals(bytes)) throw fail('SYNC_OBJECT_HASH'); } }
      finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    this.db.prepare('INSERT OR IGNORE INTO objects VALUES(?,?,?,?)').run(task.workspaceKey, digest, bytes.length, Date.now());
    this.db.prepare('INSERT OR IGNORE INTO refs VALUES(?,?,?,?)').run(task.id, logicalId, task.workspaceKey, digest);
    return digest;
  }
  putEvidence(task, id, value, kind = 'text') {
    return this.transaction(() => {
      this.assert(task);
      if (this.db.prepare('SELECT 1 FROM evidence WHERE attempt=? AND id=?').get(task.id, id)) throw fail('ARTIFACT_DUPLICATE');
      let descriptor;
      if (kind === 'json') {
        const visit = (item, key = '') => {
          if (typeof item === 'string' && ['base', 'target', 'final', 'working', 'content'].includes(key)) return { $syncBlob: this.putObject(task, id, Buffer.from(item)) };
          if (Array.isArray(item)) return item.map(value => visit(value));
          if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value, key)]));
          return item;
        };
        descriptor = { kind, template: visit(value) };
      } else if (kind === 'fragment' || kind === 'segments') descriptor = { kind, ...value };
      else descriptor = { kind: 'text', hash: this.putObject(task, id, Buffer.isBuffer(value) ? value : Buffer.from(value)) };
      this.db.prepare('INSERT INTO evidence VALUES(?,?,?)').run(task.id, id, JSON.stringify(descriptor));
      return descriptor;
    });
  }
  readEvidence(task, id, visited = new Set()) {
    if (visited.has(id)) throw fail('SYNC_EVIDENCE_CYCLE'); visited.add(id);
    const row = this.db.prepare('SELECT e.payload FROM evidence e JOIN attempts a ON a.id=e.attempt WHERE e.attempt=? AND e.id=? AND a.removed=0').get(task.id, id);
    if (!row) throw fail('ARTIFACT_DENIED', 404);
    const descriptor = JSON.parse(row.payload);
    const read = digest => {
      const path = this.objectPath(task.workspaceKey, digest), bytes = readFileSync(path);
      if (hash(bytes) !== digest) throw fail('ARTIFACT_HASH_MISMATCH');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    };
    if (descriptor.kind === 'text') return read(descriptor.hash);
    if (descriptor.kind === 'fragment') {
      const source = this.readEvidence(task, descriptor.sourceId, visited);
      return JSON.stringify({ ...descriptor.metadata, text: source.slice(descriptor.metadata.start, descriptor.metadata.end) });
    }
    if (descriptor.kind === 'segments') return descriptor.parts.map(part => typeof part === 'string' ? part : this.readEvidence(task, part.sourceId, new Set(visited)).slice(part.start, part.end)).join('');
    const visit = value => {
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && value.$syncBlob) return read(value.$syncBlob);
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
      return value;
    };
    return JSON.stringify(visit(descriptor.template));
  }
  artifact(task, name, { logicalId } = {}) {
    return this.transaction(() => {
      this.assert(task);
      const existing = this.db.prepare('SELECT * FROM artifacts WHERE attempt=? AND name=?').get(task.id, name);
      if (existing) return { artifactId: existing.id, fileName: existing.name };
      const id = randomUUID(), path = logicalId ? null : relative(this.attemptRoot(task), this.file(task, name)).replaceAll('\\', '/');
      this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)').run(id, task.id, path, name, logicalId || null);
      return { artifactId: id, fileName: name };
    });
  }
  readArtifact(task, id) {
    const row = this.db.prepare('SELECT f.* FROM artifacts f JOIN attempts a ON a.id=f.attempt WHERE f.id=? AND f.attempt=? AND a.removed=0').get(id, task.id);
    if (!row) throw fail('SYNC_ARTIFACT_NOT_FOUND', 404);
    const text = row.logical_id ? this.readEvidence(task, row.logical_id) : readFileSync(this.file(task, row.name), 'utf8');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw fail('SYNC_PREVIEW_TOO_LARGE', 413);
    return { text, content: text, fileName: row.name };
  }
  remove(task, { wholeTask = false } = {}) {
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT * FROM attempts WHERE scope=? AND removed=0 AND ' + (wholeTask ? 'task_id=?' : 'id=?')).all(task.scopeKey, wholeTask ? task.taskId : task.id);
      for (const row of rows) {
        const saved = JSON.parse(row.payload);
        if (ACTIVE.has(row.status) && this.live(saved) && !this.owned(saved)) throw fail('SYNC_STORAGE_BUSY');
        this.db.prepare('UPDATE attempts SET removed=1 WHERE id=?').run(row.id);
        this.db.prepare('DELETE FROM leases WHERE attempt=?').run(row.id); this.localLeases.delete(row.id);
        this.db.prepare('DELETE FROM refs WHERE attempt=?').run(row.id);
      }
      return rows.map(row => JSON.parse(row.payload));
    });
  }
  cleanup(task) {
    const row = this.db.prepare('SELECT removed FROM attempts WHERE id=?').get(task.id);
    if (!row?.removed) throw fail('SYNC_DELETE_ACTIVE');
    const target = this.attemptRoot(task);
    if (!inside(this.root, target) || target === this.root) throw fail('SYNC_DELETE_PATH');
    rmSync(target, { recursive: true, force: true });
    this.db.prepare('DELETE FROM evidence WHERE attempt=?').run(task.id);
    this.db.prepare('DELETE FROM artifacts WHERE attempt=?').run(task.id);
    const tombstone = Object.fromEntries(['id', 'taskId', 'scopeKey', 'workspaceKey', 'workspaceId', 'requirementId', 'snapshotDir', 'status'].map(key => [key, task[key]]));
    this.db.prepare('UPDATE attempts SET payload=?,removed=2 WHERE id=? AND removed>0').run(JSON.stringify(tombstone), task.id);
  }
  deleted(workspaceKey) {
    return this.db.prepare('SELECT a.payload FROM attempts a JOIN scopes s ON s.key=a.scope WHERE s.workspace=? AND a.removed=1').all(workspaceKey).map(row => JSON.parse(row.payload));
  }
  collect(workspaceKey, graceMs = 3600000) {
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT o.* FROM objects o WHERE workspace=? AND created<=? AND NOT EXISTS(SELECT 1 FROM refs r WHERE r.workspace=o.workspace AND r.hash=o.hash)').all(workspaceKey, Date.now() - graceMs);
      let bytes = 0;
      for (const row of rows) { try { unlinkSync(this.objectPath(workspaceKey, row.hash)); } catch (error) { if (error.code !== 'ENOENT') throw error; } this.db.prepare('DELETE FROM objects WHERE workspace=? AND hash=?').run(workspaceKey, row.hash); bytes += row.bytes; }
      let orphanCount = 0;
      const root = this.directory(`workspaces/${workspaceKey}/objects`);
      try {
        for (const shard of readdirSync(root, { withFileTypes: true })) {
          if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
          const folder = this.directory(relative(this.root, join(root, shard.name)));
          for (const name of readdirSync(folder)) {
            if (!/^[a-f0-9]{64}(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name)) continue;
            const path = this.directory(relative(this.root, join(folder, name))), stat = lstatSync(path);
            if (!stat.isFile() || stat.mtimeMs > Date.now() - graceMs) continue;
            if (this.db.prepare('SELECT 1 FROM objects WHERE workspace=? AND hash=?').get(workspaceKey, name)) continue;
            unlinkSync(path); bytes += stat.size; orphanCount++;
          }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { objects: rows.length + orphanCount, bytes };
    });
  }
  usage(workspaceKey) {
    const objects = this.db.prepare('SELECT COALESCE(SUM(bytes),0) bytes,COUNT(*) count FROM objects WHERE workspace=?').get(workspaceKey);
    const reclaimable = this.db.prepare('SELECT COALESCE(SUM(bytes),0) bytes FROM objects o WHERE workspace=? AND NOT EXISTS(SELECT 1 FROM refs r WHERE r.workspace=o.workspace AND r.hash=o.hash)').get(workspaceKey);
    const visit = path => {
      let bytes = 0;
      try { for (const entry of readdirSync(path, { withFileTypes: true })) { const full = this.directory(relative(this.root, join(path, entry.name))); if (entry.isSymbolicLink()) throw fail('SYNC_STORAGE_LINK'); bytes += entry.isDirectory() ? visit(full) : statSync(full).size; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return bytes;
    };
    const files = visit(this.directory(`workspaces/${workspaceKey}/attempts`));
    const physicalObjects = visit(this.directory(`workspaces/${workspaceKey}/objects`));
    return { objectBytes: objects.bytes, objectCount: objects.count, artifactBytes: files, physicalBytes: physicalObjects + files, reclaimableBytes: reclaimable.bytes + Math.max(0, physicalObjects - objects.bytes) };
  }
  prune(workspaceKey, { retentionDays = 0, retainedAttempts = 0, capacityBytes = 0 } = {}) {
    const tasks = this.db.prepare('SELECT a.payload FROM attempts a JOIN scopes s ON s.key=a.scope WHERE s.workspace=? AND a.removed=0 ORDER BY a.rowid DESC').all(workspaceKey).map(row => JSON.parse(row.payload));
    const protectedVersions = new Set(), removed = [];
    for (const task of tasks) if (task.publishState === 'state_committed') {
      const key = task.scopeKey + ':' + task.docType;
      if (!protectedVersions.has(key)) { protectedVersions.add(key); protectedVersions.add(task.id); }
    }
    const eligible = tasks.filter(task => !ACTIVE.has(task.status) && !protectedVersions.has(task.id));
    for (const task of [...eligible].reverse()) {
      const old = retentionDays > 0 && (task.completedAt || task.startedAt) < Date.now() - retentionDays * 86400000;
      const excess = retainedAttempts > 0 && tasks.indexOf(task) >= retainedAttempts;
      const full = capacityBytes > 0 && this.usage(workspaceKey).physicalBytes > capacityBytes;
      if (old || excess || full) { removed.push(...this.remove(task)); this.cleanup(task); }
    }
    return removed;
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
