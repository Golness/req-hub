import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installWorkspaceTaskAgents } from '../helpers/workspace-task-agent.js';
import { TaskReports } from '../../src/server/task-reports.js';
import { SyncDailyScheduler } from '../../src/server/sync-daily-scheduler.js';
import { KnowledgeSyncScheduler } from '../../src/server/knowledge-v2/sync-scheduler.js';
import { DEFAULT_SYNC_SETTINGS } from '../../src/server/knowledge-v2/sync-settings.js';
import { listSyncBranches } from '../../src/server/sync-branches.js';

/**
 * Reproduces the observed 2026-11-13/14 task-reports.sqlite history: seven
 * registered workspaces, one plain (non-Git) folder, scheduled time 04:00.
 */
const WORKSPACES = [
  'req-hub',
  'dms-module-oa',
  'dms-system',
  'dms-module-supply',
  'dms-marketing',
  'dms-infra',
  'blank',
];
const BRANCH = 'feature/lihanping/2026-11-13-供应商系统-包材报价';

let root, workspaces, registry, reports, knowledge, config, now, runQuick, listBranches, lark;
let scheduler;
let kbReports;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'req-hub-schedule-repair-')));
  workspaces = WORKSPACES.map((id) => ({ id, title: id, path: join(root, id) }));
  for (const workspace of workspaces) {
    await mkdir(workspace.path, { recursive: true });
  }
  registry = { list: () => workspaces };
  reports = new TaskReports(registry, { directory: join(root, 'reports') });
  config = {
    docsDir: 'docs',
    defaultUsername: 'lihanping',
    sync: { dailyUpdateEnabled: true, dailyUpdateTime: '04:00', dailyOffsetDays: 1 },
  };
  // 03:59 Asia/Shanghai; due() advances one minute to 04:00.
  now = new Date('2026-11-13T19:59:00Z');
  knowledge = {
    ctx: installWorkspaceTaskAgents({ agents: {} }),
    scope: async (workspaceId) => ({
      scope: { workspace: workspaces.find((item) => item.id === workspaceId) },
    }),
    close: async () => {},
  };
  runQuick = vi.fn(async (_routes, input, _parent, signal, event) => {
    signal.throwIfAborted();
    const workspace = workspaces.find((item) => item.id === input.workspaceId);
    const directory = join(workspace.path, 'docs', 'lihanping', input.requirementId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'requirement.md'), '# 需求\n\n正文', 'utf8');
    event({ type: 'done', sync: { id: 'task-1', status: 'completed' } });
    return { status: 200, value: { type: 'done' }, tasks: [] };
  });
  listBranches = vi.fn(async (path) => {
    if (path.endsWith('blank')) {
      // Exactly the failure recorded in the real history: fatal: not a git repository.
      throw new Error('SYNC_WORKSPACE_NOT_REPOSITORY');
    }
    return [BRANCH];
  });
  lark = {
    pushDocuments: vi.fn(async ({ documents }) => ({
      results: documents.map((document) => ({
        name: document.name,
        path: [...document.segments, document.name].join(' / '),
        action: 'created',
        url: 'https://x.feishu.cn/file/File1',
        fileToken: 'File1',
      })),
      directoriesCreated: 0,
    })),
  };
  scheduler = new SyncDailyScheduler({
    registry,
    knowledge,
    reports,
    routes: [],
    lark,
    configLoader: async () => config,
    clock: () => now,
    runQuick,
    listBranches,
  });
});

afterEach(async () => {
  await scheduler?.close();
  scheduler = undefined;
  await knowledge?.close();
  kbReports?.close();
  kbReports = undefined;
  reports.close();
  await rm(root, { recursive: true, force: true });
});

async function due() {
  await scheduler.check(new AbortController().signal);
  now = new Date('2026-11-13T20:00:00Z');
  await scheduler.check(new AbortController().signal);
}

const reportOf = () => reports.detail(reports.begin('sync', '2026-11-14').report.id);

describe('repairs derived from the real sync history', () => {
  it('keeps a non-Git workspace from turning the whole day into a partial failure', async () => {
    await due();
    const report = reportOf();
    expect(report.status).toBe('completed');
    expect(report.stats.failed).toBe(0);
    expect(report.stats.workspaces).toBe(7);
    expect(runQuick).toHaveBeenCalledTimes(6);
    const blank = report.workspaces.find((item) => item.id === 'blank');
    expect(blank.items[0]).toMatchObject({
      kind: 'workspace',
      status: 'skipped',
      reason: 'SYNC_WORKSPACE_NOT_REPOSITORY',
    });
    expect(blank.items[0].error).toBeUndefined();
    // Every other workspace still produced its branch result.
    expect(report.stats.branches).toBe(6);
    expect(report.stats.succeeded).toBe(6);
  });

  it('raises a stable code for a plain folder instead of leaking git stderr', async () => {
    await expect(listSyncBranches(join(root, 'blank'))).rejects.toThrow(
      'SYNC_WORKSPACE_NOT_REPOSITORY',
    );
  });

  it('resumes a cancelled report of the same day on the next tick', async () => {
    const { report } = reports.begin('sync', '2026-11-14', { targetDay: '2026-11-13' });
    reports.finish(report.id, 'cancelled');
    expect(reports.get(report.id).status).toBe('cancelled');

    await due();
    expect(runQuick).toHaveBeenCalled();
    const resumed = reportOf();
    expect(resumed.status).toBe('completed');
    expect(resumed.stats.branches).toBe(6);
  });

  it('does not push when the sync schedule push switch is off', async () => {
    await due();
    expect(lark.pushDocuments).not.toHaveBeenCalled();
    expect(reportOf().workspaces.every((item) => !item.items.some((x) => x.kind === 'lark'))).toBe(
      true,
    );
  });

  it('pushes requirement.md and records a completed Lark item when enabled', async () => {
    config.sync.larkPushEnabled = true;
    await due();
    expect(lark.pushDocuments).toHaveBeenCalledTimes(6);
    const { workspaceId, documents, signal } = lark.pushDocuments.mock.calls[0][0];
    expect(workspaceId).toBe('req-hub');
    expect(documents.map((item) => item.name)).toEqual(['requirement.md']);
    expect(documents[0].segments[0]).toBe('docs');
    expect(signal).toBeTruthy();
    const report = reportOf();
    expect(report.status).toBe('completed');
    const larkItems = report.workspaces.flatMap((item) =>
      item.items.filter((entry) => entry.kind === 'lark'),
    );
    expect(larkItems).toHaveLength(6);
    expect(larkItems.every((item) => item.status === 'completed')).toBe(true);
    expect(larkItems[0].action).toBe('created');
  });

  it('isolates a Lark delivery failure from the document sync result', async () => {
    config.sync.larkPushEnabled = true;
    lark.pushDocuments.mockRejectedValue(new Error('LARK_NETWORK_FAILED'));
    await due();
    const report = reportOf();
    expect(report.stats.branches).toBe(6);
    expect(report.stats.succeeded).toBe(6);
    const branches = report.workspaces.flatMap((item) =>
      item.items.filter((entry) => entry.kind === 'branch'),
    );
    expect(branches.every((item) => item.status === 'completed')).toBe(true);
    const larkItems = report.workspaces.flatMap((item) =>
      item.items.filter((entry) => entry.kind === 'lark'),
    );
    expect(larkItems.every((item) => item.status === 'failed')).toBe(true);
    expect(larkItems[0].error).toBe('LARK_NETWORK_FAILED');
  });
});

describe('knowledge daily catch-up and Lark push', () => {
  const fakeStore = (workspaceId, withRelease) => {
    const dir = join(root, 'kb', workspaceId);
    return {
      scope: { scopeId: `scope-${workspaceId}`, workspaceId, workspace: { id: workspaceId } },
      path: (...parts) => join(dir, ...parts),
      sources: vi.fn(async () => ({ sources: [] })),
      jobs: vi.fn(async () => ({ jobs: [] })),
      withRelease,
    };
  };
  const fakeApplication = (stores, reportStore) => ({
    registry: { list: () => Object.keys(stores).map((id) => ({ id, path: `/${id}` })) },
    reports: reportStore,
    scope: vi.fn(async (id) => stores[id]),
    importFiles: vi.fn(async () => ({ failed: 0, results: [] })),
    enqueueCompile: vi.fn(async () => ({ id: 'job-1', status: 'queued' })),
    queue: { waitFor: vi.fn(async () => ({ id: 'job-1', status: 'completed' })) },
  });
  const knowledgeConfig = (override = {}) => ({
    general: { timeZone: 'Asia/Shanghai' },
    knowledgeV2: { ...DEFAULT_SYNC_SETTINGS, dailyUpdateEnabled: true, ...override },
  });
  const makeScheduler = (application, values) =>
    new KnowledgeSyncScheduler({
      application,
      configLoader: async () => values,
      configSaver: vi.fn(),
      lark,
    });

  it('does not run before the configured minute', async () => {
    const stores = { A: fakeStore('A') };
    const application = fakeApplication(stores, null);
    scheduler = makeScheduler(application, knowledgeConfig({ dailyUpdateTime: '02:00' }));
    const results = await scheduler.runDue(new Date('2026-11-10T17:59:00Z'));
    expect(results).toEqual([]);
    expect(application.scope).not.toHaveBeenCalled();
  });

  it('catches up after a missed minute and deduplicates through the report store', async () => {
    const stores = { A: fakeStore('A') };
    kbReports = new TaskReports({ list: () => [] }, { directory: join(root, 'kb-reports') });
    const application = fakeApplication(stores, kbReports);
    scheduler = makeScheduler(application, knowledgeConfig({ dailyUpdateTime: '02:00' }));

    const late = await scheduler.runDue(new Date('2026-11-10T18:37:00Z'));
    expect(late.map((item) => item.workspaceId)).toEqual(['A']);
    expect(application.scope).toHaveBeenCalledTimes(1);
    const repeat = await scheduler.runDue(new Date('2026-11-10T18:38:00Z'));
    expect(repeat).toEqual([]);
    expect(application.scope).toHaveBeenCalledTimes(1);
  });

  it('waits for compile and pushes the published Wiki when enabled', async () => {
    const store = fakeStore('A', true);
    await mkdir(store.path('releases', 'gen-1', 'wiki'), { recursive: true });
    await writeFile(store.path('current.json'), JSON.stringify({ generationId: 'gen-1' }), 'utf8');
    await writeFile(store.path('releases', 'gen-1', 'wiki', 'index.md'), '# 索引', 'utf8');
    store.sources.mockResolvedValue({
      sources: [{ id: 'f1', kind: 'file', status: 'active', origin: { relativePath: 'a.md' } }],
    });
    const application = fakeApplication({ A: store }, null);
    application.importFiles.mockResolvedValue({
      failed: 0,
      results: [{ status: 'saved', sourceId: 'source-1' }],
    });
    scheduler = makeScheduler(application, knowledgeConfig({ larkPushEnabled: true }));

    const [result] = await scheduler.runDue(new Date('2026-11-10T18:00:00Z'));
    expect(application.queue.waitFor).toHaveBeenCalledTimes(1);
    expect(result.larkPush).toMatchObject({ pushed: 1, generationId: 'gen-1' });
    const { documents } = lark.pushDocuments.mock.calls[0][0];
    expect(documents[0].name).toBe('index.md');
    expect(documents[0].segments).toEqual(['docs', 'knowledge-v2']);
    expect(result.failed).toBe(0);
  });

  it('leaves the knowledge run intact when the push switch is off', async () => {
    const stores = { A: fakeStore('A') };
    const application = fakeApplication(stores, null);
    scheduler = makeScheduler(application, knowledgeConfig());
    const [result] = await scheduler.runDue(new Date('2026-11-10T18:00:00Z'));
    expect(result.larkPush).toBeNull();
    expect(lark.pushDocuments).not.toHaveBeenCalled();
  });
});
