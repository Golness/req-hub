import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { WikiStore } from '../../src/server/knowledge/wiki/store.js';
import { WritingRuntime } from '../../src/server/writing-runtime.js';
import { freezeWritingKnowledge, verifyWritingWiki } from '../../src/server/writing-knowledge.js';
import { createWritingRoutes } from '../../src/server/routes/writing-routes.js';
import { createOperations } from '../../src/server/operations.js';
vi.mock('../../src/server/sync-budget.js', async (original) => ({
  ...(await original()),
  resolveSyncBudget: async () => ({ limit: 200000 }),
}));
let root, knowledge, scope, database, source, pageId, routes;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqhub-writing-wiki-'));
  await mkdir(join(root, 'docs/alice/2026-10-30-orders'), { recursive: true });
  await writeFile(
    join(root, 'docs/alice/2026-10-30-orders/source.md'),
    '# Orders\nApproval is required.',
  );
  knowledge = new KnowledgeService({
    registry: { list: () => [{ id: 'ws', title: 'Project', path: root }] },
    configLoader: async () => ({ docsDir: 'docs' }),
    databasePath: join(root, 'data/library.sqlite'),
  });
  scope = await knowledge.scope('ws');
  database = new WikiStore(knowledge.database());
  knowledge.wiki = { database: () => database };
  const parsed = await knowledge.readSourceFile(
    scope.docsRoot,
    'alice/2026-10-30-orders/source.md',
  );
  source = scope.store.entry(scope.store.publishDocument(parsed, 'test').documentId);
  const snapshotId = database.snapshot(scope.identity, {
    ...source,
    kind: 'source',
    scopeId: scope.identity,
  });
  database.rules(scope.identity);
  pageId = database.transaction(() =>
    database.publishPage(
      scope.identity,
      {
        entityKey: 'concept:approval',
        baseVersion: 0,
        title: 'Approval',
        pageType: 'concept',
        body: 'Approval is required before shipment.',
        evidence: [
          { snapshotId, documentId: source.id, version: source.version, startLine: 2, endLine: 2 },
        ],
      },
      1,
      'automatic',
    ),
  );
});
afterEach(async () => {
  await routes?.dispose();
  routes = null;
  await knowledge.close();
  const child = relative(tmpdir(), root);
  if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('reqhub-writing-wiki-')) {
    throw new Error('Unsafe test cleanup');
  }
  await rm(root, { recursive: true, force: true });
});
function runtime() {
  const origin = knowledge.database().scopes()[0];
  return new WritingRuntime(
    [{ id: scope.identity }],
    freezeWritingKnowledge(knowledge, scope, origin),
  );
}
it('requires index and Wiki reading before exposing the linked raw source', () => {
  const task = runtime();
  let hits = task.search({ scopeId: scope.identity, query: 'Approval' }).hits;
  expect(hits.map((hit) => hit.kind)).toEqual(['index', 'wiki']);
  expect(() => task.read({ id: 'wiki:' + pageId })).toThrow('WRITING_INDEX_REQUIRED');
  task.read({ id: hits[0].id });
  expect(() => task.submit({ content: '# Draft', evidenceIds: [hits[0].id] })).toThrow();
  task.read({ id: 'wiki:' + pageId });
  hits = task.search({ scopeId: scope.identity, query: 'Approval' }).hits;
  expect(hits.some((hit) => hit.id === source.id)).toBe(true);
  task.submit({ content: '# Draft', evidenceIds: ['wiki:' + pageId] });
  expect(task.result.evidence[0]).toMatchObject({ pageId, version: 1, kind: 'wiki' });
  expect(task.result.evidence[0].evidence[0]).toMatchObject({
    documentId: source.id,
    startLine: 2,
  });
});
it('falls back to active sources when Wiki knowledge is unavailable', () => {
  database.db.prepare("UPDATE knowledge_wiki_pages SET status='stale'").run();
  const task = runtime();
  expect(task.documents.some((doc) => doc.kind === 'index')).toBe(false);
  expect(task.search({ scopeId: scope.identity, query: 'Orders' }).hits[0].kind).toBe('source');
  task.read({ id: source.id });
  task.submit({ content: '# Draft', evidenceIds: [source.id] });
});
it('requires explicit source scopes for cross-project Wiki conclusions', async () => {
  const otherRoot = join(root, 'other');
  await mkdir(join(otherRoot, 'docs/alice/2026-10-30-other'), { recursive: true });
  await writeFile(join(otherRoot, 'docs/alice/2026-10-30-other/source.md'), '# Other\nA policy.');
  knowledge.registry.list = () => [
    { id: 'ws', path: root },
    { id: 'other', path: otherRoot },
  ];
  const other = await knowledge.scope('other');
  const parsed = await knowledge.readSourceFile(other.docsRoot, 'alice/2026-10-30-other/source.md');
  const doc = other.store.entry(other.store.publishDocument(parsed, 'test').documentId);
  const snapshotId = database.snapshot(scope.identity, {
    ...doc,
    kind: 'source',
    scopeId: other.identity,
  });
  const crossId = database.transaction(() =>
    database.publishPage(
      scope.identity,
      {
        entityKey: 'analysis:cross',
        baseVersion: 0,
        title: 'Cross project policy',
        pageType: 'analysis',
        body: 'The other project has a policy.',
        evidence: [
          { snapshotId, documentId: doc.id, version: doc.version, startLine: 1, endLine: 1 },
        ],
      },
      1,
      'automatic',
    ),
  );
  const origin = knowledge
    .database()
    .scopes()
    .find((item) => item.id === scope.identity);
  expect(
    freezeWritingKnowledge(knowledge, scope, origin).some((item) => item.pageId === crossId),
  ).toBe(false);
  const selected = [scope.identity, other.identity];
  const page = freezeWritingKnowledge(knowledge, scope, origin, selected).find(
    (item) => item.pageId === crossId,
  );
  expect(page.linkedSourceIds).toContain(doc.id);
  await verifyWritingWiki(knowledge, [page], selected);
  await writeFile(join(otherRoot, 'docs/alice/2026-10-30-other/source.md'), '# Changed policy');
  await expect(verifyWritingWiki(knowledge, [page], selected)).rejects.toThrow(
    'WRITING_KNOWLEDGE_STALE',
  );
});
it('rejects source and Wiki changes after frozen evidence was read', async () => {
  const task = runtime();
  const page = task.documents.find((doc) => doc.kind === 'wiki');
  await verifyWritingWiki(knowledge, [page]);
  await writeFile(join(root, 'docs/alice/2026-10-30-orders/source.md'), '# Changed');
  await expect(verifyWritingWiki(knowledge, [page])).rejects.toThrow('WRITING_KNOWLEDGE_STALE');
});
it('uses Wiki evidence through the actual shared writing route and denies a forged scope', async () => {
  const parent = { status: 'idle', session: { id: 'parent', header: { cwd: root } } };
  const agents = { get: (id) => (id === 'parent' ? parent : null) };
  const ctx = {
    agents,
    tools: { register: () => () => {}, guard: () => () => {} },
    on: () => () => {},
    subagents: {
      getProvider: () => ({ capabilities: { toolFilter: true }, inheritsParentContext: false }),
    },
  };
  routes = createWritingRoutes(knowledge.registry, null, agents, ctx, knowledge, {
    configLoader: async () => ({ docsDir: 'docs' }),
    executeTask: async (_ctx, _llm, _config, { runtime: task }) => {
      const hits = task.search({ scopeId: scope.identity, query: 'Approval' }).hits;
      for (const hit of hits) task.read({ id: hit.id });
      task.submit({ content: '# Revised', evidenceIds: ['wiki:' + pageId] });
      return { isError: false, sessionId: 'child' };
    },
  });
  const operations = createOperations(routes.routes),
    exec = { agent: parent };
  const recommendations = await operations.execute(
    {
      action: 'writing-knowledge',
      query: {
        workspaceId: 'ws',
        scopeIds: JSON.stringify([scope.identity]),
        q: 'Approval',
      },
    },
    exec,
  );
  expect(recommendations.value.items[0].pageId).toBe(pageId);
  const denied = await operations.execute(
    {
      action: 'writing-knowledge',
      query: {
        workspaceId: 'ws',
        scopeIds: JSON.stringify(['forged']),
      },
    },
    exec,
  );
  expect(denied.status).toBe(403);
  const started = await operations.execute(
    {
      action: 'writing-optimize',
      method: 'POST',
      body: {
        workspaceId: 'ws',
        docType: 'requirement',
        content: '# Draft',
        instruction: 'Use Approval',
        scopeIds: [scope.identity],
      },
    },
    exec,
  );
  expect(started.status).toBe(202);
  await vi.waitFor(async () => {
    const current = await operations.execute(
      { action: 'writing-job', id: started.value.id, query: { workspaceId: 'ws' } },
      exec,
    );
    expect(current.value.status).toBe('completed');
    expect(current.value.result.evidence[0].kind).toBe('wiki');
  });
});
