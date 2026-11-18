import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  serializePage,
  parsePage,
  validPageId,
  pageType,
  extractWikilinks,
  publicError,
} from '../../src/server/knowledge-v2/contracts.js';
import { decodeUtf8, normalizeText } from '../../src/server/knowledge-v2/normalize.js';
import { resolveScope, ScopeStore } from '../../src/server/knowledge-v2/scope.js';
import {
  importFiles,
  importSessionMarkdown,
  listSources,
  listFileCandidates,
  getSource,
  stateByPath,
  sourceIdentity,
} from '../../src/server/knowledge-v2/source-repository.js';
import {
  describeTurns,
  mergeSessionTurns,
  buildSessionDocument,
  sessionMessages,
} from '../../src/server/knowledge-v2/session-export.js';
import { KbTaskRuntime, installKbTaskTools } from '../../src/server/knowledge-v2/runtime.js';
import { KnowledgeQueue } from '../../src/server/knowledge-v2/queue.js';
import { validateUpserts } from '../../src/server/knowledge-v2/compiler.js';
import {
  prepareStaging,
  writeStagingPage,
  readStagingPages,
  finalizeStaging,
  publishRelease,
} from '../../src/server/knowledge-v2/publisher.js';
import { structuralLint, isAnswerable } from '../../src/server/knowledge-v2/lint.js';
import { WikiSearchIndex } from '../../src/server/knowledge-v2/search.js';
import { createKnowledgeV2Routes } from '../../src/server/routes/knowledge-v2-routes.js';
import { KnowledgeApplication } from '../../src/server/knowledge-v2/application.js';

const NUL = String.fromCharCode(0);
let root;
let store;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'req-hub-kbv2-'));
  await mkdir(join(root, 'workspace', 'docs', 'alice'), { recursive: true });
  const scope = await resolveScope({
    root: join(root, 'data'),
    workspace: { id: 'ws', path: join(root, 'workspace') },
    docsDir: 'docs',
  });
  store = new ScopeStore(scope);
  await store.init();
});

afterEach(async () => {
  await store?.close();
  await rm(root, { recursive: true, force: true });
});

const writeDoc = async (relativePath, content) => {
  const file = join(root, 'workspace', 'docs', relativePath);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content);
};

describe('contracts', () => {
  it('round-trips Host frontmatter and rejects foreign shapes', () => {
    const meta = {
      id: 'entities/order',
      type: 'entity',
      title: '订单 "Order"',
      sources: [{ id: 'src-abc', revision: 'rev-1' }],
      updatedAt: '2026-11-10T00:00:00.000Z',
    };
    const parsed = parsePage(serializePage(meta, '正文\n'));
    expect(parsed.meta).toEqual(meta);
    expect(parsed.body).toBe('正文\n');
    expect(() => parsePage('no frontmatter')).toThrow('KB_PAGE_FORMAT_INVALID');
  });
  it('validates logical page paths and derives types', () => {
    expect(validPageId('entities/order-status')).toBe(true);
    expect(validPageId('sources/src-abc123')).toBe(true);
    expect(validPageId('index')).toBe(false);
    expect(validPageId('entities/Order')).toBe(false);
    expect(pageType('concepts/x')).toBe('concept');
    expect(extractWikilinks('see [[entities/a]] and [[topics/b|B]]')).toEqual([
      'entities/a',
      'topics/b|B',
    ]);
  });
  it('projects errors onto the public contract', () => {
    expect(publicError(new Error('boom')).code).toBe('KB_INTERNAL');
    expect(publicError(Object.assign(new Error('x'), { code: 'KB_STORAGE_BUSY' })).retryable).toBe(
      true,
    );
  });
});

describe('normalization', () => {
  it('decodes strict UTF-8 with BOM and rejects binary content', () => {
    expect(decodeUtf8(Buffer.from('﻿正文', 'utf8'))).toBe('正文');
    expect(() => decodeUtf8(Buffer.from([0xff, 0xfe]))).toThrow('KB_ENCODING_UNSUPPORTED');
    expect(() => decodeUtf8(Buffer.from('a' + NUL + 'b'))).toThrow('KB_BINARY_CONTENT');
  });
  it('extracts HTML text without scripts and keeps markdown headings', () => {
    const html = normalizeText(
      '.html',
      '<html><head><title>T</title><script>evil()</script></head>' +
        '<body><h1>标题</h1><p>正文</p><ul><li>甲</li><li>乙</li></ul></body></html>',
    );
    expect(html.title).toBe('T');
    expect(html.content).toContain('# 标题');
    expect(html.content).toContain('- 甲');
    expect(html.content).not.toContain('evil');
    const md = normalizeText('.md', '# 需求\n内容');
    expect(md.title).toBe('需求');
    expect(md.normalized).toBe(false);
    expect(() => normalizeText('.md', '   ')).toThrow('KB_SOURCE_EMPTY');
  });
});

describe('source repository', () => {
  it('imports whitelisted files, skips unsupported types, and reports per-item outcomes', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    await writeDoc('alice/b.txt', '乙');
    await writeDoc('alice/c.pdf', 'not really pdf');
    const result = await importFiles(store, {
      files: [
        { relativePath: 'alice/a.md' },
        { relativePath: 'alice/b.txt' },
        { relativePath: 'alice/c.pdf' },
      ],
    });
    expect(result.saved).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.results.find((r) => r.relativePath === 'alice/c.pdf').code).toBe(
      'KB_UNSUPPORTED_TYPE',
    );
    const list = await listSources(store, {});
    expect(list.total).toBe(2);
  });
  it('lists import candidates with snapshot state and batch limit', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    await writeDoc('alice/b.txt', '乙');
    await writeDoc('alice/ignored.pdf', 'binary');
    await writeDoc('alice/.hidden/c.md', '# Hidden');
    const before = await listFileCandidates(store);
    expect(before.items.map((item) => item.relativePath)).toEqual(['alice/a.md', 'alice/b.txt']);
    expect(before.items.every((item) => item.state === 'new')).toBe(true);
    expect(before.batchLimit).toBe(100);
    expect(before.truncated).toBe(false);
    expect(before.base).toEqual({ workspace: 'ws', path: store.scope.docsRoot });

    await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    const after = await listFileCandidates(store);
    const byPath = Object.fromEntries(after.items.map((item) => [item.relativePath, item.state]));
    expect(byPath['alice/a.md']).toBe('imported');
    expect(byPath['alice/b.txt']).toBe('new');

    await writeDoc('alice/a.md', '# A\n丙');
    const changed = await listFileCandidates(store);
    expect(changed.items.find((item) => item.relativePath === 'alice/a.md').state).toBe('changed');
  });
  it('rejects traversal and absolute paths per item without failing the batch', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    const result = await importFiles(store, {
      files: [
        { relativePath: 'alice/a.md' },
        { relativePath: '../escape.md' },
        { relativePath: '/etc/passwd' },
      ],
    });
    expect(result.saved).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.results.filter((r) => r.code === 'KB_PATH_DENIED')).toHaveLength(2);
  });
  it('skips unchanged re-imports and bumps the revision on content change', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    const first = await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    const id = first.results[0].sourceId;
    const again = await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    expect(again.results[0].status).toBe('skipped');
    await writeDoc('alice/a.md', '# A\n乙');
    const changed = await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    expect(changed.results[0].revision).toBe('rev-2');
    const { content } = await getSource(store, id);
    expect(content).toContain('乙');
  });
  it('reports file knowledge state for the viewer', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    expect((await stateByPath(store, 'alice/a.md')).state).toBe('missing');
    await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    expect((await stateByPath(store, 'alice/a.md')).state).toBe('saved');
    await writeDoc('alice/a.md', '# A\n丙');
    expect((await stateByPath(store, 'alice/a.md')).state).toBe('stale');
  });
  it('reports active compile jobs only for the current source revision', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    const id = sourceIdentity(store.scope.scopeId, 'file', { relativePath: 'alice/a.md' });
    for (const status of ['queued', 'running', 'cancelling']) {
      await store.writeJobs({
        jobs: [
          {
            id: 'compile-job',
            kind: 'ingest',
            sourceIds: [id],
            sourceRevisions: { [id]: 'rev-1' },
            status,
            createdAt: '2026-11-11T00:00:00.000Z',
          },
        ],
      });
      expect(await stateByPath(store, 'alice/a.md')).toMatchObject({
        state: 'compiling',
        sourceId: id,
        revision: 'rev-1',
        jobId: 'compile-job',
      });
    }
    await writeDoc('alice/a.md', '# A\n乙');
    await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    expect((await stateByPath(store, 'alice/a.md')).state).toBe('saved');
  });
  it('reports a failed compile with its public error', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    const id = sourceIdentity(store.scope.scopeId, 'file', { relativePath: 'alice/a.md' });
    await store.writeJobs({
      jobs: [
        {
          id: 'failed-job',
          kind: 'ingest',
          sourceIds: [id],
          sourceRevisions: { [id]: 'rev-1' },
          status: 'failed',
          createdAt: '2026-11-11T00:00:00.000Z',
          finishedAt: '2026-11-11T00:01:00.000Z',
          error: { code: 'KB_INTERNAL', details: {}, retryable: true },
        },
      ],
    });
    expect(await stateByPath(store, 'alice/a.md')).toMatchObject({
      state: 'failed',
      sourceId: id,
      revision: 'rev-1',
      jobId: 'failed-job',
      error: { code: 'KB_INTERNAL', retryable: true },
    });
  });
  it('keeps a newer successful release ahead of an older compile failure', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    const id = sourceIdentity(store.scope.scopeId, 'file', { relativePath: 'alice/a.md' });
    await mkdir(store.path('releases', 'gen-current'), { recursive: true });
    await writeFile(
      store.path('releases', 'gen-current', 'manifest.json'),
      JSON.stringify({
        sourceRevisions: { [id]: 'rev-1' },
        createdAt: '2026-11-11T01:00:00.000Z',
      }),
    );
    await writeFile(store.path('current.json'), JSON.stringify({ generationId: 'gen-current' }));
    const failedJob = {
      id: 'failed-job',
      kind: 'ingest',
      sourceIds: [id],
      sourceRevisions: { [id]: 'rev-1' },
      status: 'failed',
      createdAt: '2026-11-11T00:00:00.000Z',
      finishedAt: '2026-11-11T02:00:00.000Z',
    };
    await store.writeJobs({ jobs: [failedJob] });
    expect((await stateByPath(store, 'alice/a.md')).state).toBe('failed');
    await store.writeJobs({
      jobs: [{ ...failedJob, finishedAt: '2026-11-11T00:30:00.000Z' }],
    });
    expect((await stateByPath(store, 'alice/a.md')).state).toBe('compiled');
    await store.writeJobs({
      jobs: [{ ...failedJob, status: 'running', finishedAt: null }],
    });
    expect((await stateByPath(store, 'alice/a.md')).state).toBe('compiling');
  });
  it('imports a session markdown through the same snapshot pipeline', async () => {
    const origin = { provider: 'dsh', instance: 'i', sessionId: 's1' };
    const saved = await importSessionMarkdown(store, {
      origin,
      title: '会话一',
      markdown: '# 会话一\n内容',
      provenance: { turns: [] },
    });
    expect(saved.status).toBe('saved');
    const id = sourceIdentity(store.scope.scopeId, 'session', origin);
    expect(saved.sourceId).toBe(id);
    const { source } = await getSource(store, id);
    expect(source.kind).toBe('session');
  });
});

describe('session export', () => {
  const turn = (n, text, id) => ({
    turnNumber: n,
    sourceTurnId: id,
    status: 'completed',
    syncable: true,
    messages: [{ role: 'user', label: '用户', text }],
  });
  it('describes turns with stable keys and merges without duplicates', () => {
    const snapshot = { turns: [turn(1, '甲', 't1'), turn(2, '乙', 't2')] };
    const described = describeTurns(snapshot);
    expect(described.map((t) => t.key)).toEqual(['id:t1', 'id:t2']);
    const merged = mergeSessionTurns(described, described, { source: 'dsh', mode: 'merge' });
    expect(merged.counts.skipped).toBe(2);
    expect(merged.turns).toHaveLength(2);
  });
  it('replace mode keeps only selected turns', () => {
    const prior = describeTurns({ turns: [turn(1, '甲', 't1'), turn(2, '乙', 't2')] });
    const selected = describeTurns({ turns: [turn(2, '乙', 't2')] });
    const merged = mergeSessionTurns(prior, selected, { source: 'dsh', mode: 'replace' });
    expect(merged.turns).toHaveLength(1);
    expect(merged.turns[0].key).toBe('id:t2');
  });
  it('renders a markdown document with turn line ranges', () => {
    const described = describeTurns({ turns: [turn(1, '甲', 't1')] });
    const doc = buildSessionDocument({
      title: '会话',
      origin: { provider: 'dsh', sessionId: 's1' },
      snapshotVersion: 'v1',
      turns: described,
    });
    expect(doc.markdown).toContain('# 会话');
    expect(doc.markdown).toContain('## 第 1 轮');
    expect(doc.turns[0].endLine).toBeGreaterThan(doc.turns[0].startLine);
  });
  it('round-trips persisted flat provenance through repeated and partial imports without dropping turns', () => {
    const snapshot = { turns: [turn(1, 'First', 'one'), turn(2, 'Second', 'two')] };
    const input = {
      title: 'Session',
      origin: { provider: 'dsh', sessionId: 's' },
      snapshotVersion: 'v1',
    };
    const first = buildSessionDocument({ ...input, turns: describeTurns(snapshot) });
    expect(first.turns[0].turn).toBeUndefined();
    let persisted = JSON.parse(JSON.stringify(first.turns));
    for (let index = 0; index < 3; index++) {
      const merged = mergeSessionTurns(persisted, describeTurns({ turns: [snapshot.turns[1]] }), {
        source: 'dsh',
        mode: 'merge',
      });
      const next = buildSessionDocument({ ...input, turns: merged.turns });
      expect(next.markdown).toBe(first.markdown);
      expect(next.turns).toHaveLength(2);
      expect(merged.counts).toEqual({ added: 0, updated: 0, skipped: 1 });
      persisted = JSON.parse(JSON.stringify(next.turns));
    }
  });
  it('retains legacy message text in persisted provenance and rejects unrestorable turns', () => {
    const input = {
      title: 'Legacy',
      origin: { provider: 'codex', sessionId: 's' },
      snapshotVersion: 'v1',
    };
    const described = describeTurns({
      turns: [{ turnNumber: 1, userInput: 'Legacy question', summary: 'Legacy answer' }],
    });
    const first = buildSessionDocument({ ...input, turns: described });
    expect(first.turns[0].messages).toHaveLength(2);
    const merged = mergeSessionTurns(first.turns, [], { source: 'codex', mode: 'merge' });
    expect(buildSessionDocument({ ...input, turns: merged.turns }).markdown).toBe(first.markdown);
    const broken = mergeSessionTurns([{ key: 'id:broken', number: 1, status: 'completed' }], [], {
      source: 'dsh',
      mode: 'merge',
    });
    expect(() => buildSessionDocument({ ...input, turns: broken.turns })).toThrow(
      'KB_SESSION_PROVENANCE_INVALID',
    );
  });
  it('imports the same real persisted session source again without undefined turn.status', async () => {
    const snapshot = {
      version: 'snapshot',
      turns: [turn(1, 'First question', 'one'), turn(2, 'Second question', 'two')],
    };
    const context = {
      assertOpen() {},
      registry: { list: () => [{ id: 'ws' }] },
      sessionEntries: async () => [
        {
          conversationId: 'conversation',
          source: 'dsh',
          sourceInstanceId: 'instance',
          id: 'session',
          title: 'Session',
        },
      ],
      conversations: {
        library: {
          closed: false,
          store: { path: join(root, 'library-lock'), projectLocked: async () => snapshot },
        },
      },
    };
    const input = {
      selections: [{ id: 'conversation', version: 'snapshot', turnKeys: ['id:one', 'id:two'] }],
      ingest: false,
    };
    const first = await KnowledgeApplication.prototype.importSessions.call(context, store, input);
    expect(first.saved).toBe(1);
    const repeated = await KnowledgeApplication.prototype.importSessions.call(
      context,
      store,
      input,
    );
    expect(repeated).toMatchObject({ saved: 0, skipped: 1 });
    const partial = await KnowledgeApplication.prototype.importSessions.call(context, store, {
      ...input,
      selections: [{ ...input.selections[0], turnKeys: ['id:two'] }],
    });
    expect(partial).toMatchObject({ saved: 0, skipped: 1 });
    const source = await getSource(store, first.results[0].sourceId);
    expect(source.content).toContain('First question');
    expect(source.content).toContain('Second question');
  });
});

describe('session detail preview', () => {
  const store = { scope: { scopeId: 'sc' }, sources: async () => ({ sources: [] }) };
  const callDetail = (turns) => {
    const context = {
      registry: { list: () => [{ id: 'ws', title: 'W', path: '/w' }] },
      sessionEntries: async () => [
        {
          conversationId: 'c1',
          id: 's1',
          source: 'dsh',
          sourceInstanceId: 'i',
          snapshotVersion: 'v1',
          title: 'Fixture',
        },
      ],
      conversations: {
        library: {
          store: {
            project: async () => ({ version: 'v1', turns }),
            versions: async () => [{ version: 'v1' }],
          },
        },
      },
    };
    return KnowledgeApplication.prototype.sessionDetail.call(context, store, { id: 'c1' });
  };

  it('returns the frozen turn messages together with importable flags', async () => {
    const messages = [
      { role: 'user', kind: 'input', label: '用户输入', text: '原始输入' },
      { role: 'assistant', kind: 'final', label: '助手最终回复', text: '完整回复' },
    ];
    const detail = await callDetail([
      {
        turnNumber: 1,
        sourceTurnId: 't1',
        status: 'complete',
        syncable: true,
        messages,
      },
    ]);
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].messages).toEqual(messages);
    expect(detail.turns[0].importable).toBe(true);
  });

  it('normalizes legacy snapshots that never stored labelled messages', async () => {
    const legacy = {
      turnNumber: 1,
      status: 'completed',
      syncable: true,
      userInput: '旧版问题',
      summary: '旧版回答',
    };
    const detail = await callDetail([legacy]);
    expect(detail.turns[0].messages).toEqual([
      { role: 'user', kind: 'input', label: '用户输入', text: '旧版问题' },
      { role: 'assistant', kind: 'final', label: '助手最终回复', text: '旧版回答' },
    ]);
    const described = describeTurns({ turns: [legacy] });
    expect(described[0].anchor).toBeTruthy();
    const doc = buildSessionDocument({
      title: '会话',
      origin: { provider: 'dsh', sessionId: 's1' },
      snapshotVersion: 'v1',
      turns: described,
    });
    expect(doc.markdown).toContain('旧版问题');
    expect(sessionMessages({ messages: [] })).toEqual([]);
    expect(sessionMessages({ messages: [{ role: 'user', content: '正文' }] })[0].text).toBe('正文');
  });
});

describe('task runtime', () => {
  it('returns actionable validation details and does not reset failed submission limits on a read', async () => {
    const tools = new Map();
    const installation = installKbTaskTools({
      tools: {
        register: (tool) => {
          tools.set(tool.name, tool);
          return () => tools.delete(tool.name);
        },
        guard: () => () => {},
      },
      on: () => () => {},
    });
    const runtime = new KbTaskRuntime({
      kind: 'generate',
      documents: [{ id: 'evidence', body: 'text' }],
      validateResult: () => {
        throw Object.assign(new Error('KB_MODEL_OUTPUT_INVALID'), {
          code: 'KB_MODEL_OUTPUT_INVALID',
          details: { reason: 'baseHash mismatch', pageId: 'entities/order' },
        });
      },
    });
    installation.add(runtime);
    runtime.bindSession('child');
    const caller = { agent: { session: { id: 'child' } } };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() =>
          tools.get('req_hub_kb_task_submit').execute({ result: { upserts: [] } }, caller),
        ).toThrow('baseHash mismatch');
        tools.get('req_hub_kb_task_read').execute({ id: 'evidence' }, caller);
      }
      expect(() =>
        tools.get('req_hub_kb_task_submit').execute({ result: { upserts: [] } }, caller),
      ).toThrow('KB_TOOL_FAILED');
      expect(runtime.failure.details).toMatchObject({
        cause: 'KB_MODEL_OUTPUT_INVALID',
        causeDetails: { reason: 'baseHash mismatch' },
      });
    } finally {
      installation.dispose();
    }
  });
  const docs = () => [
    { id: 'rules', kind: 'rules', title: 'r', body: 'rules', version: 'h', required: true },
    {
      id: 'source:s1',
      kind: 'source',
      title: 's',
      body: 'line1\nline2',
      version: 'rev-1',
      required: true,
    },
  ];
  it('requires fully reading required documents before submit', () => {
    const runtime = new KbTaskRuntime({ kind: 'analyze', documents: docs() });
    expect(() =>
      runtime.submit({
        summary: 'x',
        facts: [],
        entities: [],
        concepts: [],
        existingPageIds: [],
        conflicts: [],
        proposedPages: [],
      }),
    ).toThrow('KB_EVIDENCE_NOT_FULLY_READ');
    for (const doc of runtime.documents) {
      let offset = 0;
      while (true) {
        const page = runtime.read({ id: doc.id, offset });
        offset = page.nextOffset;
        if (page.eof) break;
      }
    }
    const receipt = runtime.submit({
      summary: '摘要',
      facts: [],
      entities: [],
      concepts: [],
      existingPageIds: [],
      conflicts: [],
      proposedPages: [],
    });
    expect(receipt.success).toBe(true);
    expect(runtime.result.summary).toBe('摘要');
  });
  it('validates generate upsert source ranges', () => {
    const runtime = new KbTaskRuntime({ kind: 'generate', documents: docs() });
    for (const doc of runtime.documents) {
      let offset = 0;
      while (true) {
        const page = runtime.read({ id: doc.id, offset });
        offset = page.nextOffset;
        if (page.eof) break;
      }
    }
    expect(() =>
      runtime.submit({
        upserts: [
          { pageId: 'entities/x', type: 'entity', title: 'X', body: 'b', sources: [{ id: 's1' }] },
        ],
        overview: '',
        findings: [],
      }),
    ).toThrow('KB_MODEL_OUTPUT_INVALID');
  });
});

describe('compiler validation', () => {
  const base = () => {
    const source = { id: 's1', revision: 'rev-1' };
    const active = new Map([['s1', source]]);
    const contents = new Map([['s1', 'line1\nline2\nline3']]);
    return { source, active, currentPages: [], contents };
  };
  const upsert = (over = {}) => ({
    pageId: 'entities/order',
    type: 'entity',
    title: 'Order',
    body: '事实 [e](source:s1@rev-1#L1-L2)',
    sources: [{ id: 's1', revision: 'rev-1', startLine: 1, endLine: 2 }],
    ...over,
  });
  it('accepts a valid new page citing the assigned source', () => {
    const out = validateUpserts([upsert()], base());
    expect(out[0].pageId).toBe('entities/order');
    expect(out[0].sources).toEqual([{ id: 's1', revision: 'rev-1' }]);
  });
  it('rejects Host-owned pages, type mismatch, and out-of-range citations', () => {
    expect(() =>
      validateUpserts([upsert({ pageId: 'sources/s1', type: 'source' })], base()),
    ).toThrow('KB_MODEL_OUTPUT_INVALID');
    expect(() => validateUpserts([upsert({ type: 'concept' })], base())).toThrow(
      'KB_MODEL_OUTPUT_INVALID',
    );
    expect(() =>
      validateUpserts(
        [upsert({ sources: [{ id: 's1', revision: 'rev-1', startLine: 1, endLine: 99 }] })],
        base(),
      ),
    ).toThrow('KB_MODEL_OUTPUT_INVALID');
    expect(() => validateUpserts([upsert({ body: 'no citation' })], base())).not.toThrow();
  });
  it('requires baseHash to match the current page on update', () => {
    const ctx = base();
    ctx.currentPages = [{ pageId: 'entities/order', hash: 'currenthash' }];
    expect(() => validateUpserts([upsert({ baseHash: 'wrong' })], ctx)).toThrow(
      'KB_MODEL_OUTPUT_INVALID',
    );
    expect(() => validateUpserts([upsert({ baseHash: 'currenthash' })], ctx)).not.toThrow();
  });
});

describe('publisher and lint', () => {
  const seedSource = async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    const r = await importFiles(store, { files: [{ relativePath: 'alice/a.md' }] });
    return r.results[0].sourceId;
  };
  it('finalizes and atomically publishes a generation with a source summary', async () => {
    const id = await seedSource();
    const rules = await store.rules();
    const staging = await prepareStaging(store, 'job1');
    await writeStagingPage(staging, {
      pageId: 'sources/' + id,
      type: 'source',
      title: 'A',
      body: '摘要',
      sources: [{ id, revision: 'rev-1' }],
    });
    await writeStagingPage(staging, {
      pageId: 'entities/order',
      type: 'entity',
      title: 'Order',
      body: '事实 [[sources/' + id + ']]',
      sources: [{ id, revision: 'rev-1' }],
    });
    const finalized = await finalizeStaging(store, staging, {
      jobId: 'job1',
      baseGeneration: null,
      rulesHash: rules.rulesHash,
      sourceRevisions: { [id]: 'rev-1' },
      operation: 'rebuild',
      overview: '总览',
    });
    await publishRelease(store, staging, {
      generationId: finalized.generationId,
      jobId: 'job1',
      epoch: rules.epoch,
      rulesHash: rules.rulesHash,
      sourceRevisions: { [id]: 'rev-1' },
      baseGeneration: null,
    });
    expect((await store.current()).generationId).toBe(finalized.generationId);
    const pages = await readStagingPages(join(store.dir, 'releases', finalized.generationId));
    expect(pages.map((p) => p.pageId).sort()).toEqual(['entities/order', 'sources/' + id].sort());
  });
  it('rejects publish when the source revision changed (stale)', async () => {
    const id = await seedSource();
    const rules = await store.rules();
    const staging = await prepareStaging(store, 'job2');
    await writeStagingPage(staging, {
      pageId: 'sources/' + id,
      type: 'source',
      title: 'A',
      body: '摘要',
      sources: [{ id, revision: 'rev-1' }],
    });
    const finalized = await finalizeStaging(store, staging, {
      jobId: 'job2',
      baseGeneration: null,
      rulesHash: rules.rulesHash,
      sourceRevisions: { [id]: 'rev-1' },
      operation: 'rebuild',
      overview: '',
    });
    await expect(
      publishRelease(store, staging, {
        generationId: finalized.generationId,
        jobId: 'job2',
        epoch: rules.epoch,
        rulesHash: rules.rulesHash,
        sourceRevisions: { [id]: 'rev-2' },
        baseGeneration: null,
      }),
    ).rejects.toThrow('KB_STALE');
    expect((await store.current()).generationId).toBeNull();
  });
  it('flags broken links, orphans, and stale sources', () => {
    const pages = [
      {
        pageId: 'entities/a',
        meta: { type: 'entity', sources: [{ id: 's1', revision: 'rev-1' }] },
        body: '',
        links: ['entities/missing'],
      },
      {
        pageId: 'entities/b',
        meta: { type: 'entity', sources: [{ id: 's1', revision: 'rev-9' }] },
        body: '',
        links: [],
      },
    ];
    const findings = structuralLint({ pages, sourceRevisions: { s1: 'rev-1' } });
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('broken_link');
    expect(kinds).toContain('orphan');
    expect(kinds).toContain('stale_source');
    expect(isAnswerable(pages[0], { s1: 'rev-1' })).toBe(true);
    expect(isAnswerable(pages[1], { s1: 'rev-1' })).toBe(false);
  });
});

describe('search index', () => {
  it('ranks pages and excludes stale sources from answerable results', () => {
    const pages = [
      {
        pageId: 'entities/order',
        meta: { title: '订单状态', type: 'entity', sources: [{ id: 's1', revision: 'rev-1' }] },
        body: '订单审核后发货',
        links: [],
      },
      {
        pageId: 'entities/stale',
        meta: { title: '订单旧', type: 'entity', sources: [{ id: 's1', revision: 'rev-0' }] },
        body: '订单旧规则',
        links: [],
      },
    ];
    const index = new WikiSearchIndex({
      generationId: 'g1',
      pages,
      sourceRevisions: { s1: 'rev-1' },
    });
    const all = index.search('订单');
    expect(all.hits.length).toBe(2);
    const answerable = index.search('订单', { answerableOnly: true });
    expect(answerable.hits.map((h) => h.pageId)).toEqual(['entities/order']);
  });
});

describe('job queue', () => {
  const makeQueue = (runJob) =>
    new KnowledgeQueue({ getStores: () => [store], runJob, onChange: () => {} });
  const spec = (over = {}) => ({
    kind: 'rebuild',
    requestKey: 'key-1',
    inputHash: 'hash-1',
    sourceIds: null,
    sourceRevisions: {},
    rulesHash: 'r',
    ...over,
  });
  it('runs a job to completion and records the generation', async () => {
    const queue = makeQueue(async () => ({ generationId: 'gen-x', summary: { pages: 1 } }));
    const job = await queue.enqueue(store, spec());
    await queue.pending;
    const saved = (await store.jobs()).jobs.find((j) => j.id === job.id);
    expect(saved.status).toBe('completed');
    expect(saved.generationId).toBe('gen-x');
    await queue.close();
  });
  it('is idempotent per requestKey and rejects a conflicting input hash', async () => {
    const queue = makeQueue(async () => ({ generationId: 'gen-x' }));
    const first = await queue.enqueue(store, spec());
    await queue.pending;
    const again = await queue.enqueue(store, spec());
    expect(again.id).toBe(first.id);
    await expect(queue.enqueue(store, spec({ inputHash: 'different' }))).rejects.toThrow(
      'KB_JOB_CONFLICT',
    );
    await queue.close();
  });
  it('marks a skipped job without a generation', async () => {
    const queue = makeQueue(async () => ({ skipped: true, summary: { reason: 'current' } }));
    const job = await queue.enqueue(store, spec());
    await queue.pending;
    const saved = (await store.jobs()).jobs.find((j) => j.id === job.id);
    expect(saved.status).toBe('skipped');
    expect(saved.generationId).toBeNull();
    await queue.close();
  });
  it('records a failure with a public error and allows retry as a new job', async () => {
    const queue = makeQueue(async () => {
      throw Object.assign(new Error('KB_MODEL_FAILED'), { code: 'KB_MODEL_FAILED', status: 502 });
    });
    const job = await queue.enqueue(store, spec());
    await queue.pending;
    const failed = (await store.jobs()).jobs.find((j) => j.id === job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error.code).toBe('KB_MODEL_FAILED');
    queue.runJob = async () => ({ generationId: 'gen-retry' });
    const retried = await queue.resume(store, job.id);
    await queue.pending;
    expect(retried.id).not.toBe(job.id);
    expect(retried.retryOf).toBe(job.id);
    expect((await store.jobs()).jobs.find((j) => j.id === retried.id).status).toBe('completed');
    await queue.close();
  });
  it('recovers interrupted runs and never auto-resumes restored queued jobs', async () => {
    await store.run(async () => {
      const manifest = await store.jobs();
      manifest.jobs.push(
        {
          id: 'old-run',
          scopeId: store.scope.scopeId,
          status: 'running',
          kind: 'rebuild',
          requestKey: 'k-run',
          inputHash: 'h',
          createdAt: '2026-01-01',
        },
        {
          id: 'old-queue',
          scopeId: store.scope.scopeId,
          status: 'queued',
          kind: 'rebuild',
          requestKey: 'k-queue',
          inputHash: 'h',
          createdAt: '2026-01-01',
        },
      );
      await store.writeJobs(manifest);
    });
    let ran = false;
    const queue = makeQueue(async () => {
      ran = true;
      return { generationId: 'gen' };
    });
    await queue.recover(store);
    await queue.pending;
    const jobs = (await store.jobs()).jobs;
    expect(jobs.find((j) => j.id === 'old-run').status).toBe('interrupted');
    expect(jobs.find((j) => j.id === 'old-queue').status).toBe('queued');
    expect(ran).toBe(false);
    await queue.close();
  });
  it('cancels a queued job without running it', async () => {
    const queue = makeQueue(async () => ({ generationId: 'gen' }));
    queue.closed = false;
    const job = await queue.enqueue(store, spec());
    queue.auto.delete(job.id);
    const cancelled = await queue.cancel(store, job.id);
    expect(cancelled.status).toBe('cancelled');
    await queue.close();
  });
});

describe('knowledge v2 routes', () => {
  const response = () => ({
    status: null,
    body: null,
    writeHead(status) {
      this.status = status;
    },
    end(text) {
      this.body = text;
    },
  });
  const request = (method, path) => ({
    method,
    url: `http://localhost/req-hub/knowledge-v2${path}`,
  });
  const application = () => ({
    scope: vi.fn(async () => ({})),
    sessionOptions: vi.fn(async () => ({ sources: [], adapters: [] })),
    sessionDetail: vi.fn(async () => ({ id: 'detail' })),
    importSessions: vi.fn(async () => ({})),
  });

  it('serves session collection routes before the /sources/:id catch-all', async () => {
    const app = application();
    const [route] = createKnowledgeV2Routes(app);

    const listing = response();
    await route.handler(request('GET', '/sources/sessions?workspaceId=ws'), listing);
    expect(listing.status).toBe(200);
    expect(JSON.parse(listing.body)).toEqual({ sources: [], adapters: [] });
    expect(app.sessionOptions).toHaveBeenCalledWith('ws');

    const detail = response();
    await route.handler(
      request('GET', '/sources/sessions/detail?workspaceId=ws&id=session-1'),
      detail,
    );
    expect(detail.status).toBe(200);
    expect(JSON.parse(detail.body)).toEqual({ id: 'detail' });
  });

  it('serves file candidates from the authorized workspace scope', async () => {
    await writeDoc('alice/a.md', '# A\n甲');
    const app = application();
    app.scope = vi.fn(async () => store);
    const [route] = createKnowledgeV2Routes(app);
    const res = response();
    await route.handler(request('GET', '/sources/files/candidates?workspaceId=ws'), res);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items.map((item) => item.relativePath)).toEqual(['alice/a.md']);
    expect(body.items[0].state).toBe('new');
    expect(body.batchLimit).toBe(100);
    expect(body.base).toEqual({ workspace: 'ws', path: store.scope.docsRoot });
  });

  it('rejects requests without an explicit workspace id', async () => {
    const app = application();
    const [route] = createKnowledgeV2Routes(app);
    const res = response();
    await route.handler(request('GET', '/sources/sessions'), res);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('KB_INPUT_INVALID');
  });
});
