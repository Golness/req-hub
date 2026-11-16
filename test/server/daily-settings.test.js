import { beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createOperations } from '../../src/server/operations.js';
import { createConfigRoutes } from '../../src/server/routes/config-routes.js';
import { loadConfig, saveConfig } from '../../src/server/config.js';
import { getSubagentScheduler } from '../../src/server/concurrency/SubagentScheduler.js';

vi.mock('../../src/server/config.js', () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  updateConfig: vi.fn(async (updater) => {
    const next = await updater(await loadConfig());
    await saveConfig(next);
    return next;
  }),
  autoDefaultConfig: vi.fn(),
}));

let routes;
beforeEach(() => {
  vi.clearAllMocks();
  loadConfig.mockResolvedValue({ knowledgeV2: { dailyImportConversations: false } });
  routes = createConfigRoutes({ list: () => [] }, {});
});

it('prevents tools from bypassing the conversation opt-in through the generic configuration route', async () => {
  const operations = createOperations(routes);
  const result = await operations.execute(
    {
      action: 'config',
      method: 'POST',
      body: { knowledgeV2: { dailyImportConversations: true } },
    },
    {},
  );
  expect(result).toMatchObject({ status: 403, value: { error: 'KNOWLEDGE_V2_USER_REQUIRED' } });
  expect(saveConfig).not.toHaveBeenCalled();
});

it('keeps time-zone changes user-owned and removes independent clocks when the user saves', async () => {
  const existing = {
    general: { timeZone: 'Asia/Shanghai' },
    sync: { dailyUpdateTimeZone: 'UTC', dailyUpdateTime: '03:00' },
    knowledgeV2: { dailyUpdateTimeZone: 'Asia/Tokyo' },
  };
  loadConfig.mockResolvedValue(existing);
  const operations = createOperations(routes);
  expect(
    await operations.execute(
      {
        action: 'config',
        method: 'POST',
        body: { general: { timeZone: 'UTC' } },
      },
      {},
    ),
  ).toMatchObject({ status: 403, value: { error: 'TIME_ZONE_USER_REQUIRED' } });
  expect(saveConfig).not.toHaveBeenCalled();
  const req = Object.assign(Readable.from([JSON.stringify({ general: { timeZone: 'UTC' } })]), {
    method: 'POST',
  });
  const res = {
    writeHead(status) {
      this.status = status;
    },
    end() {},
  };
  await routes.find((route) => route.path === '/req-hub/config').handler(req, res);
  expect(res.status).toBe(200);
  expect(saveConfig.mock.calls[0][0]).toMatchObject({
    general: { timeZone: 'UTC' },
    sync: { dailyUpdateTime: '03:00' },
  });
  expect(saveConfig.mock.calls[0][0].sync).not.toHaveProperty('dailyUpdateTimeZone');
  expect(saveConfig.mock.calls[0][0].knowledgeV2).not.toHaveProperty('dailyUpdateTimeZone');
  expect(existing.sync.dailyUpdateTimeZone).toBe('UTC');
});

it('applies a saved shared limit without replacing provider settings or reconfiguring on save failure', async () => {
  const subagents = {};
  const scheduler = getSubagentScheduler(subagents, { ai: { delegation: { maxConcurrency: 3 } } });
  loadConfig.mockResolvedValue({ ai: { delegation: { provider: 'spawn', timeout: 60000 } } });
  const operations = createOperations(createConfigRoutes({ list: () => [] }, {}, { subagents }));
  const request = {
    action: 'config',
    method: 'POST',
    body: { ai: { delegation: { maxConcurrency: 5 } } },
  };
  expect(await operations.execute(request, {})).toMatchObject({ status: 200 });
  expect(saveConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      ai: expect.objectContaining({
        delegation: { provider: 'spawn', maxConcurrency: 5 },
      }),
    }),
  );
  expect(scheduler.semaphore.maxConcurrency).toBe(5);
  saveConfig.mockRejectedValueOnce(new Error('SAVE_FAILED'));
  request.body.ai.delegation.maxConcurrency = 1;
  expect(await operations.execute(request, {})).toMatchObject({ status: 500 });
  expect(scheduler.semaphore.maxConcurrency).toBe(5);
});

it('allows the user to save the opt-in and tools to preserve its existing value', async () => {
  const route = routes.find((item) => item.path === '/req-hub/config');
  let result;
  const res = {
    writeHead(status) {
      this.status = status;
    },
    end(value) {
      result = JSON.parse(value);
    },
  };
  const req = Object.assign(
    Readable.from([
      JSON.stringify({
        knowledgeV2: { dailyImportConversations: true },
      }),
    ]),
    { method: 'POST' },
  );
  await route.handler(req, res);
  expect(res.status).toBe(200);
  expect(result.knowledgeV2.dailyImportConversations).toBe(true);
  expect(saveConfig).toHaveBeenCalledOnce();

  loadConfig.mockResolvedValue({ knowledgeV2: { dailyImportConversations: true } });
  const operations = createOperations(routes);
  expect(
    await operations.execute(
      {
        action: 'config',
        method: 'POST',
        body: { docsDir: 'docs' },
      },
      {},
    ),
  ).toMatchObject({ status: 200 });
});

it('keeps sync settings when saving a partial schedule and denies tool changes to user-owned automation', async () => {
  const existing = { defaultUsername: 'alice', sync: { baseBranch: 'main', dailyOffsetDays: 1 } };
  loadConfig.mockResolvedValue(existing);
  const onSaved = vi.fn();
  routes = createConfigRoutes({ list: () => [] }, {}, {}, { onSaved });
  const operations = createOperations(routes);
  expect(
    await operations.execute(
      { action: 'config', method: 'POST', body: { sync: { dailyUpdateEnabled: true } } },
      {},
    ),
  ).toMatchObject({ status: 403 });
  expect(saveConfig).not.toHaveBeenCalled();
  const req = Object.assign(
    Readable.from([JSON.stringify({ sync: { dailyUpdateEnabled: true } })]),
    { method: 'POST' },
  );
  const res = {
    writeHead(status) {
      this.status = status;
    },
    end() {},
  };
  await routes.find((route) => route.path === '/req-hub/config').handler(req, res);
  expect(res.status).toBe(200);
  expect(saveConfig.mock.calls[0][0].sync).toEqual({
    baseBranch: 'main',
    dailyOffsetDays: 1,
    dailyUpdateEnabled: true,
  });
  expect(onSaved).toHaveBeenCalledWith(
    expect.objectContaining({ defaultUsername: 'alice' }),
    existing,
  );
});
