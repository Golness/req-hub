import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeV2Routes } from '../../src/server/routes/knowledge-v2-routes.js';
import { createOperations } from '../../src/server/operations.js';
import { createLifecycle } from '../../src/server/plugin-boundaries.js';

it('calls knowledge services directly, validates actual workspace ownership and denies user-only actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rh-application-scope-'));
  const other = await mkdtemp(join(tmpdir(), 'rh-application-other-'));
  try {
    const scope = vi.fn(async () => ({ rules: async () => ({ purpose: 'shared' }) }));
    const reset = vi.fn();
    const registry = { list: () => [{ id: 'ws', path: root }] };
    const routes = createKnowledgeV2Routes({ registry, scope, reset });
    routes[0].handler = () => {
      throw new Error('HTTP_MUST_NOT_RUN');
    };
    const operations = createOperations(routes);
    const caller = { agent: { session: { id: 'actual', header: { cwd: root } } } };
    expect(
      await operations.execute(
        { action: 'knowledge-v2-rules', query: { workspaceId: 'ws' } },
        caller,
      ),
    ).toEqual({ status: 200, value: { purpose: 'shared' } });
    scope.mockClear();
    const denied = await operations.execute(
      { action: 'knowledge-v2-rules', query: { workspaceId: 'ws' } },
      {
        agent: { session: { id: 'forged', header: { cwd: other } } },
      },
    );
    expect(denied).toMatchObject({
      status: 403,
      value: { error: { code: 'CALLER_WORKSPACE_MISMATCH' } },
    });
    expect(scope).not.toHaveBeenCalled();
    const resetResult = await operations.execute(
      { action: 'knowledge-v2-reset', method: 'POST', body: { workspaceId: 'ws' } },
      caller,
    );
    expect(resetResult).toMatchObject({
      status: 403,
      value: { error: { code: 'KB_USER_REQUIRED' } },
    });
    expect(reset).not.toHaveBeenCalled();
    expect(
      (
        await operations.execute(
          { action: 'knowledge-v2-rules', method: 'DELETE', body: { workspaceId: 'ws' } },
          caller,
        )
      ).status,
    ).toBe(405);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

it('budgets the complete rendered tool result, including JSON escaping and metadata', async () => {
  const operations = createOperations([
    {
      kind: 'exact',
      path: '/req-hub/large',
      handler: () => {
        throw new Error('HTTP_MUST_NOT_RUN');
      },
      operation: {
        action: 'large',
        methods: ['GET'],
        execute: async () => ({ status: 200, value: '"'.repeat(3 * 1024 * 1024) }),
      },
    },
  ]);
  await expect(operations.execute({ action: 'large' }, {})).rejects.toThrow(
    'OPERATION_OUTPUT_TOO_LARGE',
  );
});

it('keeps admitted callbacks owned until teardown completes and rejects queued callbacks after close', async () => {
  const lifecycle = createLifecycle();
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const request = lifecycle.run(async () => {
    started();
    await gate;
  });
  await ready;
  let finished = false;
  const closing = lifecycle.close().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  await expect(lifecycle.run(() => {})).rejects.toThrow('REQ_HUB_CLOSED');
  release();
  await request;
  await closing;
  expect(finished).toBe(true);
  expect(lifecycle.close()).toBe(lifecycle.close());
});
