import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configFilePath, loadConfig } from './config.js';
import { safeDocumentPath } from './safe-path.js';
import { readReplicaFile } from './document-file.js';
export { readReplicaFile } from './document-file.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const fingerprint = (info) =>
  [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });

/**
 * Own metadata-only docs discovery and a durable, serial Lark outbox.
 * Local files remain authoritative; remote versions are never overwritten or deleted.
 * @param options - Workspace registry, owned publisher and optional isolated storage/config.
 * @returns A lifecycle-owned service; start must precede production of new artifacts.
 */
export class DocumentReplicas {
  constructor({
    registry,
    lark,
    directory = dirname(configFilePath()),
    configLoader = loadConfig,
  }) {
    Object.assign(this, { registry, lark, configLoader });
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'document-replicas.sqlite'));
    try {
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS files(root TEXT NOT NULL,path TEXT NOT NULL,payload TEXT NOT NULL,
          PRIMARY KEY(root,path));
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.controller = new AbortController();
    this.pending = Promise.resolve();
    this.publication = Promise.resolve();
    this.publicationScopes = new Set();
    this.scanErrors = new Map();
  }

  /** Start metadata discovery without reading or uploading the historical baseline. */
  async start() {
    await this.refresh();
  }

  settings(config) {
    return {
      enabled: config.documents?.larkSyncEnabled === true,
      interval: config.documents?.scanIntervalMs ?? 10000,
      maxBytes: config.documents?.maxFileBytes ?? 100_000_000,
      maxFiles: config.documents?.maxFiles ?? 100000,
    };
  }

  async scope(workspaceId, config) {
    const workspace = this.registry.list().find((item) => item.id === workspaceId);
    if (!workspace) {
      throw failure('DOCUMENT_WORKSPACE_MISSING', 404);
    }
    const workspaceRoot = await realpath(workspace.path);
    const target = await safeDocumentPath(workspaceRoot, config.docsDir || 'docs', {
      allowMissing: true,
    });
    const root = await realpath(target).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return target;
    });
    return { workspace, root, id: hash(JSON.stringify([workspace.id, root])) };
  }

  save(scope, path, value) {
    this.db
      .prepare('INSERT OR REPLACE INTO files VALUES(?,?,?)')
      .run(scope.id, path, JSON.stringify(value));
  }

  get(scope, path) {
    const row = this.db
      .prepare('SELECT payload FROM files WHERE root=? AND path=?')
      .get(scope.id, path);
    return row ? JSON.parse(row.payload) : null;
  }

  /** Serialize discovery, explicit commits, retries and publication under one owner. */
  run(operation) {
    if (this.controller.signal.aborted) {
      return Promise.reject(failure('DOCUMENT_SERVICE_CLOSED', 503));
    }
    const work = this.pending.then(async () => {
      this.controller.signal.throwIfAborted();
      return operation();
    });
    this.pending = work.catch(() => {
      // Each caller receives its own failure; later recovery must remain possible.
    });
    return work;
  }

  async inventory(scope, limit) {
    const found = new Map();
    const visit = async (path = '') => {
      this.controller.signal.throwIfAborted();
      const directory = path ? await safeDocumentPath(scope.root, path) : scope.root;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        this.controller.signal.throwIfAborted();
        if (entry.isSymbolicLink()) {
          continue;
        }
        const child = path ? join(path, entry.name) : entry.name;
        if (entry.isDirectory()) {
          await visit(child);
        } else if (entry.isFile()) {
          if (found.size >= limit) {
            throw failure('DOCUMENT_SCAN_LIMIT');
          }
          const target = await safeDocumentPath(scope.root, child);
          found.set(child, fingerprint(await stat(target, { bigint: true })));
        }
      }
    };
    await visit();
    return found;
  }

  /** Establish or resume the no-backfill boundary, then discover stable changes. */
  async scan(scope, config) {
    const settings = this.settings(config);
    const stored = this.db.prepare('SELECT payload FROM roots WHERE id=?').get(scope.id);
    const control = stored ? JSON.parse(stored.payload) : {};
    if (!settings.enabled) {
      this.db
        .prepare('INSERT OR REPLACE INTO roots VALUES(?,?)')
        .run(scope.id, JSON.stringify({ ...control, enabled: false }));
      return;
    }
    const entries = await this.inventory(scope, settings.maxFiles);
    if (!control.enabled) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const [path, value] of entries) {
          const previous = this.get(scope, path);
          this.save(scope, path, {
            ...previous,
            fingerprint: value,
            candidate: null,
            hash: previous?.fingerprint === value ? previous.hash : null,
            status:
              previous?.fingerprint === value && previous.hash ? previous.status : 'historical',
          });
        }
        this.db
          .prepare('INSERT OR REPLACE INTO roots VALUES(?,?)')
          .run(scope.id, JSON.stringify({ enabled: true, activatedAt: Date.now() }));
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      return;
    }
    for (const [path, value] of entries) {
      const previous = this.get(scope, path);
      if (previous?.fingerprint === value) {
        continue;
      }
      if (previous?.candidate !== value) {
        this.save(scope, path, { ...previous, candidate: value, status: 'settling' });
        continue;
      }
      try {
        await this.captureNow(scope, path, config, previous?.source || 'docs');
      } catch (error) {
        this.controller.signal.throwIfAborted();
        this.save(scope, path, {
          ...previous,
          candidate: value,
          status: 'failed',
          error: error.code || 'DOCUMENT_READ_FAILED',
        });
      }
    }
    for (const row of this.db
      .prepare('SELECT path,payload FROM files WHERE root=?')
      .all(scope.id)) {
      if (!entries.has(row.path)) {
        const value = JSON.parse(row.payload);
        this.save(scope, row.path, { ...value, status: 'missing', candidate: null });
      }
    }
  }

  async captureNow(scope, path, config, source) {
    const settings = this.settings(config);
    const file = await readReplicaFile(scope.root, path, settings.maxBytes, this.controller.signal);
    const digest = hash(file.bytes);
    const previous = this.get(scope, path);
    this.save(scope, path, {
      ...previous,
      fingerprint: file.fingerprint,
      candidate: null,
      source,
      hash: digest,
      bytes: file.bytes.length,
      status:
        previous?.hash === digest && previous?.result?.version === digest ? 'saved' : 'queued',
      error: null,
      attempts: previous?.hash === digest ? previous.attempts || 0 : 0,
      retryAt: 0,
      updatedAt: Date.now(),
    });
  }

  /**
   * Register an already committed artifact without making remote failure a save failure.
   * @param workspaceId - Authorized producing workspace.
   * @param path - Relative docs path.
   * @param source - Stable producer kind.
   * @returns Local registration result; no remote operation is awaited.
   */
  committed(workspaceId, path, source = 'docs') {
    return this.run(async () => {
      const config = await this.configLoader();
      if (!this.settings(config).enabled) {
        return { status: 'disabled' };
      }
      const scope = await this.scope(workspaceId, config);
      await this.captureNow(scope, path, config, source);
      return { status: this.get(scope, path).status };
    }).catch((error) => {
      const code = error.code || 'DOCUMENT_REGISTER_FAILED';
      this.scanErrors.set(workspaceId, code);
      return { status: 'failed', error: code };
    });
  }

  async drain(scope, config) {
    if (!this.settings(config).enabled) {
      return;
    }
    const binding = hash(JSON.stringify([config.lark, config.larkTargets?.[scope.workspace.id]]));
    for (const row of this.db
      .prepare('SELECT path,payload FROM files WHERE root=?')
      .all(scope.id)) {
      this.controller.signal.throwIfAborted();
      let value = JSON.parse(row.payload);
      if (!value.hash || ['historical', 'missing', 'settling'].includes(value.status)) {
        continue;
      }
      if (value.status === 'publishing') {
        this.save(scope, row.path, {
          ...value,
          status: 'uncertain',
          error: 'DOCUMENT_REMOTE_UNCERTAIN',
        });
        continue;
      }
      if (value.binding !== binding && value.status !== 'uncertain') {
        value = { ...value, status: 'queued', attempts: 0, retryAt: 0 };
      }
      if (value.status === 'saved' || value.status === 'uncertain' || value.retryAt > Date.now()) {
        continue;
      }
      try {
        const current = await this.configLoader();
        if (!this.settings(current).enabled) {
          return;
        }
        if (
          binding !==
          hash(JSON.stringify([current.lark, current.larkTargets?.[scope.workspace.id]]))
        ) {
          return;
        }
        if ((await this.scope(scope.workspace.id, current)).id !== scope.id) {
          return;
        }
        const file = await readReplicaFile(
          scope.root,
          row.path,
          this.settings(config).maxBytes,
          this.controller.signal,
        );
        if (hash(file.bytes) !== value.hash) {
          this.save(scope, row.path, {
            ...value,
            fingerprint: null,
            status: 'settling',
            candidate: file.fingerprint,
          });
          continue;
        }
        const latest = this.get(scope, row.path);
        if (
          latest?.hash !== value.hash ||
          ['settling', 'missing', 'historical'].includes(latest.status)
        ) {
          continue;
        }
        // Persist the intent before remote creation. A crash cannot safely prove that no upload occurred.
        this.save(scope, row.path, { ...value, status: 'publishing', binding });
        const result = await this.lark.pushReplica({
          workspaceId: scope.workspace.id,
          path: row.path,
          bytes: file.bytes,
          version: value.hash,
          expectedBinding: binding,
          signal: this.controller.signal,
        });
        this.controller.signal.throwIfAborted();
        const latestAfter = this.get(scope, row.path);
        if (latestAfter?.hash === value.hash && latestAfter.status === 'publishing') {
          this.save(scope, row.path, {
            ...value,
            status: 'saved',
            binding,
            result,
            error: null,
            savedAt: Date.now(),
          });
        }
      } catch (error) {
        this.controller.signal.throwIfAborted();
        const code = /^LARK_|^DOCUMENT_/.test(error.message)
          ? error.message
          : 'DOCUMENT_PUSH_FAILED';
        const attempts = (value.attempts || 0) + 1;
        const latestAfter = this.get(scope, row.path);
        if (latestAfter?.hash !== value.hash || latestAfter.status !== 'publishing') {
          continue;
        }
        this.save(scope, row.path, {
          ...value,
          binding,
          status: code === 'DOCUMENT_REMOTE_UNCERTAIN' ? 'uncertain' : 'failed',
          error: code,
          attempts,
          retryAt: Date.now() + Math.min(3600000, 10000 * 2 ** Math.min(attempts, 8)),
        });
      }
    }
  }

  /** Poll filesystem metadata; timers never outlive the owning plugin. */
  refresh() {
    clearTimeout(this.timer);
    return this.run(async () => {
      const config = await this.configLoader();
      for (const workspace of this.registry.list()) {
        try {
          const scope = await this.scope(workspace.id, config);
          await this.scan(scope, config);
          if (!this.publicationScopes.has(scope.id)) {
            this.publicationScopes.add(scope.id);
            this.publication = this.publication
              .then(async () => {
                if (!this.controller.signal.aborted) {
                  await this.drain(scope, await this.configLoader());
                }
              })
              .catch((error) => {
                if (!this.controller.signal.aborted) {
                  this.scanErrors.set(workspace.id, error.code || 'DOCUMENT_PUSH_FAILED');
                }
              })
              .finally(() => this.publicationScopes.delete(scope.id));
          }
          this.scanErrors.delete(workspace.id);
        } catch (error) {
          this.controller.signal.throwIfAborted();
          this.scanErrors.set(workspace.id, error.code || 'DOCUMENT_SCAN_FAILED');
        }
      }
      if (!this.controller.signal.aborted) {
        this.timer = setTimeout(() => {
          void this.refresh().catch(() => {
            // Shutdown owns cancellation; request failures remain visible in persisted state.
          });
        }, this.settings(config).interval);
        this.timer.unref?.();
      }
    });
  }

  /** Return bounded workspace-local records; callers paginate with an offset. */
  list(workspaceId, offset = 0) {
    return this.run(async () => {
      const config = await this.configLoader();
      const scope = await this.scope(workspaceId, config);
      const rows = this.db
        .prepare('SELECT path,payload FROM files WHERE root=? ORDER BY path LIMIT 101 OFFSET ?')
        .all(scope.id, offset);
      return {
        enabled: this.settings(config).enabled,
        scanError: this.scanErrors.get(workspaceId) || null,
        items: rows.slice(0, 100).map((row) => ({ path: row.path, ...JSON.parse(row.payload) })),
        nextOffset: rows.length > 100 ? offset + 100 : null,
      };
    });
  }

  /** Retry only a known failed local version; uncertain remote writes require reconciliation. */
  retry(workspaceId, path) {
    return this.run(async () => {
      const config = await this.configLoader();
      const scope = await this.scope(workspaceId, config);
      const value = this.get(scope, path);
      if (!value?.hash || value.status !== 'failed') {
        throw failure(
          value?.status === 'uncertain' ? 'DOCUMENT_REMOTE_UNCERTAIN' : 'DOCUMENT_NOT_MANAGED',
          409,
        );
      }
      this.save(scope, path, { ...value, status: 'queued', retryAt: 0 });
      return { queued: true };
    });
  }

  beginClose() {
    clearTimeout(this.timer);
    this.controller.abort(failure('DOCUMENT_SERVICE_CLOSED', 503));
  }

  close() {
    return (this.closing ||= (async () => {
      this.beginClose();
      await this.pending;
      await this.publication;
      this.db.close();
    })());
  }
}
