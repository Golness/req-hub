import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { WikiService } from '../../src/server/knowledge/wiki/service.js';
import { WikiRuntime, installWikiTools } from '../../src/server/knowledge/wiki/runtime.js';
import { createWikiRoutes } from '../../src/server/routes/wiki-routes.js';
import { createOperations } from '../../src/server/operations.js';
import { executeTask } from '../../src/server/task-executor.js';
import { delegationContext } from '../../src/server/delegation-context.js';

vi.mock('../../src/server/sync-budget.js', async (original) => ({
  ...(await original()),
  resolveSyncBudget: async () => ({ limit: 200000 }),
}));
let root, knowledge, wiki, scope, config, runTask, ctx;
const path = 'alice/2026-11-02-topic/requirement.md';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqhub-wiki-events-'));
  await mkdir(join(root, 'docs/alice/2026-11-02-topic'), { recursive: true });
  await writeFile(join(root, 'docs', path), '# Requirement\nSupported fact.');
  const parent = { status: 'idle', session: { id: 'parent', header: { cwd: root } } };
  ctx = {
    agents: { get: () => parent, list: () => [parent] },
    skills: { get: async () => null },
    subagents: {
      getProvider: () => ({
        capabilities: { toolFilter: true },
        inheritsParentContext: false,
      }),
    },
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
  };
  config = { docsDir: 'docs', wiki: { autoManage: true, autoManageDelayMs: 0 } };
  knowledge = new KnowledgeService({
    registry: {
      list: () => [
        { id: 'ws', path: root },
        { id: 'other', path: root },
      ],
    },
    configLoader: async () => config,
    databasePath: join(root, 'data/knowledge.sqlite'),
  });
  runTask = vi.fn(async (_ctx, _llm, _config, { runtime, callbacks }) => {
    callbacks.onProgress({ stage: 'executing', sessionId: 'child' });
    for (const doc of runtime.documents) {
      let offset = 0;
      let page;
      do {
        page = runtime.read({ documentId: doc.id, offset });
        offset = page.nextOffset;
      } while (!page.eof);
    }
    const source = runtime.documents.find((doc) => doc.kind === 'source');
    runtime.submit({
      result: {
        pages: [
          {
            title: 'Topic',
            entityKey: 'topic',
            pageType: 'concept',
            body: 'Supported fact.',
            evidence: [
              { documentId: source.id, version: source.version, startLine: 1, endLine: 1 },
            ],
          },
        ],
      },
    });
    return { isError: false, stopReason: 'completed', sessionId: 'child' };
  });
  wiki = new WikiService({ knowledge, ctx, configLoader: async () => config, runTask });
  knowledge.wiki = wiki;
  wiki.database();
  scope = await knowledge.scope('ws');
});
afterEach(async () => {
  await wiki.close();
  await knowledge.close();
  const child = relative(tmpdir(), root);
  if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('reqhub-wiki-events-')) {
    throw new Error('Unsafe test cleanup');
  }
  await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});
async function settle() {
  while (wiki.tasks.size) {
    await Promise.allSettled([...wiki.tasks]);
  }
}
it('saves sources by default without running a model and counts only their latest versions', async () => {
  config.wiki = {};
  const first = await wiki.capture('ws', path, 'parent');
  await writeFile(join(root, 'docs', path), '# Latest source');
  const latest = await wiki.capture('ws', path, 'parent');
  await settle();
  expect(first.processingStatus).toBe('needs_update');
  expect(latest).toMatchObject({
    documentId: first.documentId,
    sourceVersion: 2,
    processingStatus: 'needs_update',
  });
  expect(runTask).not.toHaveBeenCalled();
  expect(await wiki.updateStatus(scope)).toMatchObject({ pendingCount: 1, autoManage: false });
  expect(await wiki.updateStatus(await knowledge.scope('other'))).toMatchObject({
    pendingCount: 0,
  });
});
it('updates all latest pending documents through the shared manual operation', async () => {
  config.wiki = {};
  await wiki.capture('ws', path, 'parent');
  await writeFile(join(root, 'docs', path), '# Latest source');
  await wiki.capture('ws', path, 'parent');
  const second = 'alice/2026-11-02-topic/design.md';
  await writeFile(join(root, 'docs', second), '# Second source');
  await wiki.capture('ws', second, 'parent');
  const adapter = createWikiRoutes(knowledge, ctx, { service: wiki });
  const ops = createOperations(adapter.routes);
  const before = await ops.execute(
    { action: 'wiki-update-status', query: { workspaceId: 'ws' } },
    {},
  );
  expect(before.value.pendingCount).toBe(2);
  expect(runTask).not.toHaveBeenCalled();
  const result = await ops.execute(
    { action: 'wiki-update', method: 'POST', body: { workspaceId: 'ws' } },
    { agent: { session: { id: 'parent' } } },
  );
  expect(result.status).toBe(202);
  await settle();
  expect(runTask).toHaveBeenCalledTimes(2);
  const versions = runTask.mock.calls.map(
    (call) => call[3].runtime.documents.find((doc) => doc.kind === 'source').version,
  );
  expect(versions.sort()).toEqual([1, 2]);
  expect(await wiki.updateStatus(scope)).toMatchObject({ pendingCount: 0, running: false });
  await adapter.dispose();
});
it('keeps failed compilation in the pending count and allows an explicit retry', async () => {
  config.wiki = {};
  await wiki.capture('ws', path, 'parent');
  runTask.mockResolvedValueOnce({ isError: true, diagnostic: 'Provider failed' });
  await wiki.update(scope, 'parent');
  await settle();
  expect(await wiki.updateStatus(scope)).toMatchObject({ pendingCount: 1 });
  await wiki.update(scope, 'parent');
  await settle();
  expect(await wiki.updateStatus(scope)).toMatchObject({ pendingCount: 0 });
});
it('continues a manual batch when each model execution fails immediately', async () => {
  config.wiki = {};
  await wiki.capture('ws', path, 'parent');
  const second = 'alice/2026-11-02-topic/design.md';
  await writeFile(join(root, 'docs', second), '# Second source');
  await wiki.capture('ws', second, 'parent');
  runTask.mockResolvedValue({ isError: true, diagnostic: 'Provider failed' });
  await wiki.update(scope, 'parent');
  await settle();
  expect(runTask).toHaveBeenCalledTimes(2);
  expect(await wiki.updateStatus(scope)).toMatchObject({
    pendingCount: 2,
    failedCount: 2,
    queuedCount: 0,
    running: false,
  });
});
it('does not compile a version saved after the manual batch was requested', async () => {
  config.wiki = {};
  const receipt = await wiki.capture('ws', path, 'parent');
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const generate = runTask.getMockImplementation();
  runTask.mockImplementationOnce(async (...args) => {
    await blocked;
    return generate(...args);
  });
  await wiki.update(scope, 'parent');
  await writeFile(join(root, 'docs', path), '# Saved after the update request');
  await wiki.capture('ws', path, 'parent');
  release();
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
  expect(
    runTask.mock.calls[0][3].runtime.documents.find((doc) => doc.kind === 'source').version,
  ).toBe(1);
  expect(wiki.sourceState(scope, receipt.documentId)).toMatchObject({
    sourceVersion: 2,
    processingStatus: 'needs_update',
  });
  expect(await wiki.updateStatus(scope)).toMatchObject({ pendingCount: 1 });
});
it('leaves a manual request waiting for a session without marking the document updated', async () => {
  config.wiki = {};
  await wiki.capture('ws', path, 'parent');
  ctx.agents.list = () => [];
  ctx.agents.get = () => null;
  const status = await wiki.update(scope);
  expect(status).toMatchObject({ pendingCount: 1, waitingSession: true, running: false });
  expect(runTask).not.toHaveBeenCalled();
});
it('coalesces optional automatic saves and clears pending timers on unload', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  config.wiki.autoManageDelayMs = 1000;
  await wiki.capture('ws', path, 'parent');
  await vi.advanceTimersByTimeAsync(500);
  await writeFile(join(root, 'docs', path), '# Most recent');
  await wiki.capture('ws', path, 'parent');
  await vi.advanceTimersByTimeAsync(500);
  expect(runTask).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  await settle();
  expect(runTask).toHaveBeenCalledOnce();
  expect(
    runTask.mock.calls[0][3].runtime.documents.find((doc) => doc.kind === 'source').version,
  ).toBe(2);
  await writeFile(join(root, 'docs', path), '# Next draft');
  await wiki.capture('ws', path, 'parent');
  expect(wiki.autoTimers.size).toBe(1);
  await wiki.close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(runTask).toHaveBeenCalledOnce();
  expect(wiki.autoTimers.size).toBe(0);
});
it('runs automatic ingestion through the real executor without an optional instruction', async () => {
  const generate = runTask.getMockImplementation();
  runTask.mockImplementation(executeTask);
  ctx.subagents.start = vi.fn(async () => {
    const runtime = delegationContext.getStore();
    await generate(ctx, null, config, { runtime, callbacks: { onProgress: () => {} } });
    return {
      id: 'owned-child',
      result: Promise.resolve({ stopReason: 'completed', output: [] }),
      dispose: async () => {},
    };
  });
  const receipt = await wiki.capture('ws', path, 'parent');
  await settle();
  expect(wiki.sourceState(scope, receipt.documentId)).toMatchObject({
    processingStatus: 'published',
    error: null,
  });
  expect(ctx.subagents.start).toHaveBeenCalledOnce();
});
it('still requires a nonempty question before starting a query', async () => {
  await expect(wiki.start(scope, { kind: 'query', instruction: '' }, 'parent')).rejects.toThrow(
    'WIKI_INVALID_INPUT',
  );
  await expect(wiki.start(scope, { kind: 'query', instruction: '  ' }, 'parent')).rejects.toThrow(
    'WIKI_INVALID_INPUT',
  );
  expect(runTask).not.toHaveBeenCalled();
});
it('captures a saved requirement and distinguishes publication from source persistence', async () => {
  const receipt = await wiki.capture('ws', path, 'parent');
  expect(receipt.state).toBe('saved');
  await settle();
  expect(wiki.sourceState(scope, receipt.documentId)).toMatchObject({
    sourceVersion: 1,
    processingStatus: 'published',
    jobId: expect.any(String),
  });
  const events = wiki.database().events(scope.identity, { after: 0, limit: 100 }).items;
  expect(events.map((event) => event.stage)).toEqual(
    expect.arrayContaining([
      'source_saved',
      'queued',
      'running',
      'executor_progress',
      'evidence_read',
      'result_submitted',
      'executor_finished',
      'verifying',
      'generated',
      'published',
    ]),
  );
  expect(JSON.stringify(events)).not.toContain('Supported fact.');
  expect(wiki.database().job(scope.identity, receipt.jobId).sessionId).toBe('child');
});
it('preserves executor failure diagnostics instead of reporting a missing result', async () => {
  runTask.mockResolvedValue({
    isError: true,
    stopReason: 'error',
    errorCode: 'PROVIDER_FAILED',
    diagnostic: 'Provider unavailable',
    sessionId: 'failed-child',
  });
  const receipt = await wiki.capture('ws', path, 'parent');
  await settle();
  const state = wiki.sourceState(scope, receipt.documentId);
  expect(state).toMatchObject({
    processingStatus: 'failed',
    error: {
      code: 'WIKI_EXECUTION_FAILED',
      details: {
        errorCode: 'PROVIDER_FAILED',
        diagnostic: 'Provider unavailable',
        submitted: false,
      },
    },
  });
  const events = wiki.database().events(scope.identity, { jobId: state.jobId }).items;
  expect(events.find((event) => event.stage === 'failed').detail.sessionId).toBe('failed-child');
});
it('identifies completed executions that never submitted a result', async () => {
  runTask.mockResolvedValue({ isError: false, stopReason: 'completed' });
  const receipt = await wiki.capture('ws', path, 'parent');
  await settle();
  expect(wiki.sourceState(scope, receipt.documentId).error).toMatchObject({
    code: 'WIKI_RESULT_INCOMPLETE',
    details: { stopReason: 'completed', submitted: false },
  });
});
it('retains unexpected runtime failures for diagnosis', async () => {
  runTask.mockRejectedValue(
    Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }),
  );
  const receipt = await wiki.capture('ws', path, 'parent');
  await settle();
  expect(wiki.sourceState(scope, receipt.documentId).error).toMatchObject({
    code: 'WIKI_FAILED',
    details: { causeCode: 'ECONNREFUSED', diagnostic: 'Connection refused' },
  });
});
it('records source capture errors even when no generation task can be created', async () => {
  await expect(wiki.capture('ws', 'missing.md', 'parent')).rejects.toMatchObject({
    message: 'WIKI_SOURCE_CAPTURE_FAILED',
  });
  const events = wiki.database().events(scope.identity, {}).items;
  expect(events[0]).toMatchObject({
    stage: 'source_capture_failed',
    level: 'error',
    detail: { path: 'missing.md', diagnostic: expect.any(String) },
  });
});
it('returns waiting, disabled, and task-start failure states without losing the source', async () => {
  ctx.agents.list = () => [];
  ctx.agents.get = () => null;
  const waiting = await wiki.capture('ws', path);
  expect(waiting.processingStatus).toBe('waiting_session');
  config.wiki.autoManage = false;
  await writeFile(join(root, 'docs', path), '# Updated');
  const disabled = await wiki.capture('ws', path);
  expect(disabled.processingStatus).toBe('needs_update');
  config.wiki.autoManage = true;
  ctx.agents.list = () => [{ status: 'idle', session: { id: 'parent', header: { cwd: root } } }];
  ctx.subagents.getProvider = () => null;
  await writeFile(join(root, 'docs', path), '# Third');
  const failed = await wiki.capture('ws', path);
  expect(failed).toMatchObject({
    processingStatus: 'failed',
    error: {
      code: 'WIKI_PROVIDER_UNSUPPORTED',
    },
  });
  expect(scope.store.entry(failed.documentId)).toBeTruthy();
});
it('paginates events in both directions, isolates scopes, and shares read operations', async () => {
  const db = wiki.database();
  for (let index = 0; index < 5; index++) {
    db.event(scope.identity, 'running', { jobId: 'task', index });
  }
  const other = await knowledge.scope('other');
  db.event(other.identity, 'failed', { jobId: 'task' });
  const adapter = createWikiRoutes(knowledge, ctx, { service: wiki });
  const ops = createOperations(adapter.routes);
  const first = await ops.execute(
    {
      action: 'wiki-events',
      query: {
        workspaceId: 'ws',
        limit: 2,
        jobId: 'task',
      },
    },
    {},
  );
  expect(first.value.items.map((row) => row.detail.index)).toEqual([4, 3]);
  const older = db.events(scope.identity, { before: first.value.nextCursor, limit: 2 });
  expect(older.items.map((row) => row.detail.index)).toEqual([2, 1]);
  const newer = db.events(scope.identity, { after: older.items[0].sequence, limit: 1 });
  expect(newer.items[0].detail.index).toBe(3);
  expect(newer.hasMore).toBe(true);
  expect(
    (
      await ops.execute(
        {
          action: 'wiki-events',
          query: {
            workspaceId: 'ws',
            after: -1,
          },
        },
        {},
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await ops.execute(
        {
          action: 'wiki-source-state',
          query: {
            workspaceId: 'other',
            documentId: 'foreign',
          },
        },
        {},
      )
    ).status,
  ).toBe(404);
  await adapter.dispose();
});
it('records rejected tool submissions without persisting source bodies', () => {
  const definitions = [];
  ctx.tools.register = (definition) => {
    definitions.push(definition);
    return () => {};
  };
  const runtime = new WikiRuntime(
    [{ id: 'doc', version: 1, kind: 'source', body: 'Secret' }],
    { maxResultBytes: 10000 },
    { limit: 200000 },
    new AbortController().signal,
    'query',
  );
  runtime.onEvent = vi.fn();
  const installation = installWikiTools(ctx);
  installation.add(runtime);
  runtime.bindSession('owned');
  const submit = definitions.find((definition) => definition.name === 'req_hub_wiki_submit');
  expect(() => submit.execute({ result: {} }, { agent: { session: { id: 'owned' } } })).toThrow(
    'WIKI_EVIDENCE_INCOMPLETE',
  );
  expect(runtime.onEvent).toHaveBeenCalledWith(
    'submission_rejected',
    {
      code: 'WIKI_EVIDENCE_INCOMPLETE',
      details: { next: [{ documentId: 'doc', offset: 0 }] },
      remainingReads: 1,
    },
    'warn',
  );
  return installation.dispose();
});

it('retains a rejected submission cause when a child completes without resubmitting', async () => {
  runTask.mockImplementation(async (_ctx, _llm, _config, { runtime }) => {
    for (const doc of runtime.documents) runtime.read({ documentId: doc.id });
    const source = runtime.documents.find((doc) => doc.kind === 'source');
    const evidence = [{ documentId: source.id, version: source.version, startLine: 1, endLine: 1 }];
    try {
      runtime.submit({
        result: {
          pages: [
            { title: 'Topic', pageType: 'entity', entityKey: 'topic', body: 'Fact', evidence },
          ],
          summaries: [
            { documentId: source.id, classification: 'requirements', summary: 'Fact', evidence },
          ],
        },
      });
    } catch (error) {
      runtime.submissionFailure = error;
    }
    return { isError: false, stopReason: 'completed', sessionId: 'rejected-child' };
  });
  const receipt = await wiki.capture('ws', path, 'parent');
  await settle();
  const state = wiki.sourceState(scope, receipt.documentId);
  expect(state).toMatchObject({
    processingStatus: 'failed',
    error: {
      code: 'WIKI_RESULT_INVALID',
      details: {
        path: 'summaries[0].classification',
        allowedValues: ['requirement', 'design', 'cr', 'other'],
      },
    },
  });
});
