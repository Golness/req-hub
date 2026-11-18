import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const doubles = vi.hoisted(() => ({ execute: vi.fn(), dispose: vi.fn() }));
vi.mock('../../src/server/task-executor.js', () => ({
  prepareTaskPrompt: async () => ({ fullPrompt: 'Frozen test prompt', skillTokenReserve: 0 }),
  executeTask: (...args) => doubles.execute(...args),
}));
vi.mock('../../src/server/workspace-task-agent.js', () => ({
  createWorkspaceTaskAgent: async () => ({ agent: {}, dispose: doubles.dispose }),
}));
vi.mock('../../src/server/sync-budget.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveSyncBudget: async () => ({ limit: 1000000 }),
}));

import { runCompile, runModelStep } from '../../src/server/knowledge-v2/compiler.js';
import { ScopeStore, resolveScope } from '../../src/server/knowledge-v2/scope.js';
import { importFiles } from '../../src/server/knowledge-v2/source-repository.js';

let root;
let store;
let installation;
const context = {
  subagents: {
    getProvider: () => ({ capabilities: { toolFilter: true }, inheritsParentContext: false }),
  },
};

function readDocuments(options) {
  const runtime = options.runtime;
  for (const document of runtime.documents) {
    if (!document.required && document.kind !== 'wiki') {
      continue;
    }
    let offset = 0;
    do {
      const page = runtime.read({ id: document.id, offset });
      offset = page.nextOffset;
      if (page.eof) {
        break;
      }
    } while (offset < document.body.length);
  }
  return runtime;
}

function submit(options, upserts = [], existingPageIds = []) {
  const runtime = readDocuments(options);
  runtime.submit(
    runtime.kind === 'analyze'
      ? {
          summary: 'Summary',
          facts: [],
          entities: [],
          concepts: [],
          existingPageIds,
          conflicts: [],
          proposedPages: [],
        }
      : { upserts, overview: 'Overview' },
  );
  return { isError: false };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqhub-compile-recovery-'));
  await mkdir(join(root, 'workspace/docs'), { recursive: true });
  store = new ScopeStore(
    await resolveScope({
      root: join(root, 'data'),
      workspace: { id: 'ws', path: join(root, 'workspace') },
      docsDir: 'docs',
    }),
  );
  await store.init();
  installation = { add: vi.fn(), close: vi.fn() };
  doubles.dispose.mockReset();
  doubles.execute.mockReset();
  doubles.execute.mockImplementation(async (_ctx, _llm, _config, options) => submit(options));
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

async function compile() {
  await writeFile(join(root, 'workspace/docs/first.md'), 'First source');
  await writeFile(join(root, 'workspace/docs/second.md'), 'Second source');
  const saved = await importFiles(store, {
    files: [{ relativePath: 'first.md' }, { relativePath: 'second.md' }],
    requestKey: 'sources',
  });
  return runCompile({
    ctx: context,
    llm: {},
    configLoader: async () => ({}),
    store,
    job: { id: 'compile', kind: 'ingest', sourceIds: [saved.results[0].sourceId] },
    signal: new AbortController().signal,
    installation,
  });
}

it('rebuilds missing initial summaries when a later ingest names only one of the saved sources', async () => {
  const result = await compile();
  expect(result.summary.sources).toBe(2);
  const manifest = JSON.parse(
    await readFile(store.path('releases', result.generationId, 'manifest.json'), 'utf8'),
  );
  expect(Object.keys(manifest.sourceRevisions)).toHaveLength(2);
  expect(Object.keys(manifest.pageHashes).filter((id) => id.startsWith('sources/'))).toHaveLength(
    2,
  );
});

it('lets the model repair a semantically invalid Wiki submission before acknowledging completion', async () => {
  let repaired = false;
  doubles.execute.mockImplementation(async (_ctx, _llm, _config, options) => {
    if (options.runtime.kind !== 'generate' || repaired) {
      return submit(options);
    }
    readDocuments(options);
    const source = options.runtime.documents.find((item) => item.kind === 'source');
    const page = {
      pageId: 'entities/order',
      type: 'entity',
      title: 'Order',
      body: '[[invalid/path]]',
      sources: [{ id: source.sourceId, revision: source.version, startLine: 1, endLine: 1 }],
    };
    expect(() => options.runtime.submit({ upserts: [page] })).toThrow('KB_MODEL_OUTPUT_INVALID');
    expect(options.runtime.result).toBeUndefined();
    options.runtime.submit({ upserts: [{ ...page, body: 'Validated body' }] });
    repaired = true;
    return { isError: false };
  });
  const result = await compile();
  expect(repaired).toBe(true);
  expect(
    await readFile(store.path('releases', result.generationId, 'wiki/entities/order.md'), 'utf8'),
  ).toContain('Validated body');
});

it('rejects a wrong base hash inside the submit tool and accepts a corrected frozen version', async () => {
  let created = false;
  let repaired = false;
  doubles.execute.mockImplementation(async (_ctx, _llm, _config, options) => {
    if (options.runtime.kind !== 'generate') {
      return submit(options, [], created ? ['entities/order'] : []);
    }
    const runtime = readDocuments(options);
    const source = runtime.documents.find((item) => item.kind === 'source');
    const page = {
      pageId: 'entities/order',
      type: 'entity',
      title: 'Order',
      body: 'Current body',
      sources: [{ id: source.sourceId, revision: source.version, startLine: 1, endLine: 1 }],
    };
    if (!created) {
      created = true;
      runtime.submit({ upserts: [page] });
    } else {
      expect(() => runtime.submit({ upserts: [{ ...page, baseHash: 'wrong' }] })).toThrow(
        'KB_MODEL_OUTPUT_INVALID',
      );
      expect(runtime.result).toBeUndefined();
      const baseline = runtime.documents.find((item) => item.id === 'wiki:entities/order');
      runtime.submit({ upserts: [{ ...page, baseHash: baseline.hash }] });
      repaired = true;
    }
    return { isError: false };
  });
  await compile();
  expect(repaired).toBe(true);
});

it('retries a timed-out attempt with a fresh frozen runtime and stops at the configured bound', async () => {
  doubles.execute.mockResolvedValue({
    isError: true,
    stopReason: 'error',
    errorCode: 'EXECUTION_TIMEOUT',
  });
  const options = {
    ctx: context,
    llm: {},
    config: { knowledgeV2: { modelRetryCount: 1 } },
    owner: { agent: {} },
    store,
    signal: new AbortController().signal,
    installation,
    kind: 'analyze',
    promptKey: 'kb-analyze',
    documents: [],
    instruction: 'Analyze',
    budget: { limit: 1000000 },
  };
  await expect(runModelStep(options)).rejects.toMatchObject({
    code: 'KB_MODEL_FAILED',
    details: { errorCode: 'EXECUTION_TIMEOUT' },
  });
  expect(doubles.execute).toHaveBeenCalledTimes(2);
  expect(installation.close).toHaveBeenCalledTimes(2);
  expect(installation.add.mock.calls[0][0]).not.toBe(installation.add.mock.calls[1][0]);
  doubles.execute.mockReset();
  doubles.execute.mockResolvedValue({ isError: true, errorCode: 'EXECUTION_TIMEOUT' });
  await expect(
    runModelStep({ ...options, config: { knowledgeV2: { modelRetryCount: 0 } } }),
  ).rejects.toMatchObject({ code: 'KB_MODEL_FAILED' });
  expect(doubles.execute).toHaveBeenCalledOnce();
});
