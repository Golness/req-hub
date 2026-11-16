import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeSyncScheduler } from '../../src/server/knowledge-v2/sync-scheduler.js';
import { DEFAULT_SYNC_SETTINGS } from '../../src/server/knowledge-v2/sync-settings.js';

let scheduler;

afterEach(async () => {
  await scheduler?.close();
  scheduler = undefined;
});

const values = (override = {}) => ({
  ...DEFAULT_SYNC_SETTINGS,
  ...override,
});

function applicationFor(stores) {
  return {
    registry: {
      list: () => Object.keys(stores).map((id) => ({ id, path: `/${id}` })),
    },
    scope: vi.fn(async (workspaceId) => {
      if (!stores[workspaceId]) {
        throw new Error('KB_WORKSPACE_MISSING');
      }
      return stores[workspaceId];
    }),
    importFiles: vi.fn(async () => ({
      failed: 0,
      results: [{ status: 'saved', sourceId: 'source-1' }],
    })),
    enqueueCompile: vi.fn(async () => ({ id: 'job-1', status: 'queued' })),
  };
}

function store(workspaceId, paths = []) {
  return {
    scope: { scopeId: `scope-${workspaceId}`, workspaceId },
    sources: vi.fn(async () => ({
      sources: paths.map((relativePath, index) => ({
        id: `source-${index + 1}`,
        kind: 'file',
        status: 'active',
        origin: { relativePath },
      })),
    })),
  };
}

describe('Knowledge V2 synchronization settings', () => {
  it('reads only knowledgeV2 automation settings and ignores legacy config blocks', async () => {
    let config = {
      general: { timeZone: 'Asia/Shanghai' },
      wiki: {
        autoManage: true,
        autoManageDelayMs: 5000,
        dailyUpdateEnabled: true,
        dailyUpdateTime: '03:04',
        obsoleteLimit: 999,
      },
    };
    const application = applicationFor({ B: store('B') });
    const configSaver = vi.fn(async (next) => {
      config = next;
    });
    scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => config,
      configSaver,
    });

    // The abandoned wiki block is never projected into V2 settings.
    const current = await scheduler.settings('B');
    expect(current.values).toEqual({ ...DEFAULT_SYNC_SETTINGS });
    expect(current.values).not.toHaveProperty('obsoleteLimit');

    await scheduler.saveSettings('B', {
      expectedVersion: current.version,
      values: {
        autoManage: true,
        autoManageDelayMs: 5000,
        dailyUpdateEnabled: true,
        dailyImportConversations: true,
        dailyUpdateTime: '04:05',
      },
    });
    // Saving writes only the supported keys under knowledgeV2 and leaves
    // unrelated configuration blocks untouched.
    expect(config.knowledgeV2).toEqual({
      autoManage: true,
      autoManageDelayMs: 5000,
      dailyUpdateEnabled: true,
      dailyImportConversations: true,
      dailyUpdateTime: '04:05',
      larkPushEnabled: false,
    });
    expect(config.wiki).toEqual({
      autoManage: true,
      autoManageDelayMs: 5000,
      dailyUpdateEnabled: true,
      dailyUpdateTime: '03:04',
      obsoleteLimit: 999,
    });
  });

  it('rejects an optimistic-concurrency conflict and unsupported fields', async () => {
    const config = {
      general: { timeZone: 'Asia/Shanghai' },
      knowledgeV2: values(),
    };
    scheduler = new KnowledgeSyncScheduler({
      application: applicationFor({ B: store('B') }),
      configLoader: async () => config,
      configSaver: vi.fn(),
    });
    await expect(
      scheduler.saveSettings('B', { expectedVersion: 'stale', values: {} }),
    ).rejects.toMatchObject({ code: 'KB_SETTINGS_CONFLICT' });
    const current = await scheduler.settings('B');
    await expect(
      scheduler.saveSettings('B', {
        expectedVersion: current.version,
        values: { unexpected: true },
      }),
    ).rejects.toMatchObject({ code: 'KB_SETTINGS_INVALID' });
  });
});

describe('Knowledge V2 save debounce', () => {
  it('resets the quiet period, merges paths and queues one compile', async () => {
    const target = store('B');
    const application = applicationFor({ B: target });
    scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => ({
        general: { timeZone: 'Asia/Shanghai' },
        knowledgeV2: values({ autoManage: true, autoManageDelayMs: 10 }),
      }),
      configSaver: vi.fn(),
    });

    await scheduler.capture('B', 'a.md');
    await scheduler.capture('B', 'b.md');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await Promise.all([...scheduler.tasks]);

    expect(application.importFiles).toHaveBeenCalledTimes(1);
    expect(application.importFiles.mock.calls[0][1].files).toEqual([
      { relativePath: 'a.md' },
      { relativePath: 'b.md' },
    ]);
    expect(application.importFiles.mock.calls[0][1].ingest).toBe(false);
    expect(application.enqueueCompile).toHaveBeenCalledTimes(1);
    expect(application.enqueueCompile).toHaveBeenCalledWith(target, 'ingest', ['source-1']);
  });
});

describe('Knowledge V2 daily synchronization', () => {
  it('does not compile unchanged files on a later run', async () => {
    const target = store('B', ['a.md']);
    const application = applicationFor({ B: target });
    application.importFiles
      .mockResolvedValueOnce({ failed: 0, results: [{ status: 'saved', sourceId: 'source-1' }] })
      .mockResolvedValueOnce({
        failed: 0,
        results: [{ status: 'unchanged', sourceId: 'source-1' }],
      });
    scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => ({
        general: { timeZone: 'Asia/Shanghai' },
        knowledgeV2: values({ dailyUpdateEnabled: true }),
      }),
      configSaver: vi.fn(),
    });

    const first = await scheduler.runDaily('B', '2026-11-11', {});
    const second = await scheduler.runDaily('B', '2026-11-11', {});
    expect(first.job).toMatchObject({ id: 'job-1' });
    expect(second.job).toBeNull();
    expect(application.enqueueCompile).toHaveBeenCalledTimes(1);
  });

  it('resolves every target workspace independently at the scheduled minute', async () => {
    const stores = { A: store('A', ['a.md']), B: store('B', ['b.md']) };
    const application = applicationFor(stores);
    scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => ({
        general: { timeZone: 'Asia/Shanghai' },
        knowledgeV2: values({
          dailyUpdateEnabled: true,
          dailyUpdateTime: '02:00',
        }),
      }),
      configSaver: vi.fn(),
    });

    const results = await scheduler.runDue(new Date('2026-11-10T18:00:00Z'));
    expect(results.map((item) => item.workspaceId)).toEqual(['A', 'B']);
    expect(application.scope.mock.calls.map((call) => call[0])).toEqual(['A', 'B']);
    expect(application.enqueueCompile).toHaveBeenCalledTimes(2);
  });
});
