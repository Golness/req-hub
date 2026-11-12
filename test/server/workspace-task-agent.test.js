import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createWorkspaceTaskAgent } from '../../src/server/workspace-task-agent.js';
import { listRelatedSessions } from '../../src/server/session-selector.js';
import { installWorkspaceTaskAgents } from '../helpers/workspace-task-agent.js';

let root, ctx, workspaces;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqhub-workspace-agent-'));
  workspaces = ['a', 'b'].map((id) => ({ id, path: join(root, id) }));
  await Promise.all(workspaces.map((workspace) => mkdir(workspace.path)));
  ctx = installWorkspaceTaskAgents({
    agents: {
      get: vi.fn(() => {
        throw new Error('Must not borrow a user session');
      }),
      list: vi.fn(() => {
        throw new Error('Must not borrow a user session');
      }),
    },
  });
});
afterEach(async () => {
  const child = relative(tmpdir(), root);
  if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('reqhub-workspace-agent-')) {
    throw new Error('Unsafe test cleanup');
  }
  await rm(root, { recursive: true, force: true });
});

it('creates independent empty owners in two workspaces without inspecting live sessions', async () => {
  const signal = new AbortController().signal;
  const handles = await Promise.all(
    workspaces.map((workspace) => createWorkspaceTaskAgent(ctx, workspace, signal)),
  );
  try {
    expect(new Set(handles.map(({ agent }) => agent.session.id)).size).toBe(2);
    for (const [index, handle] of handles.entries()) {
      const call = ctx.agents.create.mock.calls.find(
        ([options]) => options.sessionId === handle.agent.session.id,
      );
      expect(call[0]).toMatchObject({
        signal,
        meta: {
          cwd: await realpath(workspaces[index].path),
          origin: 'subagent',
          agentPreset: 'default',
        },
        agentOptions: { provider: 'test', model: 'test' },
      });
      expect(call[0].parentAgent).toBeUndefined();
      expect(call[0].seed).toBeUndefined();
    }
    expect(ctx.agentPresets.mount).toHaveBeenCalledTimes(2);
    expect(ctx.agents.get).not.toHaveBeenCalled();
    expect(ctx.agents.list).not.toHaveBeenCalled();
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose()));
  }
});

it('does not create an owner for a pre-cancelled task', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(createWorkspaceTaskAgent(ctx, workspaces[0], controller.signal)).rejects.toThrow(
    'cancelled',
  );
  expect(ctx.agents.create).not.toHaveBeenCalled();
});

it('awaits disposal when cancellation wins publication', async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const handle = { dispose: vi.fn(() => gate) };
  ctx.agents.create.mockImplementation(async () => {
    controller.abort(new Error('cancelled'));
    return handle;
  });
  let settled = false;
  const pending = createWorkspaceTaskAgent(ctx, workspaces[0], controller.signal).finally(() => {
    settled = true;
  });
  const failure = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(handle.dispose).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  release();
  await failure;
});

it('propagates preset and creation failures without borrowing another workspace', async () => {
  ctx.agentPresets.resolve = async () => {
    throw new Error('preset unavailable');
  };
  await expect(
    createWorkspaceTaskAgent(ctx, workspaces[0], new AbortController().signal),
  ).rejects.toThrow('preset unavailable');
  expect(ctx.agents.create).not.toHaveBeenCalled();
});

it('excludes background owners from durable and live conversation inventories', async () => {
  const header = { id: 'owned', cwd: root, origin: 'subagent' };
  const sessions = { list: () => [{ header }] };
  const sessionQuery = { listSessions: async () => [{ header }] };
  expect(await listRelatedSessions(sessions, root, { metadataOnly: true })).toEqual([]);
  expect(await listRelatedSessions(sessions, root, { sessionQuery, metadataOnly: true })).toEqual(
    [],
  );
});
