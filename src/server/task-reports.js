import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest, fail } from './knowledge-v2/contracts.js';
import { configFilePath } from './config.js';
import { json } from './utils.js';

const ACTIVE = new Set(['queued', 'running']);

/** Persistent scheduled-run reports; individual items survive cancellation and process restart. */
export class TaskReports {
  constructor(
    registry,
    { directory = dirname(configFilePath()), ownerKey = configFilePath() } = {},
  ) {
    this.registry = registry;
    this.owner = digest(ownerKey);
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'task-reports.sqlite'));
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS reqhub_reports(id TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,day TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(owner,kind,day));
      CREATE TABLE IF NOT EXISTS reqhub_report_items(report_id TEXT NOT NULL,workspace_id TEXT NOT NULL,item_key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(report_id,workspace_id,item_key));
      CREATE TABLE IF NOT EXISTS reqhub_report_sources(report_id TEXT NOT NULL,scope_id TEXT NOT NULL,document_id TEXT NOT NULL,version INTEGER NOT NULL,workspace_id TEXT NOT NULL,PRIMARY KEY(report_id,scope_id,document_id,version));
      CREATE TABLE IF NOT EXISTS reqhub_sync_daily_control(owner TEXT PRIMARY KEY,config_hash TEXT NOT NULL,activated_at TEXT NOT NULL);
    `);
      for (const row of this.db
        .prepare('SELECT payload FROM reqhub_reports WHERE owner=?')
        .all(this.owner)) {
        const report = JSON.parse(row.payload);
        if (report.status === 'running') {
          report.status = 'interrupted';
          report.completedAt = new Date().toISOString();
          this.stopItems(report.id, 'interrupted');
          this.save(report);
        }
      }
    } catch (cause) {
      // A failed constructor never reaches the plugin owner; release its native handle here.
      try {
        this.db.close();
      } catch (error) {
        throw new AggregateError([cause, error], 'ReqHub report initialization failed');
      }
      throw cause;
    }
  }
  save(report) {
    this.db
      .prepare('UPDATE reqhub_reports SET payload=? WHERE id=? AND owner=?')
      .run(JSON.stringify(report), report.id, this.owner);
    return report;
  }
  stopItems(id, status) {
    for (const row of this.db
      .prepare('SELECT workspace_id,item_key,payload FROM reqhub_report_items WHERE report_id=?')
      .all(id)) {
      const item = JSON.parse(row.payload);
      if (['running', 'queued', 'waiting_session'].includes(item.status)) {
        item.status = status;
        this.db
          .prepare(
            'UPDATE reqhub_report_items SET payload=? WHERE report_id=? AND workspace_id=? AND item_key=?',
          )
          .run(JSON.stringify(item), id, row.workspace_id, row.item_key);
      }
    }
  }
  begin(kind, day, metadata = {}) {
    const existing = this.db
      .prepare('SELECT payload FROM reqhub_reports WHERE owner=? AND kind=? AND day=?')
      .get(this.owner, kind, day);
    if (existing) {
      return { report: JSON.parse(existing.payload), created: false };
    }
    const report = {
      id: randomUUID(),
      kind,
      day,
      ...metadata,
      status: 'running',
      startedAt: new Date().toISOString(),
      dispatched: false,
    };
    this.db
      .prepare('INSERT INTO reqhub_reports VALUES (?,?,?,?,?)')
      .run(report.id, this.owner, kind, day, JSON.stringify(report));
    return { report, created: true };
  }
  get(id) {
    const row = this.db
      .prepare('SELECT payload FROM reqhub_reports WHERE id=? AND owner=?')
      .get(id, this.owner);
    if (!row) {
      fail('REPORT_NOT_FOUND', 404);
    }
    return JSON.parse(row.payload);
  }
  /**
   * Reopen today's interrupted or cancelled run so a later scheduler tick can
   * finish it instead of losing the whole day to a restart or reconfiguration.
   * @param id - Report identity.
   * @returns The reopened report, or null when the run is already terminal.
   */
  resume(id) {
    const report = this.get(id);
    if (!['interrupted', 'cancelled'].includes(report.status)) {
      return null;
    }
    report.status = 'running';
    report.dispatched = false;
    delete report.completedAt;
    for (const row of this.db
      .prepare('SELECT workspace_id,item_key,payload FROM reqhub_report_items WHERE report_id=?')
      .all(id)) {
      const item = JSON.parse(row.payload);
      if (
        !['queued', 'running', 'waiting_session', 'cancelled', 'interrupted'].includes(item.status)
      ) {
        continue;
      }
      // The next tick re-reports every workspace it processes; stale in-flight
      // items must not keep the report permanently in the running state.
      item.status = 'skipped';
      item.updatedAt = new Date().toISOString();
      this.db
        .prepare(
          'UPDATE reqhub_report_items SET payload=? WHERE report_id=? AND workspace_id=? AND item_key=?',
        )
        .run(JSON.stringify(item), id, row.workspace_id, row.item_key);
    }
    return this.save(report);
  }
  item(id, workspace, key, value) {
    const report = this.get(id);
    if (['interrupted', 'cancelled'].includes(report.status)) {
      return;
    }
    const old = this.db
      .prepare(
        'SELECT payload FROM reqhub_report_items WHERE report_id=? AND workspace_id=? AND item_key=?',
      )
      .get(id, workspace.id, key);
    this.db
      .prepare(
        'INSERT INTO reqhub_report_items VALUES (?,?,?,?) ON CONFLICT(report_id,workspace_id,item_key) DO UPDATE SET payload=excluded.payload',
      )
      .run(
        id,
        workspace.id,
        key,
        JSON.stringify({
          ...(old ? JSON.parse(old.payload) : {}),
          key,
          workspaceId: workspace.id,
          workspaceTitle:
            workspace.title || (old ? JSON.parse(old.payload).workspaceTitle : workspace.id),
          ...value,
          updatedAt: new Date().toISOString(),
        }),
      );
    if (report.dispatched) {
      this.reconcile(id);
    }
  }
  rows(id, visible = false) {
    const allowed = new Set(this.registry.list().map((workspace) => workspace.id));
    return this.db
      .prepare(
        'SELECT payload FROM reqhub_report_items WHERE report_id=? ORDER BY workspace_id,item_key',
      )
      .all(id)
      .map((row) => JSON.parse(row.payload))
      .filter((item) => !visible || allowed.has(item.workspaceId));
  }
  stats(items) {
    return {
      workspaces: new Set(items.map((item) => item.workspaceId)).size,
      total: items.filter((item) => item.kind !== 'workspace' || item.status !== 'skipped').length,
      succeeded: items.filter(
        (item) =>
          item.kind !== 'workspace' && ['completed', 'published', 'skipped'].includes(item.status),
      ).length,
      failed: items.filter((item) =>
        ['failed', 'aborted', 'cancelled', 'interrupted', 'rejected', 'rolled_back'].includes(
          item.status,
        ),
      ).length,
      pending: items.filter(
        (item) =>
          ![
            'completed',
            'published',
            'skipped',
            'failed',
            'aborted',
            'cancelled',
            'interrupted',
            'rejected',
            'rolled_back',
          ].includes(item.status),
      ).length,
      documents: items.filter((item) => item.kind === 'document').length,
      sessions: items.filter((item) => item.kind === 'session').length,
      branches: items.filter((item) => item.kind === 'branch').length,
    };
  }
  reconcile(id) {
    const report = this.get(id);
    if (['interrupted', 'cancelled'].includes(report.status)) {
      return report;
    }
    const rows = this.rows(id);
    report.stats = this.stats(rows);
    if (report.dispatched) {
      if (rows.some((item) => ACTIVE.has(item.status))) {
        report.status = 'running';
      } else if (rows.some((item) => item.status === 'waiting_session')) {
        report.status = 'waiting_session';
      } else if (!report.stats.failed && rows.some((item) => item.status === 'pending_review')) {
        report.status = 'pending_review';
      } else {
        report.status = report.stats.failed ? 'partial' : 'completed';
        report.completedAt = new Date().toISOString();
      }
    }
    return this.save(report);
  }
  finish(id, status) {
    const report = this.get(id);
    report.dispatched = true;
    if (status) {
      report.status = status;
      report.completedAt = new Date().toISOString();
      this.stopItems(id, status);
    }
    this.save(report);
    return this.reconcile(id);
  }
  knowledgeSource(id, store, source) {
    const version = Number(String(source.revision).replace(/^rev-/, ''));
    this.db
      .prepare('INSERT OR IGNORE INTO reqhub_report_sources VALUES (?,?,?,?,?)')
      .run(id, store.scope.scopeId, source.id, version, store.scope.workspaceId);
    const workspace = store.scope.workspace;
    const relativePath = source.origin.relativePath || null;
    const prior = this.rows(id).find(
      (item) => item.workspaceId === workspace.id && item.documentIds?.includes(source.id),
    );
    this.item(id, workspace, prior?.key || 'source:' + source.id, {
      kind: source.kind === 'session' ? 'session' : 'document',
      documentId: source.id,
      title: source.title || relativePath,
      path: relativePath,
      sourceVersion: version,
      source: source.origin.provider,
      sessionId: source.origin.sessionId,
      originWorkspace: workspace.title,
      status: 'queued',
    });
  }
  knowledgeJob(job) {
    if (job.kind !== 'ingest') {
      return;
    }
    for (const id of job.sourceIds || []) {
      const version = Number(String(job.sourceRevisions?.[id]).replace(/^rev-/, ''));
      if (!Number.isSafeInteger(version)) {
        continue;
      }
      for (const link of this.db
        .prepare(
          'SELECT s.* FROM reqhub_report_sources s JOIN reqhub_reports r ON r.id=s.report_id WHERE r.owner=? AND s.scope_id=? AND s.document_id=? AND s.version=?',
        )
        .all(this.owner, job.scopeId, id, version)) {
        const key =
          this.rows(link.report_id).find(
            (item) => item.workspaceId === link.workspace_id && item.documentId === id,
          )?.key || 'source:' + id;
        this.item(link.report_id, { id: link.workspace_id }, key, {
          status: job.status,
          jobId: job.id,
          error: job.error,
        });
      }
    }
  }
  detail(id) {
    const report = this.get(id);
    const rows = this.rows(id, true);
    const workspaces = [];
    for (const row of rows) {
      let group = workspaces.find((item) => item.id === row.workspaceId);
      if (!group) {
        group = { id: row.workspaceId, title: row.workspaceTitle, items: [] };
        workspaces.push(group);
      }
      group.items.push(row);
    }
    return { ...report, stats: this.stats(rows), workspaces };
  }
  close() {
    this.db.close();
  }
  routes() {
    return [
      {
        kind: 'exact',
        path: '/req-hub/task-reports',
        handler: (req, res) => {
          try {
            if (req.method !== 'GET') {
              return json(res, { error: 'REPORT_READ_ONLY' }, 405);
            }
            const input = new URL(req.url, 'http://localhost').searchParams;
            if (input.get('id')) {
              return json(res, this.detail(input.get('id')));
            }
            const kind = input.get('kind');
            const cursor = Number(input.get('cursor') || 0);
            if (
              !['knowledge', 'sync'].includes(kind) ||
              !Number.isSafeInteger(cursor) ||
              cursor < 0
            ) {
              fail('REPORT_INVALID_INPUT');
            }
            const rows = this.db
              .prepare(
                'SELECT payload FROM reqhub_reports WHERE owner=? AND kind=? ORDER BY day DESC,id DESC LIMIT 31 OFFSET ?',
              )
              .all(this.owner, kind, cursor);
            const items = rows.slice(0, 30).map((row) => {
              const report = JSON.parse(row.payload);
              return { ...report, stats: this.stats(this.rows(report.id, true)) };
            });
            return json(res, { items, nextCursor: rows.length > 30 ? cursor + 30 : null });
          } catch (error) {
            return json(
              res,
              { error: /^REPORT_/.test(error.message) ? error.message : 'REPORT_FAILED' },
              error.status || 500,
            );
          }
        },
      },
    ];
  }
}
