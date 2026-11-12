import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { executeTask } from '../../src/server/task-executor.js';
import {
  getSubagentScheduler,
  configureSubagentScheduler,
  installSubagentScheduler,
} from '../../src/server/concurrency/SubagentScheduler.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const completed = { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] };
let ctx, scheduler, runs, tasks, config;

beforeEach(() => {
  runs = [];
  tasks = [];
  config = { ai: { delegation: { maxConcurrency: 2 } } };
  ctx = {
    skills: { get: async () => null },
    subagents: {
      getProvider: () => ({ capabilities: { agentOptions: true } }),
      start: vi.fn(async (_provider, options) => {
        const result = deferred();
        const disposed = deferred();
        const run = {
          id: 'child-' + runs.length,
          label: options.label,
          result: result.promise,
          finish: () => result.resolve(completed),
          release: disposed.resolve,
          dispose: vi.fn(async () => {
            await disposed.promise;
          }),
        };
        options.signal.addEventListener(
          'abort',
          () => {
            result.resolve({ stopReason: 'aborted', output: [] });
          },
          { once: true },
        );
        runs.push(run);
        return run;
      }),
    },
  };
  scheduler = getSubagentScheduler(ctx.subagents, config);
});

afterEach(async () => {
  scheduler.beginClose();
  for (const run of runs) {
    run.finish();
    run.release();
  }
  await Promise.allSettled(tasks);
  await scheduler.close();
});

function task(label, signal, taskConfig = config) {
  const pending = executeTask({ ...ctx }, {}, taskConfig, {
    description: label,
    parentAgent: { status: 'idle', session: { id: 'parent-' + label } },
    signal,
    preparedPromptData: { fullPrompt: 'Bounded test task', skillStatus: 'not_bound' },
    liveness: { enabled: false },
  });
  tasks.push(pending);
  return pending;
}

it('shares FIFO child capacity between features and parents, and holds it until disposal settles', async () => {
  const first = task('sync');
  task('wiki');
  task('writing');
  task('enhancement');
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(scheduler.semaphore.waitingCount).toBe(2);
  runs[0].finish();
  await vi.waitFor(() => expect(runs[0].dispose).toHaveBeenCalled());
  expect(runs).toHaveLength(2);
  runs[0].release();
  await first;
  await vi.waitFor(() => expect(runs).toHaveLength(3));
  expect(runs[2].label).toBe('writing');
  runs[1].finish();
  runs[1].release();
  await vi.waitFor(() => expect(runs).toHaveLength(4));
  expect(runs[3].label).toBe('enhancement');
});

it('cancels one queued caller without starting it or aborting sibling requests', async () => {
  scheduler.configure(1);
  task('sync');
  const controller = new AbortController();
  const cancelled = task('cancelled-wiki', controller.signal);
  task('writing');
  await vi.waitFor(() => expect(scheduler.semaphore.waitingCount).toBe(2));
  controller.abort();
  expect(await cancelled).toMatchObject({ errorCode: 'TASK_CANCELLED', success: false });
  expect(runs).toHaveLength(1);
  runs[0].finish();
  runs[0].release();
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1].label).toBe('writing');
});

it('resizes one live queue without preempting owners or accepting stale task configuration', async () => {
  scheduler.configure(1);
  for (const label of ['sync', 'wiki-one', 'wiki-two', 'writing']) {
    task(label);
  }
  await vi.waitFor(() => expect(scheduler.semaphore.waitingCount).toBe(3));
  configureSubagentScheduler(ctx.subagents, { ai: { delegation: { maxConcurrency: 3 } } });
  await vi.waitFor(() => expect(runs).toHaveLength(3));
  configureSubagentScheduler(ctx.subagents, { ai: { delegation: { maxConcurrency: 1 } } });
  task('stale-config', undefined, { ai: { delegation: { maxConcurrency: 16 } } });
  expect(scheduler.semaphore.maxConcurrency).toBe(1);
  runs[0].finish();
  runs[0].release();
  runs[1].finish();
  runs[1].release();
  await tasks[0];
  await tasks[1];
  expect(runs).toHaveLength(3);
  runs[2].finish();
  runs[2].release();
  await vi.waitFor(() => expect(runs).toHaveLength(4));
  expect(runs[3].label).toBe('writing');
});

it('drains live disposal during shutdown and rejects queued and late callers until reactivation', async () => {
  scheduler.configure(1);
  task('running');
  const queued = task('queued');
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  let closed = false;
  const closing = scheduler.close().then(() => {
    closed = true;
  });
  expect(await queued).toMatchObject({ errorCode: 'TASK_CANCELLED' });
  expect(await task('late')).toMatchObject({ errorCode: 'TASK_CANCELLED' });
  expect(getSubagentScheduler(ctx.subagents)).toBe(scheduler);
  expect(() => installSubagentScheduler(ctx.subagents)).toThrow('SUBAGENT_SCHEDULER_DRAINING');
  await vi.waitFor(() => expect(runs[0].dispose).toHaveBeenCalled());
  expect(closed).toBe(false);
  runs[0].release();
  await closing;
  expect(runs).toHaveLength(1);
  expect(installSubagentScheduler(ctx.subagents)).not.toBe(scheduler);
});

it('releases a failed startup reservation so a queued feature can proceed', async () => {
  scheduler.configure(1);
  ctx.subagents.start.mockRejectedValueOnce(new Error('START_FAILED'));
  const failed = task('sync');
  task('wiki');
  expect(await failed).toMatchObject({ success: false, diagnostic: 'START_FAILED' });
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  expect(runs[0].label).toBe('wiki');
});

it('holds capacity for a late startup handle until its cancelled child has been disposed', async () => {
  scheduler.configure(1);
  const publish = deferred();
  const start = ctx.subagents.start.getMockImplementation();
  ctx.subagents.start.mockImplementationOnce(async (...args) => {
    await publish.promise;
    return start(...args);
  });
  const controller = new AbortController();
  const cancelled = task('sync', controller.signal);
  task('wiki');
  try {
    await vi.waitFor(() => expect(ctx.subagents.start).toHaveBeenCalledOnce());
    controller.abort();
    expect(runs).toHaveLength(0);
    expect(scheduler.semaphore.runningCount).toBe(1);
    publish.resolve();
    await vi.waitFor(() => expect(runs[0].dispose).toHaveBeenCalled());
    expect(runs).toHaveLength(1);
    runs[0].release();
    expect(await cancelled).toMatchObject({ errorCode: 'TASK_CANCELLED' });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1].label).toBe('wiki');
  } finally {
    publish.resolve();
  }
});
