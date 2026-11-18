import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configFilePath, loadConfig } from './config.js';
import { dailyClock } from './daily-clock.js';
import { readReplicaFile, documentMetadata, readDocumentText } from './document-file.js';
import { safeDocumentPath } from './safe-path.js';
import { atomicWrite, withDocumentLock } from './sync-document-validator.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, status = 400) => {
  throw Object.assign(new Error(code), { code, status });
};
const payload = (row) => row && JSON.parse(row.payload);
const textFile = /\.(md|markdown|txt|json|ya?ml|html?|csv|xml|log|[cm]?js|tsx?|css|sql)$/i;

/**
 * Return the previous calendar date without assuming a 24-hour zoned day.
 * @param day - Strict ISO calendar date.
 * @returns Previous ISO calendar date; invalid dates reject.
 */
export function previousDay(day) {
  const date = new Date(day + 'T12:00:00Z');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== day
  ) {
    fail('DAILY_INPUT_INVALID');
  }
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Preserve the real requirement path, including its optional author prefix.
 * @param path - Authorized relative artifact path.
 * @returns Dated requirement path, or an empty shared-files group.
 */
export function requirementGroup(path) {
  const parts = path.replaceAll('\\', '/').split('/');
  const index = parts.findIndex((part) => /^\d{4}-\d{2}-\d{2}[-_].+/.test(part));
  return index < 0 ? '' : parts.slice(0, index + 1).join('/');
}

/**
 * Own file references and serialized, restart-safe daily brief jobs. Source bodies are never stored.
 * Collection is independent of Feishu; close aborts and awaits scanning and generation.
 */
export class DailyReports {
  /** @param options - Registry, profile storage, config loader, clock and model adapter. */
  constructor({
    registry,
    directory = dirname(configFilePath()),
    configLoader = loadConfig,
    now = () => new Date(),
    generateBrief,
    onBrief,
    knowledgeFile,
  }) {
    Object.assign(this, { registry, configLoader, now, generateBrief, onBrief, knowledgeFile });
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'daily-reports.sqlite'));
    try {
      this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS daily_files(id TEXT PRIMARY KEY, scope TEXT, path TEXT,
        day TEXT, payload TEXT);
      CREATE INDEX IF NOT EXISTS daily_files_day ON daily_files(day,scope);
      CREATE TABLE IF NOT EXISTS daily_seen(id TEXT PRIMARY KEY,payload TEXT);
      CREATE TABLE IF NOT EXISTS daily_errors(id TEXT PRIMARY KEY,scope TEXT,payload TEXT);
      CREATE TABLE IF NOT EXISTS daily_briefs(id TEXT PRIMARY KEY,payload TEXT);`);
      if (
        this.db
          .prepare('PRAGMA table_info(daily_files)')
          .all()
          .some((column) => column.name === 'bytes')
      ) {
        this.db.exec('PRAGMA secure_delete=ON; ALTER TABLE daily_files DROP COLUMN bytes;');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.controller = new AbortController();
    this.pending = Promise.resolve();
    this.execution = Promise.resolve();
    this.refreshing = Promise.resolve();
    this.scanErrors = new Map();
    this.active = false;
  }

  run(action) {
    const next = this.pending.then(() => {
      this.controller.signal.throwIfAborted();
      return action();
    });
    this.pending = next.catch(() => {});
    return next;
  }

  async scope(workspaceId, config) {
    const workspace = this.registry.list().find((item) => item.id === workspaceId);
    if (!workspace) {
      fail('DAILY_WORKSPACE_MISSING', 404);
    }
    const workspaceRoot = await realpath(workspace.path);
    const root = await safeDocumentPath(workspaceRoot, config.docsDir || 'docs', {
      allowMissing: true,
    });
    return { workspace, root, id: hash(JSON.stringify([workspace.id, workspaceRoot, root])) };
  }

  /** Register a committed file even when remote replication is disabled. */
  committed(workspaceId, path, source = 'docs') {
    return this.run(async () => {
      const config = await this.configLoader();
      const scope = await this.scope(workspaceId, config);
      try {
        return await this.capture(scope, path, source, config);
      } catch (error) {
        this.controller.signal.throwIfAborted();
        const normalized = typeof path === 'string' ? path.replaceAll('\\', '/') : '';
        this.db
          .prepare('INSERT OR REPLACE INTO daily_errors VALUES(?,?,?)')
          .run(
            hash(JSON.stringify([scope.id, normalized])),
            scope.id,
            JSON.stringify({ workspaceId, code: error.code || 'DAILY_CAPTURE_FAILED' }),
          );
        throw error;
      }
    });
  }

  async capture(scope, path, source, config, observedAt) {
    this.controller.signal.throwIfAborted();
    path = path.replaceAll('\\', '/');
    const key = hash(JSON.stringify([scope.id, path]));
    const before = payload(this.db.prepare('SELECT payload FROM daily_seen WHERE id=?').get(key));
    const file = await documentMetadata(scope.root, path, this.controller.signal);
    const version = hash(file.version);
    if (before?.version === version) {
      this.db.prepare('DELETE FROM daily_errors WHERE id=?').run(key);
      // Upgrade discovery attribution without manufacturing a second file version.
      if (source !== 'docs') {
        for (const row of this.db
          .prepare('SELECT id,payload FROM daily_files WHERE scope=? AND path=?')
          .all(scope.id, path)) {
          const item = payload(row);
          if (item.version === version && !item.sources.includes(source)) {
            item.sources.push(source);
            this.db
              .prepare('UPDATE daily_files SET payload=? WHERE id=?')
              .run(JSON.stringify(item), row.id);
          }
        }
      }
      return;
    }
    const seen = { version, excluded: source === 'daily-brief' || before?.excluded === true };
    if (!seen.excluded) {
      const at = observedAt || this.now().toISOString();
      const day = dailyClock(config.general?.timeZone || 'Asia/Shanghai', new Date(at)).date;
      const item = {
        id: randomUUID(),
        workspaceId: scope.workspace.id,
        workspaceTitle: scope.workspace.title || scope.workspace.name || scope.workspace.id,
        scope: scope.id,
        kind: 'file',
        path,
        group: requirementGroup(path),
        version,
        day,
        at,
        size: file.size,
        sources: [source],
        change: before ? 'modified' : 'new',
        observed: !!observedAt,
      };
      this.db
        .prepare('INSERT INTO daily_files VALUES(?,?,?,?,?)')
        .run(item.id, scope.id, path, day, JSON.stringify(item));
    }
    this.controller.signal.throwIfAborted();
    this.db.prepare('INSERT OR REPLACE INTO daily_seen VALUES(?,?)').run(key, JSON.stringify(seen));
    this.db.prepare('DELETE FROM daily_errors WHERE id=?').run(key);
  }

  /** Record references to published Wiki pages without duplicating their bodies. */
  published(workspaceId, page, group, release) {
    return this.run(async () => {
      const config = await this.configLoader();
      const scope = await this.scope(workspaceId, config);
      const path = 'wiki/' + page.pageId + '.md';
      const item = {
        id: randomUUID(),
        workspaceId,
        workspaceTitle: scope.workspace.title || workspaceId,
        scope: scope.id,
        kind: 'knowledge',
        path,
        group,
        release,
        knowledgeScopeId: page.knowledgeScopeId,
        pageId: page.pageId,
        sources: ['knowledge'],
        at: this.now().toISOString(),
      };
      const location = await this.knowledgeFile(item);
      const file = await documentMetadata(location.root, location.path, this.controller.signal);
      item.observedVersion = hash(file.version);
      item.version = page.hash || item.observedVersion;
      item.size = file.size;
      item.day = dailyClock(config.general?.timeZone || 'Asia/Shanghai', new Date(item.at)).date;
      const key = hash(JSON.stringify([scope.id, 'knowledge', path]));
      const before = payload(this.db.prepare('SELECT payload FROM daily_seen WHERE id=?').get(key));
      if (before?.version === item.version) {
        for (const row of this.db
          .prepare('SELECT id,payload FROM daily_files WHERE scope=? AND path=?')
          .all(scope.id, path)) {
          const previous = payload(row);
          if (previous.kind === 'knowledge' && previous.version === item.version) {
            this.db
              .prepare('UPDATE daily_files SET payload=? WHERE id=?')
              .run(
                JSON.stringify({ ...previous, release, observedVersion: item.observedVersion }),
                row.id,
              );
          }
        }
        return;
      }
      item.change = before ? 'modified' : 'new';
      this.db
        .prepare('INSERT INTO daily_files VALUES(?,?,?,?,?)')
        .run(item.id, scope.id, path, item.day, JSON.stringify(item));
      this.db
        .prepare('INSERT OR REPLACE INTO daily_seen VALUES(?,?)')
        .run(key, JSON.stringify({ version: item.version }));
    });
  }

  async scan(config) {
    const zone = config.general?.timeZone || 'Asia/Shanghai';
    const yesterday = previousDay(dailyClock(zone, this.now()).date);
    for (const workspace of this.registry.list()) {
      try {
        const scope = await this.scope(workspace.id, config);
        const walk = async (directory, prefix = '') => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            this.controller.signal.throwIfAborted();
            const path = prefix + entry.name;
            if (entry.isSymbolicLink()) {
              continue;
            }
            const target = await safeDocumentPath(scope.root, path);
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
              await walk(target, path + '/');
            } else if (entry.isFile() && !entry.isSymbolicLink()) {
              const info = await stat(target);
              const stamp = [info.size, info.mtimeMs, info.ctimeMs].join(':');
              const key = hash(JSON.stringify([scope.id, path]));
              const seen = payload(
                this.db.prepare('SELECT payload FROM daily_seen WHERE id=?').get(key),
              );
              if (seen?.stamp === stamp) {
                continue;
              }
              const day = dailyClock(zone, info.mtime).date;
              // First discovery never imports older history or invents an overwritten version.
              if (seen || day >= yesterday) {
                await this.capture(
                  scope,
                  path,
                  'docs',
                  config,
                  !seen ? info.mtime.toISOString() : undefined,
                );
              }
              const next = payload(
                this.db.prepare('SELECT payload FROM daily_seen WHERE id=?').get(key),
              );
              this.db
                .prepare('INSERT OR REPLACE INTO daily_seen VALUES(?,?)')
                .run(key, JSON.stringify({ ...next, stamp }));
            }
          }
        };
        try {
          await walk(scope.root);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
        this.scanErrors.delete(workspace.id);
      } catch (error) {
        this.controller.signal.throwIfAborted();
        this.scanErrors.set(workspace.id, error.code || 'DAILY_SCAN_FAILED');
      }
    }
  }

  view(day, workspaceId) {
    return this.run(() => this.readView(day, workspaceId));
  }

  async readView(day, workspaceId) {
    const config = await this.configLoader();
    const zone = config.general?.timeZone || 'Asia/Shanghai';
    day ||= previousDay(dailyClock(zone, this.now()).date);
    previousDay(day);
    const scopes = new Map();
    const scopeErrors = [];
    for (const workspace of this.registry
      .list()
      .filter((item) => !workspaceId || item.id === workspaceId)) {
      try {
        const scope = await this.scope(workspace.id, config);
        scopes.set(scope.id, scope);
      } catch {
        scopeErrors.push([workspace.id, 'DAILY_WORKSPACE_MISSING']);
      }
    }
    const groups = new Map();
    for (const row of this.db.prepare('SELECT scope,payload FROM daily_errors').all()) {
      if (scopes.has(row.scope)) {
        const error = payload(row);
        scopeErrors.push([error.workspaceId, error.code]);
      }
    }
    for (const row of this.db
      .prepare('SELECT payload FROM daily_files WHERE day=? ORDER BY rowid')
      .all(day)) {
      const item = payload(row);
      if (!scopes.has(item.scope)) {
        continue;
      }
      const id = hash(JSON.stringify([item.scope, day, item.group]));
      if (!groups.has(id)) {
        groups.set(id, {
          id,
          workspaceId: item.workspaceId,
          workspaceTitle: item.workspaceTitle,
          group: item.group,
          files: new Map(),
        });
      }
      const identity = JSON.stringify([item.kind, item.path]);
      const previous = groups.get(id).files.get(identity);
      groups
        .get(id)
        .files.set(identity, { ...item, change: previous?.change === 'new' ? 'new' : item.change });
    }
    return {
      day,
      timeZone: zone,
      schedule: '08:00',
      currentTarget: day === previousDay(dailyClock(zone, this.now()).date),
      enabled: config.dailyReports?.enabled !== false,
      scanErrors: [...new Map([...this.scanErrors, ...scopeErrors])].filter(
        ([id]) => !workspaceId || id === workspaceId,
      ),
      groups: [...groups.values()].map((group) => {
        const files = [...group.files.values()].sort((a, b) => a.path.localeCompare(b.path));
        const digest = hash(
          JSON.stringify(files.map((file) => [file.kind, file.path, file.version])),
        );
        const brief = payload(
          this.db.prepare('SELECT payload FROM daily_briefs WHERE id=?').get(group.id),
        );
        return {
          ...group,
          files,
          digest,
          brief: brief && {
            ...brief,
            status: brief.digest !== digest ? 'stale' : brief.status,
          },
        };
      }),
    };
  }

  /**
   * Read source files only while building a brief. Missing files remain explicit metadata entries.
   * @param group - Authorized journal group.
   * @param signal - Generation owner cancellation.
   * @returns An async sequence of bounded source chunks, never persisted as journal content.
   */
  async *evidence(group, signal = this.controller.signal) {
    const config = await this.configLoader();
    const scope = await this.scope(group.workspaceId, config);
    for (const file of group.files) {
      signal.throwIfAborted();
      let location;
      let observed;
      try {
        location =
          file.kind === 'knowledge'
            ? await this.knowledgeFile(file)
            : { root: scope.root, path: file.path };
        observed = await documentMetadata(location.root, location.path, signal);
      } catch (error) {
        signal.throwIfAborted();
        yield {
          ...file,
          body: null,
          contentAvailable: false,
          fileState: 'unavailable',
          readError: error.code || 'DAILY_SOURCE_UNAVAILABLE',
        };
        continue;
      }
      const readVersion = hash(observed.version);
      const reference = {
        ...file,
        readVersion,
        fileState:
          readVersion === (file.observedVersion || file.version)
            ? 'recorded_version'
            : 'updated_since_collection',
      };
      if (!textFile.test(file.path)) {
        yield { ...reference, body: null, contentAvailable: false };
        continue;
      }
      let part = 0;
      try {
        for await (const chunk of readDocumentText(location.root, location.path, signal)) {
          if (chunk.version !== observed.version) {
            fail('DAILY_SOURCE_CHANGED', 409);
          }
          yield {
            ...reference,
            id: file.id + ':' + part++,
            body: chunk.text,
            contentAvailable: true,
          };
        }
        if (part === 0) {
          yield { ...reference, body: '', contentAvailable: true };
        }
      } catch (error) {
        signal.throwIfAborted();
        // Reject a partially read text rather than publish a claim of full coverage.
        if (part || error.code === 'DOCUMENT_FILE_CHANGED') {
          throw error;
        }
        yield { ...reference, body: null, contentAvailable: false, fileState: 'unreadable_text' };
      }
    }
  }

  saveBrief(id, brief) {
    this.db
      .prepare('INSERT OR REPLACE INTO daily_briefs VALUES(?,?)')
      .run(id, JSON.stringify(brief));
  }

  async generate(day, retryId, signal = this.controller.signal) {
    const report = await this.view(day);
    if (!report.enabled || !this.generateBrief) {
      return;
    }
    for (const group of report.groups) {
      if (retryId && group.id !== retryId) {
        continue;
      }
      if (
        group.brief?.digest === group.digest &&
        (group.brief.status === 'completed' || (group.brief.status === 'failed' && !retryId))
      ) {
        continue;
      }
      const token = randomUUID();
      const brief = { ...group.brief, digest: group.digest, status: 'running', token };
      this.saveBrief(group.id, brief);
      try {
        if (report.scanErrors.some(([id]) => !id || id === group.workspaceId)) {
          fail('DAILY_COLLECTION_INCOMPLETE', 409);
        }
        const config = await this.configLoader();
        const scope = await this.scope(group.workspaceId, config);
        const evidence = group.files;
        const reads = new Map();
        const owner = this;
        const readEvidence = async function* () {
          for await (const file of owner.evidence(group, signal)) {
            reads.set(JSON.stringify([file.kind, file.path]), {
              kind: file.kind,
              path: file.path,
              version: file.version,
              readVersion: file.readVersion,
              fileState: file.fileState,
            });
            yield file;
          }
        };
        const summary = await this.generateBrief({
          group,
          evidence,
          readEvidence,
          scope,
          config,
          day: report.day,
          signal,
        });
        signal.throwIfAborted();
        if (reads.size !== evidence.length) {
          fail('DAILY_EVIDENCE_INCOMPLETE', 409);
        }
        for (const reference of reads.values()) {
          if (!reference.readVersion) {
            continue;
          }
          const original = evidence.find(
            (file) => file.kind === reference.kind && file.path === reference.path,
          );
          const location =
            original.kind === 'knowledge'
              ? await this.knowledgeFile(original)
              : { root: scope.root, path: original.path };
          const latest = await documentMetadata(location.root, location.path, signal);
          if (hash(latest.version) !== reference.readVersion) {
            fail('DAILY_SOURCE_CHANGED', 409);
          }
        }
        if (typeof summary !== 'string' || !summary.trim() || Buffer.byteLength(summary) > 120000) {
          fail('DAILY_BRIEF_INVALID');
        }
        const fresh = await this.view(report.day, group.workspaceId);
        if (
          payload(this.db.prepare('SELECT payload FROM daily_briefs WHERE id=?').get(group.id))
            ?.token !== token
        ) {
          continue;
        }
        const currentConfig = await this.configLoader();
        if (currentConfig.dailyReports?.enabled === false) {
          fail('DAILY_MODEL_DISABLED', 409);
        }
        const currentScope = await this.scope(group.workspaceId, currentConfig);
        if (
          currentScope.id !== scope.id ||
          fresh.groups.find((item) => item.id === group.id)?.digest !== group.digest
        ) {
          this.saveBrief(group.id, { ...brief, status: 'stale' });
          continue;
        }
        const path = [group.group, 'daily-reports', report.day + '.md'].filter(Boolean).join('/');
        const target = await safeDocumentPath(scope.root, path, { allowMissing: true });
        // Source paths remain literal text; no model-supplied destination or executable markup.
        const text =
          `# ${report.day}\n\n${summary}\n\n` +
          [...reads.values()]
            .map(
              (file) =>
                `- ${file.kind}: ${JSON.stringify(file.path)} (${file.readVersion || file.version}; ${file.fileState})`,
            )
            .join('\n') +
          '\n';
        const outputLimit = Number.MAX_SAFE_INTEGER;
        if (Buffer.byteLength(text) > outputLimit) {
          fail('DAILY_INPUT_LIMIT', 413);
        }
        await withDocumentLock(target, async () => {
          signal.throwIfAborted();
          let current;
          try {
            current = await readReplicaFile(scope.root, path, outputLimit, signal);
          } catch (error) {
            if (error.code !== 'ENOENT') {
              throw error;
            }
          }
          if (current && hash(current.bytes) !== brief.outputHash) {
            fail('DAILY_OUTPUT_CONFLICT', 409);
          }
          await mkdir(dirname(target), { recursive: true });
          await safeDocumentPath(scope.root, path, { allowMissing: true });
          await this.run(() => {
            const key = hash(JSON.stringify([scope.id, path]));
            const seen = payload(
              this.db.prepare('SELECT payload FROM daily_seen WHERE id=?').get(key),
            );
            this.db
              .prepare('INSERT OR REPLACE INTO daily_seen VALUES(?,?)')
              .run(key, JSON.stringify({ ...seen, excluded: true }));
          });
          if (current) {
            await atomicWrite(target, text, signal, () => {
              signal.throwIfAborted();
              const info = statSync(target, { bigint: true });
              const fingerprint = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs]
                .map(String)
                .join(':');
              if (
                fingerprint !== current.fingerprint ||
                realpathSync(target) !== target ||
                realpathSync(scope.root) !== scope.root
              ) {
                fail('DAILY_OUTPUT_CONFLICT', 409);
              }
            });
          } else {
            signal.throwIfAborted();
            await writeFile(target, text, { flag: 'wx' });
          }
          // Exclusion is persisted before discovery can observe the output.
          await this.committed(group.workspaceId, path, 'daily-brief');
        });
        signal.throwIfAborted();
        this.saveBrief(group.id, {
          ...brief,
          status: 'completed',
          summary,
          reads: [...reads.values()],
          path,
          outputHash: hash(text),
          completedAt: this.now().toISOString(),
          error: null,
        });
        // Output consumers own their queue and errors; they cannot stall the next brief.
        const notification = Promise.resolve().then(() => this.onBrief?.(group.workspaceId, path));
        void notification.catch(() => {
          // Independent consumers retain their own failed registration status.
        });
      } catch (error) {
        if (
          payload(this.db.prepare('SELECT payload FROM daily_briefs WHERE id=?').get(group.id))
            ?.token !== token
        ) {
          continue;
        }
        if (signal.aborted) {
          this.saveBrief(group.id, { ...brief, status: 'stale', error: 'DAILY_INTERRUPTED' });
          return;
        }
        this.saveBrief(group.id, {
          ...brief,
          status: 'failed',
          error: error.code || 'DAILY_GENERATION_FAILED',
        });
      }
    }
  }

  /** Scan first, then schedule yesterday once per input version after 08:00 in the configured zone. */
  refresh() {
    clearTimeout(this.timer);
    const next = this.refreshing.then(() => this.refreshNow());
    this.refreshing = next.catch(() => {});
    return next;
  }

  async refreshNow() {
    clearTimeout(this.timer);
    await this.run(async () => this.scan(await this.configLoader()));
    const config = await this.configLoader();
    this.controller.signal.throwIfAborted();
    const policy = hash(
      JSON.stringify([config.dailyReports, config.docsDir, config.general?.timeZone]),
    );
    if (this.policy && this.policy !== policy && this.active) {
      this.jobController.abort();
      await this.execution;
    }
    this.policy = policy;
    const clock = dailyClock(config.general?.timeZone || 'Asia/Shanghai', this.now());
    if (clock.minute >= '08:00' && !this.active) {
      this.enqueue(previousDay(clock.date));
    }
    if (!this.controller.signal.aborted) {
      const minuteBoundary = 60000 - (this.now().valueOf() % 60000);
      this.timer = setTimeout(
        () => {
          void this.refresh().catch((error) => {
            if (!this.controller.signal.aborted) {
              this.scanErrors.set('', error.code || 'DAILY_SCAN_FAILED');
            }
          });
        },
        Math.min(config.dailyReports?.scanIntervalMs ?? 60000, minuteBoundary),
      );
      this.timer.unref?.();
    }
  }

  enqueue(day, id) {
    this.controller.signal.throwIfAborted();
    if (this.active) {
      fail('DAILY_BUSY', 409);
    }
    this.active = true;
    this.jobController = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, this.jobController.signal]);
    this.execution = this.generate(day, id, signal)
      .catch((error) => {
        if (!this.controller.signal.aborted) {
          this.scanErrors.set('', error.code || 'DAILY_GENERATION_FAILED');
        }
      })
      .finally(() => {
        this.active = false;
      });
  }

  beginClose() {
    clearTimeout(this.timer);
    this.controller.abort();
  }

  /** Abort all producers before closing SQLite; repeated disposal shares the same promise. */
  close() {
    this.beginClose();
    this.closing ||= Promise.all([this.refreshing, this.pending, this.execution]).then(() =>
      this.db.close(),
    );
    return this.closing;
  }
}
