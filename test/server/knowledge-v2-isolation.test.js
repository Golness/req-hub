import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveScope, ScopeStore } from '../../src/server/knowledge-v2/scope.js';
import { importFiles } from '../../src/server/knowledge-v2/source-repository.js';
import { createKnowledgeApplication } from '../../src/server/knowledge-v2/application.js';
import { KnowledgeContext } from '../../src/server/knowledge-v2/context.js';
import { SessionSync } from '../../src/server/knowledge-v2/session-sync.js';
import { KnowledgeSyncScheduler } from '../../src/server/knowledge-v2/sync-scheduler.js';
import { DEFAULT_SYNC_SETTINGS } from '../../src/server/knowledge-v2/sync-settings.js';

let root;
afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const values = (override = {}) => ({ ...DEFAULT_SYNC_SETTINGS, ...override });

function fakeStore(workspaceId, workspacePath) {
  return {
    scope: {
      scopeId: `scope-${workspaceId}`,
      workspaceId,
      workspace: { id: workspaceId, title: `Workspace ${workspaceId}`, path: workspacePath },
      workspaceRoot: workspacePath,
      docsRoot: join(workspacePath, 'docs'),
    },
    sources: vi.fn(async () => ({ sources: [] })),
  };
}

describe('Knowledge V2 scope identity', () => {
  it('carries the registry workspace so read and sync consumers keep its identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-iso-'));
    const workspace = { id: 'ws-1', title: '项目', path: join(root, 'ws') };
    await mkdir(join(workspace.path, 'docs'), { recursive: true });
    const scope = await resolveScope({
      root: join(root, 'data'),
      workspace,
      docsDir: 'docs',
    });
    expect(scope.workspace).toBe(workspace);
    expect(scope.workspaceId).toBe('ws-1');
    expect(scope.workspaceRoot).toBe(await realpath(workspace.path));
  });
});

describe('Knowledge V2 per-workspace context isolation', () => {
  it('resolves each workspace independently instead of reusing the current page context', async () => {
    root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-iso-'));
    const workspaces = ['A', 'B'].map((id) => ({
      id,
      title: `Workspace ${id}`,
      path: join(root, `ws-${id}`),
    }));
    const stores = {};
    for (const workspace of workspaces) {
      await mkdir(join(workspace.path, 'docs'), { recursive: true });
      const scope = await resolveScope({
        root: join(root, 'data'),
        workspace,
        docsDir: 'docs',
      });
      const store = new ScopeStore(scope);
      await store.init();
      stores[workspace.id] = store;
    }
    const scopeCalls = [];
    const application = {
      registry: { list: () => workspaces },
      root: join(root, 'data'),
      scope: vi.fn(async (workspaceId) => {
        scopeCalls.push(workspaceId);
        if (!stores[workspaceId]) {
          throw new Error('KB_WORKSPACE_MISSING');
        }
        return stores[workspaceId];
      }),
      release: async () => null,
    };
    const context = new KnowledgeContext(application);

    const scopeA = await context.scope('A');
    const scopeB = await context.scope('B');
    expect(scopeA.identity).not.toBe(scopeB.identity);
    expect(scopeA.workspace.title).toBe('Workspace A');
    expect(scopeB.workspace.title).toBe('Workspace B');
    expect(scopeA.origin.workspace_id).toBe('A');
    expect(scopeB.origin.workspace_id).toBe('B');
    expect(scopeCalls).toEqual(['A', 'B']);
    expect((await context.catalog()).map((item) => item.workspace_id).sort()).toEqual(['A', 'B']);

    // A later request for B must not see A's cached context.
    const againB = await context.scope('B');
    expect(againB).toBe(scopeB);
    expect(againB.workspaceId).toBe('B');
  });
});

describe('Knowledge V2 session daily import destination filtering', () => {
  const turn = (text) => ({
    turnNumber: 1,
    status: 'completed',
    syncable: true,
    messages: [{ role: 'user', label: '用户', text }],
  });

  it('imports only sessions whose cwd matches the destination workspace', async () => {
    root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-iso-'));
    const pathA = join(root, 'ws-a');
    const pathB = join(root, 'ws-b');
    await mkdir(pathA, { recursive: true });
    await mkdir(pathB, { recursive: true });
    const storeB = fakeStore('B', pathB);
    const importSessions = vi.fn(async () => ({
      saved: 1,
      skipped: 0,
      results: [{ status: 'saved', sourceId: 'doc-1' }],
    }));
    const allow = vi.fn(async () => {});
    const library = {
      owner: 'owner',
      ready: async () => {},
      store: {
        scope: async () => ({ id: 'source-scope' }),
        allow,
        put: async () => ({ conversationId: 'conv-1' }),
      },
    };
    const adapter = {
      source: 'dsh',
      instance: 'instance-1',
      inventory: vi.fn(async () => ({
        workspaces: [{ id: 'ws-b', path: pathB, title: 'Workspace B' }],
        sessions: [
          { id: 'in-a', workspaceId: 'ws-a', cwd: pathA, title: 'A session' },
          { id: 'in-b', workspaceId: 'ws-b', cwd: pathB, title: 'B session' },
        ],
      })),
      snapshot: vi.fn(async () => ({ version: 'v1', turns: [turn('甲')] })),
    };
    const sync = new SessionSync({
      application: { importSessions },
      conversations: { library, adapters: [adapter] },
    });

    const result = await sync.run(storeB, {});
    expect(result.sessions).toBe(1);
    expect(result.saved).toBe(1);
    expect(importSessions).toHaveBeenCalledTimes(1);
    expect(importSessions.mock.calls[0][0]).toBe(storeB);
    expect(importSessions.mock.calls[0][1].selections[0].id).toBe('conv-1');
    // Access is granted only to the destination workspace.
    expect(allow).toHaveBeenCalledWith('owner', 'B', { id: 'source-scope' });
  });

  it('isolates one failing adapter while another adapter still imports', async () => {
    root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-iso-'));
    const pathB = join(root, 'ws-b');
    await mkdir(pathB, { recursive: true });
    const storeB = fakeStore('B', pathB);
    const library = {
      owner: 'owner',
      ready: async () => {},
      store: {
        scope: async () => ({ id: 'source-scope' }),
        allow: async () => {},
        put: async () => ({ conversationId: 'conv-1' }),
      },
    };
    const broken = {
      source: 'codex',
      instance: 'old',
      inventory: async () => {
        throw new Error('CODEX_UNAVAILABLE');
      },
    };
    const healthy = {
      source: 'dsh',
      instance: 'instance-1',
      inventory: async () => ({
        workspaces: [{ id: 'ws-b', path: pathB }],
        sessions: [{ id: 'in-b', workspaceId: 'ws-b', cwd: pathB, title: 'B session' }],
      }),
      snapshot: async () => ({ version: 'v1', turns: [turn('甲')] }),
    };
    const sync = new SessionSync({
      application: {
        importSessions: async () => ({
          saved: 1,
          skipped: 0,
          results: [{ status: 'saved', sourceId: 'doc-1' }],
        }),
      },
      conversations: { library, adapters: [broken, healthy] },
    });

    const result = await sync.run(storeB, {});
    expect(result.failed).toBe(1);
    expect(result.saved).toBe(1);
  });
});

describe('Knowledge V2 daily scheduler cross-workspace behavior', () => {
  const atScheduledMinute = () => new Date('2026-11-10T18:00:00Z'); // 02:00 Asia/Shanghai

  function applicationFor(stores, options = {}) {
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
      importFiles: vi.fn(async (store) => {
        if (options.failWorkspaces?.includes(store.scope.workspaceId)) {
          throw new Error('IMPORT_BROKEN');
        }
        return { failed: 0, results: [{ status: 'saved', sourceId: 'source-1' }] };
      }),
      importSessions: vi.fn(async () => ({
        saved: 1,
        skipped: 0,
        results: [{ status: 'saved', sourceId: 'doc-1' }],
      })),
      enqueueCompile: vi.fn(async () => ({ id: 'job-1', status: 'queued' })),
    };
  }

  it('runs A and B with separate stores, isolates failures, and never repeats the same day', async () => {
    const stores = {
      A: fakeStore('A', '/a'),
      B: fakeStore('B', '/b'),
    };
    stores.A.sources.mockResolvedValue({
      sources: [{ id: 'f-a', kind: 'file', status: 'active', origin: { relativePath: 'a.md' } }],
    });
    stores.B.sources.mockResolvedValue({
      sources: [{ id: 'f-b', kind: 'file', status: 'active', origin: { relativePath: 'b.md' } }],
    });
    const application = applicationFor(stores, { failWorkspaces: ['A'] });
    let scheduler;
    scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => ({
        general: { timeZone: 'Asia/Shanghai' },
        knowledgeV2: values({ dailyUpdateEnabled: true, dailyUpdateTime: '02:00' }),
      }),
      configSaver: vi.fn(),
    });

    const results = await scheduler.runDue(atScheduledMinute());
    expect(results.map((item) => item.workspaceId).sort()).toEqual(['A', 'B']);
    expect(application.scope.mock.calls.map((call) => call[0])).toEqual(['A', 'B']);
    // A's failure did not block B's file import and compile.
    expect(application.importFiles.mock.calls.map((call) => call[0])).toEqual([stores.A, stores.B]);
    expect(application.enqueueCompile).toHaveBeenCalledTimes(1);
    expect(application.enqueueCompile.mock.calls[0][0]).toBe(stores.B);
    expect(scheduler.state('A').state).toBe('error');
    expect(scheduler.state('B').state).toBe('idle');
    expect(scheduler.state('A').error).toBe('IMPORT_BROKEN');
    expect(scheduler['dailyRunning'].size).toBe(0);

    // B already completed today; the failed workspace is retried on the same tick
    // (batch request keys stay idempotent), while B is never re-run.
    const repeat = await scheduler.runDue(atScheduledMinute());
    expect(repeat.map((item) => item.workspaceId)).toEqual(['A']);
    expect(application.importFiles).toHaveBeenCalledTimes(3);
    expect(application.enqueueCompile).toHaveBeenCalledTimes(1);
    await scheduler.close();
  });

  it('keeps file sync and Wiki compiling when the session source is unavailable', async () => {
    const stores = { B: fakeStore('B', '/b') };
    stores.B.sources.mockResolvedValue({
      sources: [{ id: 'f-b', kind: 'file', status: 'active', origin: { relativePath: 'b.md' } }],
    });
    const application = applicationFor(stores);
    Object.defineProperty(application, 'conversations', {
      get() {
        throw new Error('SESSION_LIBRARY_UNAVAILABLE');
      },
    });
    const onError = vi.fn();
    const scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => ({
        general: { timeZone: 'Asia/Shanghai' },
        knowledgeV2: values({
          dailyUpdateEnabled: true,
          dailyUpdateTime: '02:00',
          dailyImportConversations: true,
        }),
      }),
      configSaver: vi.fn(),
      onError,
    });

    const [result] = await scheduler.runDue(atScheduledMinute());
    expect(result.fileFailed).toBe(0);
    expect(result.sessionFailed).toBe(1);
    expect(application.importFiles).toHaveBeenCalledTimes(1);
    expect(application.enqueueCompile).toHaveBeenCalledTimes(1);
    expect(scheduler.state('B').state).toBe('idle');
    expect(onError).toHaveBeenCalled();
    await scheduler.close();
  });

  it('delegates conversation import to the store of the workspace being synced', async () => {
    const stores = { B: fakeStore('B', '/b') };
    stores.B.sources.mockResolvedValue({ sources: [] });
    const application = applicationFor(stores);
    application.conversations = {
      library: {
        ready: async () => {},
      },
      adapters: [],
    };
    const scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => ({
        general: { timeZone: 'Asia/Shanghai' },
        knowledgeV2: values({
          dailyUpdateEnabled: true,
          dailyUpdateTime: '02:00',
          dailyImportConversations: true,
        }),
      }),
      configSaver: vi.fn(),
    });

    const result = await scheduler.runDaily('B', '2026-11-11', {});
    expect(result.workspaceId).toBe('B');
    expect(result.sessions).toBe(0);
    await scheduler.close();
  });

  it('keeps debounce timers and flush results per workspace scope', async () => {
    const stores = { A: fakeStore('A', '/a'), B: fakeStore('B', '/b') };
    const application = applicationFor(stores);
    const scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => ({
        general: { timeZone: 'Asia/Shanghai' },
        knowledgeV2: values({ autoManage: true, autoManageDelayMs: 10 }),
      }),
      configSaver: vi.fn(),
    });

    await scheduler.capture('A', 'a.md');
    await scheduler.capture('B', 'b.md');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await Promise.all([...scheduler.tasks]);

    expect(application.importFiles).toHaveBeenCalledTimes(2);
    const byWorkspace = new Map(
      application.importFiles.mock.calls.map(([store, input]) => [
        store.scope.workspaceId,
        input.files,
      ]),
    );
    expect(byWorkspace.get('A')).toEqual([{ relativePath: 'a.md' }]);
    expect(byWorkspace.get('B')).toEqual([{ relativePath: 'b.md' }]);
    expect(application.enqueueCompile).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it('drops a pending debounce flush on close without invoking the application', async () => {
    const stores = { A: fakeStore('A', '/a') };
    const application = applicationFor(stores);
    const scheduler = new KnowledgeSyncScheduler({
      application,
      configLoader: async () => ({
        general: { timeZone: 'Asia/Shanghai' },
        knowledgeV2: values({ autoManage: true, autoManageDelayMs: 60000 }),
      }),
      configSaver: vi.fn(),
    });

    await scheduler.capture('A', 'a.md');
    await scheduler.close();
    expect(application.importFiles).not.toHaveBeenCalled();
    expect(application.enqueueCompile).not.toHaveBeenCalled();
  });
});

describe('Knowledge V2 context reads imported source content', () => {
  it('resolves content paths under the scope directory and exposes entries, lookup and search', async () => {
    root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-ctx-'));
    const workspace = { id: 'ws-1', title: 'Workspace', path: join(root, 'ws') };
    await mkdir(join(workspace.path, 'docs', 'alice'), { recursive: true });
    await writeFile(join(workspace.path, 'docs', 'alice', 'a.md'), '# A\n正文内容', 'utf8');
    const scope = await resolveScope({
      root: join(root, 'data'),
      workspace,
      docsDir: 'docs',
    });
    const store = new ScopeStore(scope);
    await store.init();
    const imported = await importFiles(store, {
      files: [{ relativePath: 'alice/a.md' }],
    });
    const sourceId = imported.results[0].sourceId;

    const application = {
      registry: { list: () => [workspace] },
      root: join(root, 'data'),
      scope: async () => store,
      release: async () => null,
    };
    const context = new KnowledgeContext(application);
    const kbScope = await context.scope('ws-1');

    const entry = kbScope.store.entry(sourceId);
    expect(entry).not.toBeNull();
    expect(entry.body).toContain('正文内容');
    // Enhancement/writing consumers require the projected status to be 'active'.
    expect(entry.sources[0].status).toBe('active');
    expect(kbScope.store.entryByPath('alice/a.md')).not.toBeNull();
    const { hits } = kbScope.store.search('正文', 1);
    expect(hits[0].id).toBe(sourceId);
  });

  it('keeps excluded sources out of entries and search results', async () => {
    root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-excl-'));
    const workspace = { id: 'ws-1', title: 'Workspace', path: join(root, 'ws') };
    await mkdir(join(workspace.path, 'docs'), { recursive: true });
    const scope = await resolveScope({
      root: join(root, 'data'),
      workspace,
      docsDir: 'docs',
    });
    const store = new ScopeStore(scope);
    await store.init();
    await store.writeSources({
      schemaVersion: 1,
      sources: [
        {
          id: 'excluded-1',
          kind: 'file',
          title: 'Old',
          status: 'excluded',
          revision: 'rev-1',
          rawHash: 'h',
          origin: { relativePath: 'old.md' },
          contentPath: 'raw/content.md',
        },
      ],
    });

    const application = {
      registry: { list: () => [workspace] },
      root: join(root, 'data'),
      scope: async () => store,
      release: async () => null,
    };
    const context = new KnowledgeContext(application);
    const kbScope = await context.scope('ws-1');

    expect(kbScope.store.entry('excluded-1')).toBeNull();
    expect(kbScope.store.entryByPath('old.md')).toBeNull();
    expect(kbScope.store.activeDocumentMetadata()).toEqual([]);
    expect(kbScope.store.search('old', 8).hits).toEqual([]);
  });
});

describe('Knowledge V2 application scope configuration', () => {
  it('resolves scopes through the injected config loader instead of the default one', async () => {
    root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-app-'));
    const workspace = { id: 'ws-1', title: 'Workspace', path: join(root, 'ws') };
    await mkdir(workspace.path, { recursive: true });
    const configLoader = vi.fn(async () => ({ docsDir: 'docs' }));
    const application = createKnowledgeApplication({
      ctx: {
        tools: { register: () => () => {}, guard: () => () => {} },
        on: () => () => {},
      },
      registry: { list: () => [workspace] },
      profileDir: join(root, 'profile'),
      configLoader,
      configSaver: vi.fn(),
    });

    const store = await application.scope('ws-1');
    expect(configLoader).toHaveBeenCalled();
    expect(store.scope.workspaceId).toBe('ws-1');
    expect(store.scope.docsRoot).toBe(join(await realpath(workspace.path), 'docs'));
    await application.close();
  });
});

describe('Knowledge V2 session sync warnings', () => {
  it('reports adapter inventory warnings without counting them as failures', async () => {
    root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-warn-'));
    const pathB = join(root, 'ws-b');
    await mkdir(pathB, { recursive: true });
    const storeB = fakeStore('B', pathB);
    const warnings = [];
    const items = [];
    const library = {
      owner: 'owner',
      ready: async () => {},
      store: {
        scope: async () => ({ id: 'source-scope' }),
        allow: async () => {},
      },
    };
    const adapter = {
      source: 'dsh',
      instance: 'instance-1',
      inventory: async () => ({
        workspaces: [{ id: 'ws-b', path: pathB, title: 'Workspace B' }],
        sessions: [],
        warnings: ['legacy index rebuild in progress'],
      }),
    };
    const sync = new SessionSync({
      application: { importSessions: async () => ({ saved: 0, skipped: 0, results: [] }) },
      conversations: { library, adapters: [adapter] },
    });

    const result = await sync.run(storeB, {
      report: (entry) => warnings.push(entry),
      onItem: (entry) => items.push(entry),
    });
    expect(result.failed).toBe(0);
    expect(warnings[0]).toMatchObject({
      source: 'dsh',
      code: 'KB_SESSION_IMPORT_WARNING',
      diagnostic: 'legacy index rebuild in progress',
    });
    expect(items[0].status).toBe('warning');
  });
});
