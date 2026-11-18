import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig } from '../config.js';
import { dailyClock } from '../daily-clock.js';
import { LIMITS } from './contracts.js';
import {
  dailySettings,
  syncSettings,
  syncSettingsVersion,
  validateSyncSettings,
} from './sync-settings.js';
import { syncWorkspaceSessions } from './session-sync.js';
import { larkPushFailure, pushKnowledgeArtifacts } from '../lark-scheduled-push.js';

/**
 * Own Knowledge V2 save-debounce and daily synchronization without request state.
 */
export class KnowledgeSyncScheduler {
  constructor({
    application,
    configLoader = loadConfig,
    configSaver = saveConfig,
    lark = null,
    onError,
  }) {
    this.application = application;
    this.configLoader = configLoader;
    this.configSaver = configSaver;
    this.lark = lark;
    this.onError = onError;
    this.autoTimers = new Map();
    this.dailyTimer = null;
    this.dailyRunning = new Set();
    this.completedDays = new Map();
    this.states = new Map();
    this.tasks = new Set();
    this.controller = new AbortController();
    this.closed = false;
  }

  track(promise) {
    this.tasks.add(promise);
    promise
      .finally(() => this.tasks.delete(promise))
      .catch((error) => {
        if (!this.closed) {
          this.onError?.(error);
        }
      });
    return promise;
  }

  /** Report writes are diagnostics; a busy report store must not abort a scheduled sync. */
  reportSafe(action, ...args) {
    const reports = this.application.reports;
    if (!reports || typeof reports[action] !== 'function') {
      return null;
    }
    try {
      return reports[action](...args);
    } catch (error) {
      if (!this.closed) {
        this.onError?.(error);
      }
      return null;
    }
  }

  state(workspaceId) {
    return (
      this.states.get(workspaceId) || {
        state: 'idle',
        lastRunAt: null,
        lastDate: null,
        error: null,
      }
    );
  }

  async settings(workspaceId) {
    const config = await this.configLoader();
    const values = syncSettings(config);
    return {
      values,
      version: syncSettingsVersion(values, config.general.timeZone),
      schedule: this.state(workspaceId),
    };
  }

  async saveSettings(workspaceId, { expectedVersion, values }) {
    const config = await this.configLoader();
    const current = syncSettings(config);
    const version = syncSettingsVersion(current, config.general.timeZone);
    if (expectedVersion !== version) {
      throw Object.assign(new Error('KB_SETTINGS_CONFLICT'), {
        code: 'KB_SETTINGS_CONFLICT',
        status: 409,
      });
    }
    const next = validateSyncSettings({ ...current, ...values });
    await this.configSaver({ ...config, knowledgeV2: { ...config.knowledgeV2, ...next } });
    await this.refresh();
    return this.settings(workspaceId);
  }

  async start() {
    await this.refresh();
  }

  async refresh() {
    const config = await this.configLoader();
    const values = syncSettings(config);
    const schedule = dailySettings(values, config.general.timeZone);
    clearTimeout(this.dailyTimer);
    this.dailyTimer = null;
    if (!values.autoManage) {
      for (const pending of this.autoTimers.values()) {
        clearTimeout(pending.timer);
      }
      this.autoTimers.clear();
    }
    if (schedule.enabled && !this.closed) {
      this.armDaily();
    }
    return this.state();
  }

  armDaily() {
    if (this.closed || this.dailyTimer) {
      return;
    }
    const delay = Math.max(100, 60000 - (Date.now() % 60000));
    this.dailyTimer = setTimeout(() => {
      this.dailyTimer = null;
      this.track(
        this.runDue().finally(() => {
          if (!this.closed) {
            this.armDaily();
          }
        }),
      );
    }, delay);
    this.dailyTimer.unref?.();
  }

  async runDue(now = new Date()) {
    if (this.closed) {
      return [];
    }
    const config = await this.configLoader();
    const schedule = dailySettings(syncSettings(config), config.general.timeZone);
    if (!schedule.enabled) {
      return [];
    }
    const current = dailyClock(schedule.timeZone, now);
    const due = Number(schedule.time.slice(0, 2)) * 60 + Number(schedule.time.slice(3, 5));
    const minutes = Number(current.minute.slice(0, 2)) * 60 + Number(current.minute.slice(3, 5));
    // Catch up when the Host was busy or restarted just after the exact minute.
    // An exact equality check silently loses the whole day in that case.
    if (minutes < due) {
      return [];
    }
    // The report store persists the day marker across restarts, so a late or
    // repeated tick cannot run the same batch twice.
    const began = this.reportSafe('begin', 'knowledge', current.date, {
      timeZone: schedule.timeZone,
    });
    let reportId = null;
    if (began?.report) {
      if (!began.created && !this.reportSafe('resume', began.report.id)) {
        return [];
      }
      reportId = began.report.id;
    }
    const results = [];
    try {
      for (const workspace of this.application.registry.list()) {
        if (
          this.completedDays.get(workspace.id) === current.date ||
          this.dailyRunning.has(workspace.id)
        ) {
          continue;
        }
        if (reportId) {
          this.reportSafe('item', reportId, workspace, 'workspace', {
            kind: 'workspace',
            status: 'running',
          });
        }
        this.dailyRunning.add(workspace.id);
        const task = this.runDaily(workspace.id, current.date, {
          signal: this.controller.signal,
          reportId,
        })
          .then((result) => {
            this.completedDays.set(workspace.id, current.date);
            this.states.set(workspace.id, {
              state: result.fileFailed ? 'error' : 'idle',
              lastRunAt: new Date().toISOString(),
              lastDate: current.date,
              error: result.failed ? 'KB_SYNC_PARTIAL_FAILED' : null,
              result,
            });
            if (reportId) {
              this.reportSafe('item', reportId, workspace, 'workspace', {
                kind: 'workspace',
                status: result.failed ? 'partial' : 'completed',
                result,
              });
            }
            return result;
          })
          .catch((error) => {
            this.states.set(workspace.id, {
              state: 'error',
              lastRunAt: new Date().toISOString(),
              lastDate: current.date,
              error: error.code || error.message,
            });
            if (reportId) {
              this.reportSafe('item', reportId, workspace, 'workspace', {
                kind: 'workspace',
                status: 'failed',
                error: error.code || error.message,
              });
            }
            if (!this.closed) {
              this.onError?.(error);
            }
            return {
              workspaceId: workspace.id,
              failed: 1,
              fileFailed: 1,
              error: error.code || error.message,
            };
          })
          .finally(() => this.dailyRunning.delete(workspace.id));
        results.push(await task);
      }
    } finally {
      if (reportId) {
        this.reportSafe('finish', reportId);
      }
    }
    return results;
  }

  async runDaily(workspaceId, date, { signal, reportId } = {}) {
    const store = await this.application.scope(workspaceId);
    const manifest = await store.sources();
    const paths = manifest.sources
      .filter((source) => source.kind === 'file' && source.status !== 'excluded')
      .map((source) => source.origin.relativePath);
    const sourceIds = new Set();
    let fileFailed = 0;
    let sessionFailed = 0;
    let sessions = { sessions: 0, saved: 0, skipped: 0, failed: 0 };
    for (let offset = 0; offset < paths.length; offset += LIMITS.batchFiles) {
      signal?.throwIfAborted();
      const batch = paths.slice(offset, offset + LIMITS.batchFiles);
      const result = await this.application.importFiles(store, {
        files: batch.map((relativePath) => ({ relativePath })),
        requestKey: `daily:${workspaceId}:${date}:${offset}`,
        ingest: false,
        signal,
      });
      fileFailed += result.failed;
      for (const item of result.results.filter(
        (entry) => ['saved', 'skipped'].includes(entry.status) && entry.sourceId,
      )) {
        sourceIds.add(item.sourceId);
      }
    }
    const config = await this.configLoader();
    const settings = syncSettings(config);
    if (dailySettings(settings, config.general.timeZone).importConversations) {
      try {
        sessions = await syncWorkspaceSessions(this.application, store, {
          signal,
          onItem: (item) => {
            if (!reportId) {
              return;
            }
            this.reportSafe(
              'item',
              reportId,
              store.scope.workspace,
              `session:${item.sessionId || 'batch'}`,
              item,
            );
          },
        });
        sessionFailed += sessions.failed;
        for (const id of sessions.sourceIds) {
          sourceIds.add(id);
        }
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        // Page sessions, the session library or an adapter may be unavailable.
        // File imports above still have to reach the Wiki compile step.
        sessionFailed += 1;
        sessions = { ...sessions, failed: sessions.failed + 1 };
        if (!this.closed) {
          this.onError?.(error);
        }
      }
    }
    if (reportId && sourceIds.size) {
      const latest = await store.sources();
      for (const id of sourceIds) {
        const source = latest.sources.find((item) => item.id === id);
        if (source) {
          this.reportSafe('knowledgeSource', reportId, store, source);
        }
      }
    }
    const job = sourceIds.size
      ? await this.application.enqueueCompile(store, 'ingest', [...sourceIds])
      : null;
    if (reportId && job) {
      this.reportSafe('bindKnowledgeJob', reportId, job);
      if (store.jobs) {
        const current = (await store.jobs()).jobs.find((item) => item.id === job.id);
        if (current) {
          this.reportSafe('knowledgeJob', current);
        }
      }
    }
    let larkPush = null;
    if (this.lark && settings.larkPushEnabled === true) {
      // Pushing the release is a follow-up effect. A Lark outage must not
      // mark the file/session synchronization itself as failed.
      try {
        larkPush = await pushKnowledgeArtifacts({
          lark: this.lark,
          config,
          store,
          workspaceId,
          signal,
          waitForCompile: async () => {
            if (!job?.id || !this.application.queue?.waitFor) {
              return;
            }
            await this.application.queue.waitFor(store, job.id, { signal, timeoutMs: 120000 });
          },
          onItem: (key, item) => {
            if (reportId) {
              this.reportSafe('item', reportId, store.scope.workspace, key, item);
            }
          },
        });
      } catch (error) {
        larkPush = { pushed: 0, skipped: 0, failed: 1, generationId: null };
        if (reportId) {
          this.reportSafe('item', reportId, store.scope.workspace, `lark:${workspaceId}:fatal`, {
            kind: 'lark',
            status: 'failed',
            error: larkPushFailure(error).code,
          });
        }
        if (!this.closed) {
          this.onError?.(error);
        }
      }
    }
    return {
      workspaceId,
      date,
      files: paths.length,
      ...sessions,
      failed: fileFailed + sessionFailed,
      fileFailed,
      sessionFailed,
      sourceIds: [...sourceIds],
      job,
      larkPush,
    };
  }

  async capture(workspaceId, relativePath) {
    if (this.closed) {
      return { state: 'closed' };
    }
    const config = await this.configLoader();
    const settings = syncSettings(config);
    if (!settings.autoManage) {
      return { state: 'deferred' };
    }
    const store = await this.application.scope(workspaceId);
    const key = store.scope.scopeId;
    const pending = this.autoTimers.get(key) || {
      workspaceId,
      paths: new Set(),
      timer: null,
    };
    clearTimeout(pending.timer);
    pending.paths.add(relativePath);
    pending.timer = setTimeout(() => {
      this.autoTimers.delete(key);
      this.track(this.flushAutomatic(workspaceId, [...pending.paths], this.controller.signal));
    }, settings.autoManageDelayMs);
    pending.timer.unref?.();
    this.autoTimers.set(key, pending);
    return { state: 'scheduled', delayMs: settings.autoManageDelayMs };
  }

  async flushAutomatic(workspaceId, paths, signal) {
    const store = await this.application.scope(workspaceId);
    const result = await this.application.importFiles(store, {
      files: paths.map((relativePath) => ({ relativePath })),
      requestKey: 'automatic:' + randomUUID(),
      ingest: false,
      signal,
    });
    const sourceIds = result.results
      .filter((item) => item.status === 'saved')
      .map((item) => item.sourceId);
    if (sourceIds.length) {
      result.job = await this.application.enqueueCompile(store, 'ingest', sourceIds);
    }
    return result;
  }

  /** Stop timers and cancel producers without waiting for sibling owners. */
  beginClose() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.dailyTimer);
    for (const pending of this.autoTimers.values()) {
      clearTimeout(pending.timer);
    }
    this.autoTimers.clear();
    this.controller.abort(Object.assign(new Error('KB_CLOSED'), { code: 'KB_CLOSED' }));
  }

  async close() {
    this.beginClose();
    await Promise.allSettled([...this.tasks]);
  }
}
