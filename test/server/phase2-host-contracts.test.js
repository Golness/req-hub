import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installSyncTools } from '../../src/server/sync-controlled-tools.js';
import { bindOwnedSession } from '../../src/server/delegation-context.js';
import { SyncDailyScheduler } from '../../src/server/sync-daily-scheduler.js';
import { createSyncHarness } from './sync-v2-harness.js';
import { WritingRuntime, installWritingTools } from '../../src/server/writing-runtime.js';
import { KbTaskRuntime, installKbTaskTools } from '../../src/server/knowledge-v2/runtime.js';
import {
  installSyncSessionProjection,
  foldSyncSessionFacts,
  SYNC_SESSION_PROJECTION,
} from '../../src/server/sync-session-projection.js';

afterEach(() => vi.useRealTimers());

it.each([
  ['writing', installWritingTools, () => new WritingRuntime([], [])],
  ['knowledge', installKbTaskTools, () => new KbTaskRuntime({ kind: 'ingest', documents: [] })],
])(
  'revokes %s completion listeners on runtime close and plugin disposal',
  (_name, install, create) => {
    const h = createSyncHarness();
    const dispose = vi.fn();
    const on = vi.fn(() => dispose);
    h.ctx.agents = { get: () => ({ ctx: { on } }) };
    const installation = install(h.ctx);
    const first = create();
    installation.add(first);
    bindOwnedSession(first, 'child-one');
    bindOwnedSession(first, 'child-one');
    expect(on).toHaveBeenCalledTimes(1);
    installation.close(first);
    expect(dispose).toHaveBeenCalledTimes(1);
    const second = create();
    installation.add(second);
    bindOwnedSession(second, 'child-two');
    installation.dispose();
    expect(second.closed).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(2);
  },
);

it('scopes completion steering to the published child and revokes it with the runtime', () => {
  const h = createSyncHarness();
  const registrations = new Map();
  const dispose = vi.fn();
  h.ctx.agents = {
    get: (id) => ({
      ctx: {
        on: (name, listener) => {
          registrations.set(id, { name, listener });
          return dispose;
        },
      },
    }),
  };
  const installation = installSyncTools(h.ctx);
  const runtime = installation.create({ store: {}, allowed: [], required: [], outputs: {} });
  bindOwnedSession(runtime, 'owned-child');
  bindOwnedSession(runtime, 'owned-child');
  expect(registrations.size).toBe(1);
  expect(registrations.get('owned-child').name).toBe('agent/turn-stopping');
  expect(h.hooks.has('agent/turn-stopping')).toBe(false);
  runtime.close();
  expect(dispose).toHaveBeenCalledTimes(1);
  installation.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it('rearms an idle short timer when its backend changes and waits for active work on close', async () => {
  vi.useFakeTimers();
  const scheduler = new SyncDailyScheduler({});
  scheduler.check = vi.fn(async () => {});
  await scheduler.refresh();
  const callbacks = [];
  const disposers = [];
  scheduler.useTimeout((callback, delay) => {
    expect(delay).toBe(30000);
    callbacks.push(callback);
    const dispose = vi.fn();
    disposers.push(dispose);
    return dispose;
  });
  expect(vi.getTimerCount()).toBe(0);
  let complete;
  scheduler.check.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  callbacks[0]();
  await Promise.resolve();
  await Promise.resolve();
  let closed = false;
  const closing = scheduler.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(scheduler.controller.signal.aborted).toBe(true);
  complete();
  await closing;
  expect(callbacks).toHaveLength(1);
  expect(disposers[0]).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps projection references stable for unrelated events and resets failures on a new turn', () => {
  const state = { compacted: false, failure: null };
  expect(foldSyncSessionFacts(state, { type: 'message' })).toBe(state);
  const failed = foldSyncSessionFacts(state, {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { code: 'FAILED', message: 'Reason' } } },
  });
  expect(state.failure).toBeNull();
  expect(failed.failure).toEqual({ code: 'FAILED', message: 'Reason' });
  expect(foldSyncSessionFacts(failed, { type: 'turn/start' }).failure).toBeNull();
  const compacted = foldSyncSessionFacts(state, { type: 'compaction/prune' });
  expect(foldSyncSessionFacts(compacted, { type: 'compaction/summary' })).toBe(compacted);
});

const dsh = resolve(import.meta.dirname, '../../../deepseek-harness');
const available = existsSync(join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'));
const load = (path) => import(/* @vite-ignore */ pathToFileURL(path).href);
it.skipIf(!available)(
  'replays sync facts and removes the registration with real DSH projections',
  async () => {
    const requireHost = createRequire(
      join(dsh, 'packages/test-support/agent-loop-testkit/package.json'),
    );
    const { Context } = await load(requireHost.resolve('@deepseek-ai/cordis'));
    const { mountAgentLoopTestDependencies } = await load(
      join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'),
    );
    const ctx = new Context();
    try {
      await mountAgentLoopTestDependencies(ctx);
      const dispose = installSyncSessionProjection(ctx.sessionProjections);
      const session = ctx.sessions.create('phase2-projection');
      const initial = ctx.sessionProjections.stateOf(session, SYNC_SESSION_PROJECTION);
      session.append('turn/start', { turn: 1 });
      expect(ctx.sessionProjections.stateOf(session, SYNC_SESSION_PROJECTION)).toBe(initial);
      session.append('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'PROVIDER_ERROR', message: 'Failure' } },
      });
      const failed = ctx.sessionProjections.stateOf(session, SYNC_SESSION_PROJECTION);
      expect(failed.failure.code).toBe('PROVIDER_ERROR');
      const replay = ctx.sessions.create('phase2-replay', { seed: session.snapshotEvents() });
      expect(ctx.sessionProjections.stateOf(replay, SYNC_SESSION_PROJECTION)).toEqual(failed);
      dispose();
      expect(ctx.sessionProjections.stateOf(session, SYNC_SESSION_PROJECTION)).toBeUndefined();
    } finally {
      await ctx.fiber.dispose();
    }
  },
);
