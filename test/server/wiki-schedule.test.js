import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { WikiService } from '../../src/server/knowledge/wiki/service.js';
import { WikiDailyScheduler, dailyClock } from '../../src/server/knowledge/wiki/daily-scheduler.js';
import { createWikiRoutes } from '../../src/server/routes/wiki-routes.js';
import { createOperations } from '../../src/server/operations.js';

vi.mock('../../src/server/sync-budget.js', async (original) => ({
  ...(await original()),
  resolveSyncBudget: async () => ({ limit: 200000 }),
}));
let root, knowledge, wiki, scheduler, scope, config, runTask, ctx, parent;
const path = 'alice/2026-11-02-topic/requirement.md';
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-02T01:59:00Z'));
  root = await mkdtemp(join(tmpdir(), 'reqhub-wiki-schedule-'));
  await mkdir(join(root, 'docs/alice/2026-11-02-topic'), { recursive: true });
  await writeFile(join(root, 'docs', path), '# Supported source');
  parent = { status: 'idle', session: { id: 'parent', header: { cwd: root } } };
  ctx = {
    agents: { get: () => parent, list: () => [parent] },
    skills: { get: async () => null },
    subagents: {
      getProvider: () => ({ capabilities: { toolFilter: true }, inheritsParentContext: false }),
    },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
  };
  config = {
    docsDir: 'docs',
    wiki: {
      dailyUpdateEnabled: true,
      dailyUpdateTime: '10:00',
      dailyUpdateTimeZone: 'Asia/Shanghai',
    },
  };
  knowledge = new KnowledgeService({
    registry: { list: () => [{ id: 'ws', path: root }] },
    configLoader: async () => config,
    databasePath: join(root, 'data/knowledge.sqlite'),
  });
  runTask = vi.fn(async (_ctx, _llm, _config, { runtime }) => {
    for (const doc of runtime.documents) {
      let offset = 0;
      let result;
      do {
        result = runtime.read({ documentId: doc.id, offset });
        offset = result.nextOffset;
      } while (!result.eof);
    }
    const source = runtime.documents.find((doc) => doc.kind === 'source');
    runtime.submit({
      result: {
        pages: [
          {
            title: 'Topic',
            entityKey: 'topic',
            pageType: 'concept',
            body: 'Supported knowledge.',
            evidence: [
              { documentId: source.id, version: source.version, startLine: 1, endLine: 1 },
            ],
          },
        ],
      },
    });
    return { isError: false, stopReason: 'completed' };
  });
  wiki = new WikiService({ knowledge, ctx, configLoader: async () => config, runTask });
  knowledge.wiki = wiki;
  wiki.database();
  scope = await knowledge.scope('ws');
  await wiki.capture('ws', path, 'parent');
  scheduler = new WikiDailyScheduler({ wiki, ownerKey: 'profile-one' });
  wiki.dailyScheduler = scheduler;
});
afterEach(async () => {
  await wiki.close();
  await knowledge.close();
  vi.useRealTimers();
  const child = relative(tmpdir(), root);
  if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('reqhub-wiki-schedule-')) {
    throw new Error('Unsafe test cleanup');
  }
  await rm(root, { recursive: true, force: true });
});
async function settle() {
  await scheduler.pending;
  while (wiki.tasks.size) {
    await Promise.allSettled([...wiki.tasks]);
  }
}
async function due() {
  await scheduler.refresh();
  await vi.advanceTimersByTimeAsync(60000);
  await settle();
}
it('queues pending knowledge at the configured local minute independently of save automation', async () => {
  await scheduler.refresh();
  await vi.advanceTimersByTimeAsync(59999);
  expect(runTask).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
  expect(runTask.mock.calls[0][3].variables.kind).toBe('ingest');
  expect(await wiki.updateStatus(scope)).toMatchObject({ pendingCount: 0, autoManage: false });
  expect(
    wiki
      .database()
      .events(scope.identity, {})
      .items.map((event) => event.stage),
  ).toContain('schedule_triggered');
});
it('does not repeat a dispatch after another save or a same-day scheduler restart', async () => {
  await due();
  await writeFile(join(root, 'docs', path), '# Later version');
  await wiki.capture('ws', path, 'parent');
  await scheduler.close();
  scheduler = new WikiDailyScheduler({ wiki, ownerKey: 'profile-one' });
  wiki.dailyScheduler = scheduler;
  await scheduler.refresh();
  await vi.advanceTimersByTimeAsync(120000);
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
  expect(await wiki.updateStatus(scope)).toMatchObject({ pendingCount: 1 });
  expect(
    wiki.database().db.prepare('SELECT count(*) n FROM knowledge_wiki_daily_runs').get().n,
  ).toBe(1);
});
it('catches up only the current date when restarting an already enabled plan', async () => {
  await scheduler.refresh();
  await scheduler.close();
  vi.setSystemTime(new Date('2026-11-04T04:00:00Z'));
  scheduler = new WikiDailyScheduler({ wiki, ownerKey: 'profile-one' });
  wiki.dailyScheduler = scheduler;
  await scheduler.refresh();
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
  expect(wiki.database().db.prepare('SELECT run_day FROM knowledge_wiki_daily_runs').all()).toEqual(
    [{ run_day: '2026-11-04' }],
  );
});
it('starts tomorrow when a plan is newly enabled after its daily time', async () => {
  config.wiki.dailyUpdateTime = '09:00';
  await scheduler.refresh();
  expect(runTask).not.toHaveBeenCalled();
  vi.setSystemTime(new Date('2026-11-03T00:59:00Z'));
  await vi.advanceTimersByTimeAsync(60000);
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
});
it('applies a changed time and stops future dispatch after disabling', async () => {
  await scheduler.refresh();
  config.wiki.dailyUpdateTime = '11:00';
  await scheduler.refresh();
  await vi.advanceTimersByTimeAsync(60000);
  expect(runTask).not.toHaveBeenCalled();
  config.wiki.dailyUpdateEnabled = false;
  await scheduler.refresh();
  await vi.advanceTimersByTimeAsync(3600000);
  expect(runTask).not.toHaveBeenCalled();
  expect(scheduler.state.state).toBe('disabled');
});
it('records a no-change day without invoking a model', async () => {
  await unlink(join(root, 'docs', path));
  await due();
  expect(runTask).not.toHaveBeenCalled();
  expect(
    wiki
      .database()
      .events(scope.identity, {})
      .items.map((event) => event.stage),
  ).toContain('schedule_no_changes');
  await writeFile(join(root, 'docs', path), '# A source saved after the daily check');
  await wiki.capture('ws', path, 'parent');
  await vi.advanceTimersByTimeAsync(60000);
  expect(runTask).not.toHaveBeenCalled();
});
it('keeps scheduled work waiting for a session and resumes without enabling save automation', async () => {
  ctx.agents.list = () => [];
  ctx.agents.get = () => null;
  await due();
  expect(runTask).not.toHaveBeenCalled();
  expect(await wiki.updateStatus(scope)).toMatchObject({ queuedCount: 1, waitingSession: true });
  ctx.agents.list = () => [parent];
  ctx.agents.get = () => parent;
  await wiki.resume();
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
});
it('isolates activation boundaries belonging to different profiles', async () => {
  await scheduler.refresh();
  const settings = vi.spyOn(wiki, 'settings');
  const original = await settings.getMockImplementation()?.();
  settings.mockResolvedValueOnce({
    ...(original || (await wiki.settings())),
    dailyUpdateEnabled: true,
    dailyUpdateTime: '09:00',
    dailyUpdateTimeZone: 'Asia/Shanghai',
  });
  const other = new WikiDailyScheduler({ wiki, ownerKey: 'profile-two' });
  await other.refresh();
  await other.close();
  settings.mockRestore();
  await vi.advanceTimersByTimeAsync(60000);
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
});
it('waits for pending access checks on unload and never enqueues their stale results', async () => {
  await scheduler.refresh();
  let release;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  vi.spyOn(wiki, 'resolveScope').mockImplementation(async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return scope;
  });
  vi.setSystemTime(new Date('2026-11-02T02:00:00Z'));
  const checking = scheduler.refresh();
  await ready;
  let closed = false;
  const closing = wiki.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await checking;
  await closing;
  expect(runTask).not.toHaveBeenCalled();
  expect(
    knowledge.database().db.prepare('SELECT count(*) n FROM knowledge_wiki_daily_runs').get().n,
  ).toBe(0);
});
it('uses local calendar dates through midnight and a repeated daylight-saving hour', () => {
  expect(dailyClock(new Date('2026-11-02T16:00:00Z'), 'Asia/Shanghai')).toEqual({
    day: '2026-11-03',
    minute: 0,
  });
  expect(dailyClock(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toEqual(
    dailyClock(new Date('2026-11-01T06:30:00Z'), 'America/New_York'),
  );
});
it('rejects invalid saved schedule settings and applies valid settings through the shared operation', async () => {
  const saver = vi.fn(async (value) => {
    config = value;
  });
  const adapter = createWikiRoutes(knowledge, ctx, {
    service: wiki,
    configLoader: async () => config,
    configSaver: saver,
  });
  const ops = createOperations(adapter.routes);
  const current = (await ops.execute({ action: 'wiki-settings', query: { workspaceId: 'ws' } }, {}))
    .value;
  const bad = await ops.execute(
    {
      action: 'wiki-settings',
      method: 'PUT',
      body: {
        workspaceId: 'ws',
        expectedVersion: current.version,
        values: { dailyUpdateTime: '25:00' },
      },
    },
    {},
  );
  expect(bad.status).toBe(400);
  expect(bad.value.error).toBe('WIKI_SCHEDULE_TIME_INVALID');
  expect(saver).not.toHaveBeenCalled();
  const saved = await ops.execute(
    {
      action: 'wiki-settings',
      method: 'PUT',
      body: {
        workspaceId: 'ws',
        expectedVersion: current.version,
        values: { dailyUpdateTime: '11:00' },
      },
    },
    {},
  );
  expect(saved.value.schedule).toMatchObject({ state: 'enabled', time: '11:00' });
  await adapter.dispose();
});
it('cancels a stale access result when the schedule is disabled before enqueue', async () => {
  await scheduler.refresh();
  let release;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  vi.spyOn(wiki, 'resolveScope').mockImplementation(async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return scope;
  });
  vi.setSystemTime(new Date('2026-11-02T02:00:00Z'));
  const checking = scheduler.refresh();
  await ready;
  config.wiki.dailyUpdateEnabled = false;
  const saving = scheduler.refresh();
  release();
  await checking;
  await saving;
  expect(runTask).not.toHaveBeenCalled();
  expect(scheduler.state.state).toBe('disabled');
  expect(
    wiki.database().db.prepare('SELECT count(*) n FROM knowledge_wiki_daily_runs').get().n,
  ).toBe(0);
});
it('commits daily deduplication with the source queue and does not duplicate concurrent requests', async () => {
  const scheduled = {
    ownerKey: 'profile-one',
    day: '2026-11-02',
    time: '10:00',
    timeZone: 'Asia/Shanghai',
    assertActive: () => {},
  };
  const event = vi.spyOn(wiki.database(), 'event');
  event.mockImplementationOnce(() => {
    throw new Error('Write failed');
  });
  await expect(wiki.update(scope, 'parent', scheduled)).rejects.toThrow('Write failed');
  expect(
    wiki.database().db.prepare('SELECT count(*) n FROM knowledge_wiki_daily_runs').get().n,
  ).toBe(0);
  event.mockRestore();
  await Promise.all([
    wiki.update(scope, 'parent', scheduled),
    wiki.update(scope, 'parent', scheduled),
  ]);
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
  expect(
    wiki.database().db.prepare('SELECT count(*) n FROM knowledge_wiki_daily_runs').get().n,
  ).toBe(1);
});
