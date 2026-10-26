// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { estimateSyncTiming } = require('../../src/client/utils/syncTiming.js');
const React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { SyncTiming } = require('../../src/client/components/SyncTiming.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function task(concurrency = 3) {
  return { id: 'task', status: 'running', startedAt: 0, steps: [{ phase: 'code_analysis', status: 'running', concurrency, chunks: [
    { status: 'completed', tokens: 10000, startedAt: 0, completedAt: 60000 },
    { status: 'completed', tokens: 10000, startedAt: 60000, completedAt: 120000 },
    { status: 'running', tokens: 10000, startedAt: 170000 },
    { status: 'queued', tokens: 10000 },
  ] }] };
}
it('uses concurrent lanes, observed work size and running time rather than a fixed duration per stage', () => {
  expect(estimateSyncTiming(task(), 200000)).toMatchObject({ state: 'estimated', lowerMs: 45000, upperMs: 90000, elapsedMs: 200000 });
  expect(estimateSyncTiming(task(1), 200000)).toMatchObject({ lowerMs: 60000, upperMs: 150000 });
  const larger = task(); larger.steps[0].chunks[3].tokens *= 2;
  expect(estimateSyncTiming(larger, 200000)).toMatchObject({ lowerMs: 90000, upperMs: 180000 });
  expect(estimateSyncTiming(task(), 210000).upperMs).toBe(90000); // queued work still needs its full duration
});
it('does not extrapolate from insufficient, failed or inconsistent samples or unknown work sizes', () => {
  for (const mutate of [
    sync => sync.steps[0].chunks.splice(0, 1),
    sync => { sync.steps[0].chunks[0].status = 'failed'; },
    sync => { sync.steps[0].chunks[0].completedAt = 1000; },
    sync => { delete sync.steps[0].concurrency; },
    sync => { delete sync.steps[0].chunks[3].tokens; },
    sync => { sync.steps[0].chunks[3].tokens = Infinity; },
  ]) {
    const sync = task(); mutate(sync);
    expect(estimateSyncTiming(sync, 200000).state).toBe('unknown');
  }
});
it('stops numerical predictions when an active chunk exceeds the observed range', () => {
  const sync = task(); sync.steps[0].chunks[2].startedAt = 100000;
  expect(estimateSyncTiming(sync, 200000)).toMatchObject({ state: 'overrun' });
  expect(estimateSyncTiming(sync, 200000)).not.toHaveProperty('upperMs');
});
it('does not claim that completed chunks mean the entire phase or task is finished', () => {
  const sync = task(); sync.steps[0].chunks.splice(2);
  expect(estimateSyncTiming(sync, 200000).state).toBe('summarizing');
  sync.steps[0].phase = 'merge';
  expect(estimateSyncTiming(sync, 200000).state).toBe('unknown');
  sync.status = 'cancelling';
  expect(estimateSyncTiming(sync, 200000).state).toBe('cancelling');
});
it.each(['completed', 'failed', 'aborted'])('freezes elapsed time and removes estimates for %s tasks', status => {
  const sync = { ...task(), status, completedAt: 180000 };
  expect(estimateSyncTiming(sync, 200000)).toEqual({ elapsedMs: 180000, state: 'terminal' });
  expect(estimateSyncTiming(sync, 500000)).toEqual({ elapsedMs: 180000, state: 'terminal' });
});
it('updates elapsed time without server events and stops its clock on completion and unmount', async () => {
  vi.useFakeTimers(); vi.setSystemTime(200000);
  const container = document.createElement('div'), root = createRoot(container);
  try {
    const sync = { id: 'clock', status: 'running', startedAt: 170000, steps: [] };
    await act(async () => root.render(React.createElement(SyncTiming, { sync })));
    expect(container.textContent).toContain('已用时：30 秒');
    expect(container.textContent).toContain('暂无法可靠预估');
    await act(async () => vi.advanceTimersByTime(2000));
    expect(container.textContent).toContain('已用时：32 秒');
    await act(async () => root.render(React.createElement(SyncTiming, { sync: { ...sync, status: 'completed', completedAt: 201000 } })));
    expect(container.textContent).toBe('已用时：31 秒');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => root.render(React.createElement(SyncTiming, { sync })));
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    await act(async () => root.unmount()); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  }
});
