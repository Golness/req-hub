import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionSync } from '../../src/server/knowledge-v2/session-sync.js';

let root;
let workspaceA;
let workspaceB;
let outside;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqhub-v2-session-sync-'));
  workspaceA = join(root, 'a');
  workspaceB = join(root, 'b');
  outside = join(root, 'outside');
  await Promise.all([workspaceA, workspaceB, outside].map((path) => mkdir(path)));
});

afterEach(async () => {
  const child = relative(tmpdir(), root);
  if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('reqhub-v2-session-sync-')) {
    throw new Error('Unsafe test cleanup');
  }
  await rm(root, { recursive: true, force: true });
});

const snapshot = (id, empty = false) => ({
  version: `version-${id}`,
  turns: empty
    ? []
    : [
        {
          sourceTurnId: `turn-${id}`,
          turnNumber: 1,
          status: 'completed',
          syncable: true,
          messages: [
            { role: 'user', label: 'User', text: `Question ${id}` },
            { role: 'assistant', label: 'Assistant', text: `Answer ${id}` },
          ],
        },
      ],
});

function fixture(sessions, { importSessions } = {}) {
  const adapter = {
    source: 'dsh',
    instance: 'profile',
    inventory: vi.fn(async () => ({
      workspaces: [
        { id: 'A', title: 'Workspace A', path: workspaceA, paths: [workspaceA] },
        { id: 'B', title: 'Workspace B', path: workspaceB, paths: [workspaceB] },
        { id: 'outside', title: 'Outside', path: outside, paths: [outside] },
      ],
      sessions,
      warnings: [],
    })),
    snapshot: vi.fn(async (session) => snapshot(session.id)),
  };
  const library = {
    owner: 'profile',
    ready: vi.fn(async () => {}),
    store: {
      scope: vi.fn(async (_source, _instance, origin) => `scope-${origin.id}`),
      allow: vi.fn(async () => {}),
      put: vi.fn(async (_scope, details) => ({
        conversationId: `conversation-${details.id}`,
      })),
    },
  };
  const application = {
    importSessions: vi.fn(
      importSessions ||
        (async (_store, { selections }) => ({
          saved: 1,
          skipped: 0,
          results: [{ status: 'saved', sourceId: `source-${selections[0].id}` }],
        })),
    ),
  };
  return {
    adapter,
    library,
    application,
    sync: new SessionSync({ application, conversations: { library, adapters: [adapter] } }),
  };
}

const targetStore = () => ({
  scope: {
    workspaceId: 'B',
    workspace: { id: 'B', title: 'Workspace B', path: workspaceB },
  },
});

describe('V2 background session synchronization', () => {
  it('imports legacy turns that only expose userInput/summary', async () => {
    const sessions = [{ id: 'b-1', workspaceId: 'B', cwd: workspaceB, title: 'Legacy session' }];
    const { sync, adapter, application } = fixture(sessions);
    adapter.snapshot.mockResolvedValue({
      version: 'version-legacy',
      turns: [
        {
          sourceTurnId: 'turn-legacy',
          turnNumber: 1,
          status: 'completed',
          syncable: true,
          userInput: '旧版用户输入',
          summary: '旧版助手回复',
        },
      ],
    });
    const result = await sync.run(targetStore(), { signal: new AbortController().signal });
    expect(result.failed).toBe(0);
    expect(result.saved).toBe(1);
    expect(application.importSessions).toHaveBeenCalledTimes(1);
  });

  it('imports workspace B without reading the page or Agent session for workspace A', async () => {
    const currentPage = { workspaceId: 'A', agentSessionId: 'a-1' };
    const sessions = [
      { id: 'a-1', workspaceId: 'A', cwd: workspaceA, title: 'A session' },
      { id: 'b-1', workspaceId: 'B', cwd: workspaceB, title: 'B session' },
      { id: 'x-1', workspaceId: 'outside', cwd: outside, title: 'Outside session' },
    ];
    const { sync, adapter, library, application } = fixture(sessions);
    const store = targetStore();
    const result = await sync.run(store, { signal: new AbortController().signal });

    expect(currentPage.workspaceId).toBe('A');
    expect(result).toMatchObject({ sessions: 1, saved: 1, failed: 0 });
    expect(adapter.inventory).toHaveBeenCalledWith('B', expect.any(Object));
    expect(adapter.inventory.mock.calls[0][0]).not.toBe(currentPage.workspaceId);
    expect(adapter.snapshot).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot.mock.calls[0][0].id).toBe('b-1');
    expect(library.store.allow).toHaveBeenCalledWith('profile', 'B', 'scope-B');
    expect(application.importSessions).toHaveBeenCalledTimes(1);
    const [passedStore, input] = application.importSessions.mock.calls[0];
    expect(passedStore).toBe(store);
    expect(input).toMatchObject({
      selections: [{ id: 'conversation-b-1', version: 'version-b-1', turnKeys: ['id:turn-b-1'] }],
      ingest: false,
      mode: 'merge',
    });
    expect(JSON.stringify(input)).not.toContain(currentPage.agentSessionId);
  });

  it('keeps later sessions after one snapshot fails', async () => {
    const sessions = ['b-1', 'b-2', 'b-3'].map((id) => ({
      id,
      workspaceId: 'B',
      cwd: workspaceB,
      title: id,
    }));
    const { sync, adapter, application } = fixture(sessions);
    adapter.snapshot.mockImplementation(async (session) => {
      if (session.id === 'b-2') {
        throw new Error('snapshot failed');
      }
      return snapshot(session.id);
    });

    await expect(
      sync.run(targetStore(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      sessions: 3,
      saved: 2,
      failed: 1,
    });
    expect(application.importSessions).toHaveBeenCalledTimes(2);
  });

  it('bounds one background run to 20 sessions', async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      id: `b-${index}`,
      workspaceId: 'B',
      cwd: workspaceB,
      title: `Session ${index}`,
    }));
    const { sync, application } = fixture(sessions);

    await expect(
      sync.run(targetStore(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      sessions: 20,
      saved: 20,
      failed: 0,
    });
    expect(application.importSessions).toHaveBeenCalledTimes(20);
  });
});
