import { it, expect, vi, afterEach } from 'vitest';
import { TaskExecutor, TaskExecutorConfig } from '../../src/server/task-executor.js';
import { createSyncHarness } from './sync-v2-harness.js';
afterEach(() => vi.useRealTimers());
it('treats failed asynchronous session-state persistence as failure and still disposes the DSH run', async () => {
  const h = createSyncHarness();
  const run = { id: 'state-write-child', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: vi.fn(async () => {}) };
  h.ctx.subagents.start = async () => run;
  const executor = new TaskExecutor({ ...h, config: {}, callbacks: { onProgress: async progress => {
    if (progress.stage === 'executing') { await Promise.resolve(); throw new Error('STATE_WRITE_FAILED'); }
  } } });
  const result = await executor.executeViaSubagent({ promptKey: 'phased-test', syncV2: true, preparedPromptData: { fullPrompt: 'bounded prompt' } }, Date.now());
  expect(result.isError).toBe(true); expect(result.diagnostic).toBe('STATE_WRITE_FAILED'); expect(run.dispose).toHaveBeenCalledTimes(1);
});
it('cancels timed-out DSH startup and disposes a handle that arrives after the timeout', async () => {
  vi.useFakeTimers(); const h = createSyncHarness();
  const run = { id: 'late', result: Promise.resolve({ stopReason: 'aborted', output: [] }), dispose: vi.fn(async () => {}) };
  let request;
  h.ctx.subagents.start = (_provider, req) => { request = req; return new Promise(resolve => req.signal.addEventListener('abort', () => setTimeout(() => resolve(run), 20), { once: true })); };
  const executor = new TaskExecutor({ ...h, config: {} });
  const pending = executor.startSubagent({ promptKey: 'phased-test', syncV2: true }, { fullPrompt: 'bounded prompt' });
  const rejected = expect(pending).rejects.toThrow('启动超时');
  await vi.advanceTimersByTimeAsync(30000); expect(request.signal.aborted).toBe(true); expect(run.dispose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20); await rejected; expect(run.dispose).toHaveBeenCalledTimes(1);
});
it('rejects a handle returned after the parent cancellation and reclaims it', async () => {
  const h = createSyncHarness(), controller = new AbortController();
  const run = { id: 'cancelled-start', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: vi.fn(async () => {}) };
  h.ctx.subagents.start = async () => { controller.abort(new Error('用户终止')); return run; };
  const executor = new TaskExecutor({ ...h, config: {}, signal: controller.signal });
  await expect(executor.startSubagent({ promptKey: 'phased-test', syncV2: true }, { fullPrompt: 'bounded prompt' })).rejects.toThrow('用户终止');
  expect(run.dispose).toHaveBeenCalledTimes(1);
});
it('awaits one-shot disposal before returning an execution timeout to the sync engine', async () => {
  vi.useFakeTimers(); const h = createSyncHarness(); let releaseDispose, settled = false;
  const run = { id: 'child', result: new Promise(() => {}), dispose: vi.fn(() => new Promise(resolve => { releaseDispose = resolve; })) };
  h.ctx.subagents.start = async () => run;
  const executor = new TaskExecutor({ ...h, config: {} });
  const pending = executor.executeViaSubagent({ promptKey: 'phased-test', syncV2: true, timeout: TaskExecutorConfig.minTimeout, liveness: { enabled: false }, preparedPromptData: { fullPrompt: 'bounded prompt' } }, Date.now()).then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(TaskExecutorConfig.minTimeout + 1);
  expect(run.dispose).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
  releaseDispose(); const result = await pending; expect(result.isError).toBe(true); expect(result.diagnostic).toContain('执行超时');
});
