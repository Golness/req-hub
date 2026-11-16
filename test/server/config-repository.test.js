import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConfigRepository,
  loadConfig,
  saveConfig,
  updateConfig,
} from '../../src/server/config.js';
import { configRevision } from '../../src/server/config-repository.js';
import { createConfigApplication } from '../../src/server/application/config.js';
import { createConfigRoutes } from '../../src/server/routes/config-routes.js';
import { createOperations } from '../../src/server/operations.js';
import { Readable } from 'node:stream';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rh-config-owner-'));
  roots.push(root);
  const path = join(root, 'config.json');
  const repository = createConfigRepository(overrides, { filePath: path });
  return { root, path, repository };
}

it('keeps overlapping async profile operations in their own repository', async () => {
  const a = await fixture();
  const b = await fixture();
  await Promise.all(
    [a.repository, b.repository].map((repository, index) =>
      repository.run(async () => {
        await saveConfig({ docsDir: 'profile-' + index });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect((await loadConfig()).docsDir).toBe('profile-' + index);
      }),
    ),
  );
  await a.repository.close();
  expect((await b.repository.read()).docsDir).toBe('profile-1');
});

it('preserves unrelated snapshot edits and rejects conflicting stale edits', async () => {
  const { repository, path } = await fixture();
  await repository.run(async () => {
    const first = await loadConfig();
    const second = await loadConfig();
    await Promise.all([
      saveConfig({ ...first, docsDir: 'requirements' }),
      saveConfig({ ...second, developerName: 'alice' }),
    ]);
    expect(await loadConfig()).toMatchObject({ docsDir: 'requirements', developerName: 'alice' });
    await expect(saveConfig({ ...second, docsDir: 'stale' })).rejects.toMatchObject({
      code: 'CONFIG_CONFLICT',
      status: 409,
    });
    expect(JSON.parse(await readFile(path, 'utf8')).docsDir).toBe('requirements');
  });
});

it('checks revisions and cancellation inside the queue without poisoning later writes', async () => {
  const { repository } = await fixture();
  await repository.run(async () => {
    const original = await loadConfig();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = updateConfig(async (current) => {
      await gate;
      return { ...current, developerName: 'saved' };
    });
    const controller = new AbortController();
    const cancelled = updateConfig((current) => ({ ...current, docsDir: 'cancelled' }), {
      signal: controller.signal,
    });
    const stale = updateConfig((current) => ({ ...current, docsDir: 'stale' }), {
      expectedRevision: configRevision(original),
    });
    controller.abort(new Error('STOP'));
    const settled = Promise.allSettled([first, cancelled, stale]);
    release();
    const results = await settled;
    expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(results[2].reason.code).toBe('CONFIG_CONFLICT');
    expect((await loadConfig()).docsDir).toBe('docs');
    await updateConfig((current) => ({ ...current, docsDir: 'next' }));
  });
  await repository.close();
  await expect(repository.update({})).rejects.toThrow('CONFIG_CLOSED');
});

it('rejects deployment-owned field edits while allowing unrelated user settings', async () => {
  const { repository } = await fixture({ general: { timeZone: 'UTC' } });
  await repository.run(async () => {
    const config = await loadConfig();
    await expect(
      saveConfig({ ...config, general: { ...config.general, timeZone: 'Asia/Shanghai' } }),
    ).rejects.toMatchObject({
      code: 'CONFIG_DEPLOYMENT_OVERRIDE',
      details: { field: 'general.timeZone' },
    });
    await saveConfig({ ...config, developerName: 'allowed' });
    expect(await loadConfig()).toMatchObject({
      developerName: 'allowed',
      general: { timeZone: 'UTC' },
    });
  });
});

it('shares config results and user-only enforcement without calling an HTTP handler from tools', async () => {
  const { repository } = await fixture();
  await repository.run(async () => {
    const registry = { list: () => [] };
    const routes = createConfigRoutes(registry, {}, {});
    const operations = createOperations(routes);
    routes[0].handler = () => {
      throw new Error('HTTP_MUST_NOT_RUN');
    };
    expect((await operations.execute({ action: 'config' }, {})).value.docsDir).toBe('docs');
    const denied = await operations.execute(
      {
        action: 'config',
        method: 'POST',
        body: {
          sync: { dailyUpdateEnabled: true },
        },
      },
      {},
    );
    expect(denied).toMatchObject({ status: 403, value: { error: 'SYNC_SCHEDULE_USER_REQUIRED' } });
    const body = { developerName: 'shared' };
    const tool = await operations.execute({ action: 'config', method: 'POST', body }, {});
    const req = Readable.from([JSON.stringify(body)]);
    req.method = 'POST';
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        this.value = JSON.parse(text);
      },
    };
    await createConfigRoutes(registry, {}, {})[0].handler(req, res);
    expect(JSON.parse(JSON.stringify(tool))).toEqual({ status: res.status, value: res.value });
  });
});

it('reports a committed but unapplied revision when applying settings fails', async () => {
  const { repository } = await fixture();
  await repository.run(async () => {
    const app = createConfigApplication(
      { list: () => [] },
      {},
      {
        onSaved: async () => {
          throw new Error('REFRESH_FAILED');
        },
      },
    );
    await expect(app.save({ developerName: 'persisted' }, { kind: 'user' })).rejects.toMatchObject({
      code: 'CONFIG_APPLY_FAILED',
      details: { saved: true, applied: false },
    });
    expect((await loadConfig()).developerName).toBe('persisted');
  });
});

it('versions persisted settings before decorating them with automatic workspace selections', async () => {
  const { repository, root } = await fixture();
  await repository.run(async () => {
    const app = createConfigApplication({ list: () => [{ id: 'ws', path: root }] }, {});
    const original = configRevision(await loadConfig());
    const { value } = await app.read();
    expect(value.workspaceId).toBe('ws');
    expect(value._revision).toBe(original);
    expect(
      (await app.save({ _revision: value._revision, developerName: 'saved' }, { kind: 'user' }))
        .status,
    ).toBe(200);
  });
});
