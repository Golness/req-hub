/**
 * Sync State 基础测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs modules
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/server/logger.js', () => ({
  log: {
    state: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

// 必须在 mock 之后 import
const {
  loadState,
  getActiveSync,
  setActiveSync,
  completeSync,
  updateSyncProgress,
  getSyncHistory,
  getSyncById,
  deleteSyncFromHistory,
  setAbortController,
  getAbortController,
  deleteAbortController,
  abortSync,
} = await import('../../src/server/sync-state.js');

const { existsSync } = await import('fs');
const { readFile, writeFile, mkdir, rename } = await import('fs/promises');

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(false);
});

describe('loadState', () => {
  it('recovers a task interrupted by a server restart into failed history', async () => {
    existsSync.mockReturnValue(true);
    readFile.mockResolvedValueOnce(JSON.stringify({ schemaVersion: 2, activeSync: { id: 'interrupted', status: 'running', startedAt: 1 }, history: [] }));
    const state = await loadState('ws-restart', 'req-restart', '/docs/restart');
    expect(state.activeSync).toBeNull();
    expect(state.history[0]).toMatchObject({ id: 'interrupted', status: 'failed' });
    expect(state.timeline[0].status).toBe('failed');
  });

  it('refuses a corrupt state instead of discarding its historical baseline', async () => {
    existsSync.mockReturnValue(true);
    readFile.mockResolvedValueOnce('{broken');
    await expect(loadState('ws-corrupt', 'req-corrupt', '/docs/corrupt')).rejects.toThrow('保护历史基准');
  });

  it('should return undefined for missing params', async () => {
    const result = await loadState(null, 'req1', '/path');
    expect(result).toBeUndefined();
  });

  it('should initialize empty state when file does not exist', async () => {
    existsSync.mockReturnValue(false);
    const result = await loadState('ws1', 'req1', '/docs/dev/req1');
    expect(result).toEqual({ schemaVersion: 2, activeSync: null, history: [] });
  });

  it('should load state from disk when file exists', async () => {
    const saved = { schemaVersion: 2, activeSync: null, history: [] };
    existsSync.mockReturnValue(true);
    readFile.mockResolvedValue(JSON.stringify(saved));

    const result = await loadState('ws-disk', 'req-disk', '/docs/dev/req-disk');
    expect(result).toEqual({ ...saved, timeline: [] });
  });

  it('should return cached state on second call', async () => {
    existsSync.mockReturnValue(true);
    readFile.mockResolvedValue(JSON.stringify({ schemaVersion: 2, activeSync: null, history: [] }));

    await loadState('ws1', 'req-cached', '/docs/dev/req-cached');
    // Second call should use cache (readFile not called again for same key)
    const callCount = readFile.mock.calls.length;
    const result = await loadState('ws1', 'req-cached', '/docs/dev/req-cached');
    expect(readFile.mock.calls.length).toBe(callCount); // no additional reads
    expect(result).toBeDefined();
  });
});

describe('setActiveSync / getActiveSync', () => {
  it('should set and get active sync', async () => {
    existsSync.mockReturnValue(false);
    const sync = { id: 'sync-1', workspaceId: 'ws1', requirementId: 'req1', status: 'running' };

    await setActiveSync(sync, '/docs/dev/req1');
    const active = await getActiveSync('ws1', 'req1');
    expect(active).toEqual(sync);
  });

  it('should warn when called without required fields', async () => {
    await setActiveSync({ id: 'x' });
    // Should not throw, just warn
  });
});

describe('completeSync', () => {
  it('scopes identical commit IDs to their workspace and requirement', async () => {
    const first = { id: 'same-commit', workspaceId: 'ws-scope-a', requirementId: 'req-scope', status: 'running' };
    const second = { id: 'same-commit', workspaceId: 'ws-scope-b', requirementId: 'req-scope', status: 'running' };
    await setActiveSync(first, '/docs/scope-a'); await setActiveSync(second, '/docs/scope-b');
    await updateSyncProgress(second.id, { status: 'completed' }, second.workspaceId, second.requirementId);
    await completeSync(second.id, second.workspaceId, second.requirementId);
    expect(await getActiveSync(first.workspaceId, first.requirementId)).toBe(first);
    expect(first.status).toBe('running');
    expect((await getSyncHistory(second.workspaceId, second.requirementId))[0].status).toBe('completed');
  });

  it('persists timeline data and keeps successful baselines beyond 50 records', async () => {
    const state = await loadState('ws-long-history', 'req-long-history', '/docs/dev/long-history');
    state.history = Array.from({ length: 50 }, (_, index) => ({ id: `old-${index}`, status: 'completed', startedAt: 1, commitHash: `hash-${index}` }));
    await setActiveSync({ id: 'new-success', workspaceId: 'ws-long-history', requirementId: 'req-long-history', status: 'completed', startedAt: 2 }, '/docs/dev/long-history');
    await completeSync('new-success');
    expect(state.history).toHaveLength(51);
    expect(state.timeline).toHaveLength(51);
    expect(state.timeline[0].status).toBe('completed');
  });

  it('rejects disk failures and restores the active task for error recovery', async () => {
    const task = { id: 'disk-failure', workspaceId: 'ws-disk-failure', requirementId: 'req-disk-failure', status: 'completed' };
    await setActiveSync(task, '/docs/dev/disk-failure');
    rename.mockRejectedValueOnce(new Error('disk full'));
    await expect(completeSync(task.id)).rejects.toThrow('disk full');
    expect(await getActiveSync(task.workspaceId, task.requirementId)).toBe(task);
    expect(await getSyncHistory(task.workspaceId, task.requirementId)).toHaveLength(0);
    task.status = 'failed';
    await completeSync(task.id);
    expect((await getSyncHistory(task.workspaceId, task.requirementId))[0].status).toBe('failed');
  });

  it('should move active sync to history', async () => {
    existsSync.mockReturnValue(false);
    const sync = { id: 'sync-complete', workspaceId: 'ws2', requirementId: 'req2', status: 'running' };

    await setActiveSync(sync, '/docs/dev/req2');
    await completeSync('sync-complete');

    const active = await getActiveSync('ws2', 'req2');
    expect(active).toBeNull();

    const history = await getSyncHistory('ws2', 'req2');
    expect(history.length).toBe(1);
    expect(history[0].id).toBe('sync-complete');
    expect(history[0].completedAt).toBeDefined();
  });

  it('should do nothing for unknown syncId', async () => {
    await completeSync('nonexistent');
    // Should not throw
  });
});

describe('updateSyncProgress', () => {
  it('should update active sync fields', async () => {
    existsSync.mockReturnValue(false);
    const sync = { id: 'sync-prog', workspaceId: 'ws3', requirementId: 'req3', status: 'running', progress: 0 };

    await setActiveSync(sync, '/docs/dev/req3');
    await updateSyncProgress('sync-prog', { progress: 50 });

    const active = await getActiveSync('ws3', 'req3');
    expect(active.progress).toBe(50);
  });
});

describe('getSyncById', () => {
  it('should find active sync', async () => {
    existsSync.mockReturnValue(false);
    const sync = { id: 'sync-find', workspaceId: 'ws4', requirementId: 'req4', status: 'running' };

    await setActiveSync(sync, '/docs/dev/req4');
    const found = await getSyncById('sync-find', 'ws4', 'req4');
    expect(found.id).toBe('sync-find');
  });

  it('should find sync in history', async () => {
    existsSync.mockReturnValue(false);
    const sync = { id: 'sync-hist', workspaceId: 'ws5', requirementId: 'req5', status: 'running' };

    await setActiveSync(sync, '/docs/dev/req5');
    await completeSync('sync-hist');

    const found = await getSyncById('sync-hist', 'ws5', 'req5');
    expect(found.id).toBe('sync-hist');
  });
});

describe('deleteSyncFromHistory', () => {
  it('should remove sync from history', async () => {
    existsSync.mockReturnValue(false);
    const sync = { id: 'sync-del', workspaceId: 'ws6', requirementId: 'req6', status: 'running' };

    await setActiveSync(sync, '/docs/dev/req6');
    await completeSync('sync-del');

    let history = await getSyncHistory('ws6', 'req6');
    expect(history.length).toBe(1);

    await deleteSyncFromHistory('sync-del', 'ws6', 'req6');
    history = await getSyncHistory('ws6', 'req6');
    expect(history.length).toBe(0);
  });
});

describe('abort controllers', () => {
  it('should set, get, and delete abort controller', () => {
    const controller = new AbortController();
    setAbortController('ws7', 'req7', controller, 'sync-abort');

    const info = getAbortController('ws7', 'req7');
    expect(info.controller).toBe(controller);
    expect(info.syncId).toBe('sync-abort');

    deleteAbortController('ws7', 'req7');
    expect(getAbortController('ws7', 'req7')).toBeUndefined();
  });
});

describe('abortSync', () => {
  it('should fail when no active sync', async () => {
    const result = await abortSync('no-sync', 'ws8', 'req8', {}, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('没有正在运行');
  });

  it('keeps cancellation active until the run owner finishes cleanup, then archives it', async () => {
    existsSync.mockReturnValue(false);
    const sync = { id: 'sync-abort-active', workspaceId: 'ws9', requirementId: 'req9', status: 'running' };

    await setActiveSync(sync, '/docs/dev/req9');
    const controller = new AbortController();
    setAbortController('ws9', 'req9', controller, 'sync-abort-active');

    const result = await abortSync('sync-abort-active', 'ws9', 'req9', {}, {});
    expect(result.success).toBe(true);

    const active = await getActiveSync('ws9', 'req9');
    expect(active.status).toBe('cancelling');
    expect(controller.signal.aborted).toBe(true);
    expect(await getSyncHistory('ws9', 'req9')).toHaveLength(0);
    await completeSync(sync.id, 'ws9', 'req9');
    expect(await getActiveSync('ws9', 'req9')).toBeNull();

    const history = await getSyncHistory('ws9', 'req9');
    expect(history.length).toBe(1);
    expect(history[0].status).toBe('aborted');
  });
});
