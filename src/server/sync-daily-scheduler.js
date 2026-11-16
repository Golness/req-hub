import { createWorkspaceTaskAgent } from './workspace-task-agent.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import time from '../shared/time.cjs';
import { digest } from './knowledge-v2/contracts.js';
import { dailyClock } from './daily-clock.js';
import { listSyncBranches } from './sync-branches.js';
import { syncCancellation } from './sync-cancellation.js';
import { parseBranchName } from './utils.js';
import { findRequirementDir } from './doc-reader.js';
import { safeDocumentPath } from './safe-path.js';
import { syncSupervisor } from './sync-supervisor.js';
import { getSyncHistory } from './sync-state.js';
import { larkPushFailure, pushSyncArtifacts } from './lark-scheduled-push.js';

/**
 * Validate daily quick-sync configuration without changing repository state.
 * @param config - Effective profile settings.
 * @returns Normalized clock, offset and username; invalid settings throw.
 */
export function syncSchedule(config) {
  const values = {
    enabled: config.sync?.dailyUpdateEnabled ?? false,
    time: config.sync?.dailyUpdateTime ?? '03:00',
    timeZone: time.configTimeZone(config),
    days: config.sync?.dailyOffsetDays ?? 1,
    username: config.defaultUsername?.trim() || '',
  };
  if (
    typeof values.enabled !== 'boolean' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.time) ||
    !Number.isSafeInteger(values.days) ||
    values.days < 0 ||
    values.days > 365 ||
    !/^(?!\.)(?!.*\.\.)[^\s\\/~^:?*\[\]\x00-\x20\x7f]{0,64}$/.test(values.username)
  ) {
    throw new Error('SYNC_SCHEDULE_INVALID');
  }
  dailyClock(values.timeZone, new Date(0));
  return values;
}

/**
 * Match exactly the configured calendar day, with an optional literal username component.
 * @param branch - Local branch name.
 * @param day - YYYY-MM-DD in the schedule zone.
 * @param username - Optional single path component; no glob interpretation.
 * @returns Whether this is a scheduled feature branch.
 */
export function matchesScheduledBranch(branch, day, username) {
  const prefix = `feature/${username ? username + '/' : ''}${day}-`;
  return (
    branch.startsWith(prefix) &&
    branch.length > prefix.length &&
    !branch.slice(prefix.length).includes('/')
  );
}

/**
 * Invoke the quick-sync handler and consume events without retaining its entire stream.
 * @param routes - Existing Host sync route definitions.
 * @param input - Authorized workspace, requirement and target branch.
 * @param parent - Same-workspace Host agent used for delegation.
 * @param signal - Batch cancellation, propagated through preparation and children.
 * @param onEvent - Synchronous persisted-progress callback.
 * @returns Terminal response and the latest snapshot of each document task.
 */
export async function runScheduledQuickSync(routes, input, parent, signal, onEvent) {
  const listeners = {};
  const req = {
    method: 'POST',
    headers: { 'x-session-id': parent.session.id },
    operationExec: { agent: parent, signal },
    on(name, callback) {
      listeners[name] = callback;
    },
    destroy() {},
  };
  let value;
  const tasks = new Map();
  const eventReceived = (event) => {
    if (event.sync?.id) {
      tasks.set(event.sync.id, event.sync);
    }
    onEvent(event);
  };
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headersSent = true;
      this.headers = headers;
    },
    write(text) {
      for (const line of String(text).split('\n')) {
        if (line.startsWith('data: ')) {
          const event = JSON.parse(line.slice(6));
          eventReceived(event);
          value = event;
        }
      }
    },
    end(text) {
      if (text) {
        value = JSON.parse(String(text));
        if (value.sync) {
          eventReceived({ type: 'state', sync: value.sync, quickSync: value.quickSync });
        }
      }
      this.writableEnded = true;
    },
  };
  signal.throwIfAborted();
  await routes.find((route) => route.path === '/req-hub/phased-sync').handler(req, res);
  if (listeners.data) {
    listeners.data(JSON.stringify({ ...input, quick: true, requestId: randomUUID() }));
    await listeners.end();
  }
  signal.throwIfAborted();
  if (value?.skipped) {
    const history = await getSyncHistory(input.workspaceId, input.requirementId);
    for (const docType of ['requirement', 'design']) {
      const prior = history.find(
        (task) =>
          task.docType === docType &&
          task.branchName === input.targetBranch &&
          task.status === 'completed',
      );
      if (prior && ![...tasks.values()].some((task) => task.docType === docType)) {
        tasks.set(prior.id, prior);
      }
    }
  }
  return { status: res.statusCode, value, tasks: [...tasks.values()] };
}

/** Own one abortable daily batch, processing registered workspaces and branches in sequence. */
export class SyncDailyScheduler {
  constructor({
    registry,
    knowledge,
    reports,
    routes,
    lark = null,
    configLoader = loadConfig,
    clock = () => new Date(),
    listBranches = listSyncBranches,
    runQuick = runScheduledQuickSync,
  }) {
    Object.assign(this, {
      registry,
      knowledge,
      reports,
      routes,
      lark,
      configLoader,
      clock,
      listBranches,
      runQuick,
    });
    this.pending = Promise.resolve();
    this.generation = 0;
    this.state = { state: 'not_started' };
  }
  refresh() {
    if (this.closed) {
      return Promise.resolve();
    }
    clearTimeout(this.timer);
    this.controller?.abort(new Error('SYNC_SCHEDULE_CANCELLED'));
    this.controller = new AbortController();
    const generation = ++this.generation;
    const signal = this.controller.signal;
    this.pending = this.pending
      .catch(() => {
        // A failed clock turn must not prevent a later explicit reconfiguration.
      })
      .then(async () => {
        try {
          await this.check(signal);
        } catch (error) {
          if (!signal.aborted) {
            this.state = { state: 'error', errorCode: error.message };
          }
        } finally {
          if (!this.closed && generation === this.generation) {
            this.timer = setTimeout(() => this.refresh(), 30000);
            this.timer.unref?.();
          }
        }
      });
    return this.pending;
  }
  async check(signal) {
    signal.throwIfAborted();
    const config = await this.configLoader();
    const settings = syncSchedule(config);
    // The push flag is deliberately excluded from syncSchedule()'s digest, so
    // toggling it never resets the activation day and skips a scheduled run.
    const pushEnabled = config.sync?.larkPushEnabled === true && !!this.lark;
    this.state = { ...settings, state: settings.enabled ? 'enabled' : 'disabled' };
    const time = this.clock();
    const current = dailyClock(settings.timeZone, time);
    const key = digest(settings);
    let control = this.reports.db
      .prepare('SELECT * FROM reqhub_sync_daily_control WHERE owner=?')
      .get(this.reports.owner);
    if (control?.config_hash !== key) {
      this.reports.db
        .prepare(
          'INSERT INTO reqhub_sync_daily_control VALUES (?,?,?) ON CONFLICT(owner) DO UPDATE SET config_hash=excluded.config_hash,activated_at=excluded.activated_at',
        )
        .run(this.reports.owner, key, time.toISOString());
      control = { activated_at: time.toISOString() };
    }
    const activated = dailyClock(settings.timeZone, new Date(control.activated_at));
    const [hour, minute] = settings.time.split(':').map(Number);
    const due = hour * 60 + minute;
    const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    if (
      !settings.enabled ||
      minutes(current.minute) < due ||
      current.date < activated.date ||
      (current.date === activated.date && minutes(activated.minute) >= due)
    ) {
      return;
    }
    const targetDay = new Date(Date.parse(current.date + 'T12:00:00Z') - settings.days * 86400000)
      .toISOString()
      .slice(0, 10);
    const { report, created } = this.reports.begin('sync', current.date, {
      ...settings,
      targetDay,
    });
    if (!created && !this.reports.resume(report.id)) {
      // A completed/partial report already owns this calendar day.
      return;
    }
    try {
      for (const workspace of this.registry.list()) {
        signal.throwIfAborted();
        try {
          const branches = (
            await syncCancellation.run(signal, () => this.listBranches(workspace.path))
          )
            .filter((branch) => matchesScheduledBranch(branch, targetDay, settings.username))
            .sort();
          if (!branches.length) {
            this.reports.item(report.id, workspace, 'workspace', {
              kind: 'workspace',
              status: 'skipped',
            });
          }
          for (const branch of branches) {
            signal.throwIfAborted();
            this.reports.item(report.id, workspace, branch, {
              kind: 'branch',
              branch,
              status: 'queued',
              tasks: [],
            });
            let owner;
            let requirementDirectory = null;
            let branchDocsRoot = null;
            try {
              let result;
              do {
                await syncSupervisor.waitAvailable(signal);
                const store = await this.knowledge.scope(workspace.id);
                await owner?.dispose();
                owner = await createWorkspaceTaskAgent(
                  this.knowledge.ctx,
                  store.scope.workspace,
                  signal,
                );
                const parent = owner.agent;
                const parsed = parseBranchName(branch);
                if (!parsed) {
                  throw new Error('SYNC_BRANCH_INVALID');
                }
                const docsRoot = await safeDocumentPath(workspace.path, config.docsDir || 'docs', {
                  allowMissing: true,
                });
                branchDocsRoot = docsRoot;
                let directory = await findRequirementDir(docsRoot, parsed.requirementId);
                if (!directory) {
                  directory = await safeDocumentPath(
                    docsRoot,
                    join(parsed.developer || '', parsed.requirementId),
                    { allowMissing: true },
                  );
                  signal.throwIfAborted();
                  await mkdir(directory, { recursive: true });
                }
                requirementDirectory = directory;
                const tasks = new Map();
                result = await this.runQuick(
                  this.routes,
                  {
                    workspaceId: workspace.id,
                    requirementId: parsed.requirementId,
                    targetBranch: branch,
                  },
                  parent,
                  signal,
                  (event) => {
                    signal.throwIfAborted();
                    if (event.sync?.id) {
                      tasks.set(event.sync.id, event.sync);
                    }
                    this.reports.item(report.id, workspace, branch, {
                      status: 'running',
                      tasks: [...tasks.values()],
                      quickSync: event.quickSync,
                    });
                  },
                );
              } while (result.status === 409 && result.value?.active);
              signal.throwIfAborted();
              const completed = result.value?.type === 'done' || result.value?.skipped === true;
              const failed = result.status >= 400 || !completed;
              this.reports.item(report.id, workspace, branch, {
                status: failed ? 'failed' : result.value?.skipped ? 'skipped' : 'completed',
                error: result.value?.error || (failed ? 'SYNC_SCHEDULE_INCOMPLETE' : undefined),
                ...(result.tasks ? { tasks: result.tasks } : {}),
              });
              // Publication is a follow-up effect: a Lark failure must never
              // turn a successful document sync into a failed branch.
              if (pushEnabled && !failed && !result.value?.skipped && requirementDirectory) {
                try {
                  await pushSyncArtifacts({
                    lark: this.lark,
                    config,
                    workspaceId: workspace.id,
                    docsRoot: branchDocsRoot,
                    directory: requirementDirectory,
                    keyPrefix: branch,
                    signal,
                    onItem: (key, item) => this.reports.item(report.id, workspace, key, item),
                  });
                } catch (error) {
                  this.reports.item(report.id, workspace, `lark:${branch}:fatal`, {
                    kind: 'lark',
                    status: 'failed',
                    error: larkPushFailure(error).code,
                  });
                }
              }
            } catch (error) {
              this.reports.item(report.id, workspace, branch, {
                status: signal.aborted ? 'cancelled' : 'failed',
                error: error.message,
              });
              signal.throwIfAborted();
            } finally {
              await owner?.dispose();
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          // Plain folders, removed checkouts and nested repositories are not
          // sync targets. They must not turn the whole day's report partial.
          const benign = [
            'SYNC_WORKSPACE_NOT_REPOSITORY',
            'SYNC_WORKSPACE_REPOSITORY_MISMATCH',
          ].includes(error.message);
          this.reports.item(report.id, workspace, 'workspace', {
            kind: 'workspace',
            status: benign ? 'skipped' : 'failed',
            ...(benign ? { reason: error.message } : { error: error.message }),
          });
        }
      }
    } finally {
      this.reports.finish(report.id, signal.aborted ? 'cancelled' : undefined);
    }
  }
  beginClose() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller?.abort(new Error('SYNC_SCHEDULE_CANCELLED'));
  }
  async close() {
    this.beginClose();
    await this.pending;
  }
}
