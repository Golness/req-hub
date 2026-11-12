// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { SyncHistoryRecords } = require('../../src/client/components/SyncHistoryRecords.js');
const { SyncStepList } = require('../../src/client/components/SyncSteps.js');
const { SessionSelectionContext } = require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const task = {
  id: 'old',
  snapshotDir: 'attempts/old',
  workspaceId: 'ws',
  requirementId: 'req',
  status: 'failed',
  startedAt: 1,
  steps: [],
};
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const retryButtons = () =>
  [...container.querySelectorAll('button')].filter(
    (button) => button.textContent === '重试',
  );
const render = async (node) => act(async () => root.render(node));
const success = (next) => ({
  ok: true,
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ type: 'state', sync: next })}\n\n`),
      );
      controller.close();
    },
  }),
});

it('retries from history through the scoped Host route and opens the new attempt', async () => {
  const next = { ...task, id: 'new', status: 'running' };
  const fetch = vi.fn(async () => success(next));
  vi.stubGlobal('fetch', fetch);
  const onSelect = vi.fn();
  await render(
    React.createElement(
      SessionSelectionContext.Provider,
      { value: () => 'parent' },
      React.createElement(SyncHistoryRecords, {
        history: [task],
        workspaceId: 'ws',
        requirementId: 'req',
        onSelect,
      }),
    ),
  );
  await act(async () => retryButtons()[0].click());
  expect(fetch.mock.calls[0][0]).toBe('/req-hub/sync-retry');
  const options = fetch.mock.calls[0][1];
  expect(options.headers['x-session-id']).toBe('parent');
  expect(JSON.parse(options.body)).toMatchObject({
    workspaceId: 'ws',
    requirementId: 'req',
    retrySyncId: 'old',
    snapshotDir: 'attempts/old',
  });
  expect(onSelect).toHaveBeenCalledWith(next);
});

it('retries the failed chunk with its node identity and retains a rejected attempt for another try', async () => {
  const fetch = vi.fn(async () => ({
    ok: false,
    json: async () => ({ error: 'SYNC_RETRY_INVALID' }),
  }));
  vi.stubGlobal('fetch', fetch);
  const onRetry = vi.fn();
  await render(
    React.createElement(SyncStepList, {
      task,
      onRetry,
      steps: [
        {
          phase: 'code_analysis',
          label: '代码分析',
          status: 'failed',
          chunks: [
            { status: 'completed', reused: true },
            { status: 'failed', error: 'failure' },
          ],
        },
      ],
    }),
  );
  expect(retryButtons()).toHaveLength(2);
  await act(async () => retryButtons()[1].click());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    retrySyncId: 'old',
    retryPhase: 'code_analysis',
    retryChunkIndex: 1,
  });
  expect([...container.querySelectorAll('[role="alert"]')]
    .some((node) => node.textContent.includes('原同步记录已变化或不支持重试'))).toBe(true);
  expect(retryButtons()[1].disabled).toBe(false);
  expect(onRetry).not.toHaveBeenCalled();
  expect(container.textContent).toContain('复用上次结果');
});

it('does not offer retry for active or published tasks', async () => {
  await render(
    React.createElement(SyncHistoryRecords, {
      history: [
        { ...task, status: 'running' },
        { ...task, id: 'published', publishState: 'state_committed' },
      ],
      workspaceId: 'ws',
      requirementId: 'req',
    }),
  );
  expect(retryButtons()).toHaveLength(0);
});
