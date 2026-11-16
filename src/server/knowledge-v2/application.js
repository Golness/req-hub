import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig } from '../config.js';
import { disposeAll } from '../plugin-boundaries.js';
import { withDocumentLock } from '../sync-document-validator.js';
import { matchesWorkspacePath } from '../conversations/workspace-path.js';
import { hash as conversationHash } from '../conversations/store.js';
import { createWorkspaceTaskAgent } from '../workspace-task-agent.js';
import { resolveSyncBudget } from '../sync-budget.js';
import {
  digest,
  fail,
  now,
  publicError,
  extractWikilinks,
  LIMITS,
  SCHEMA_VERSION,
} from './contracts.js';
import { knowledgeV2Root, resolveScope, ScopeStore, writeJsonAtomic } from './scope.js';
import {
  importFiles,
  importSessionMarkdown,
  listSources,
  getSource,
  stateByPath,
  readReleaseManifest,
  excludeSource,
  sourceIdentity,
} from './source-repository.js';
import {
  describeTurns,
  matchingTurn,
  mergeSessionTurns,
  buildSessionDocument,
  sessionMessages,
  SESSION_EXPORT_VERSION,
} from './session-export.js';
import { KnowledgeQueue } from './queue.js';
import { installKbTaskTools } from './runtime.js';
import { runCompile, runModelStep } from './compiler.js';
import { readWikiPages, cleanStaging } from './publisher.js';
import { structuralLint } from './lint.js';
import { WikiSearchIndex } from './search.js';
import { KnowledgeSyncScheduler } from './sync-scheduler.js';
import { KnowledgeContext } from './context.js';

const JOB_KINDS = ['ingest', 'rebuild', 'lint'];

/**
 * Knowledge-v2 facade: scope stores, the serial job queue, and read services.
 * Routes and Agent tools call these same methods; no second write path exists.
 */
export class KnowledgeApplication {
  /**
   * @param options - {ctx, registry, profileDir, lark}; ctx is the injected Host context.
   */
  constructor({
    ctx,
    registry,
    profileDir,
    configLoader = loadConfig,
    configSaver = saveConfig,
    lark = null,
    onSyncError,
  }) {
    this.ctx = ctx;
    this.registry = registry;
    this.root = knowledgeV2Root({ profileDir });
    this.configLoader = configLoader;
    this.stores = new Map();
    this.indexCache = new Map();
    this.closed = false;
    this.installation = installKbTaskTools(ctx);
    this.queue = new KnowledgeQueue({
      getStores: () => [...this.stores.values()],
      runJob: (job, run) => this.runJob(job, run),
      onChange: (job) => this.onJobChange?.(job),
    });
    this.sync = new KnowledgeSyncScheduler({
      application: this,
      configLoader,
      configSaver,
      lark,
      onError: onSyncError,
    });
    this.context = new KnowledgeContext(this);
  }
  assertOpen() {
    if (this.closed) {
      fail('KB_CLOSED', 503);
    }
  }
  /**
   * Resolve and lazily initialize one workspace scope; identity comes from the registry.
   * @param workspaceId - Host workspace identity.
   * @returns The initialized ScopeStore.
   */
  async scope(workspaceId) {
    this.assertOpen();
    const workspace = this.registry.list().find((item) => item.id === workspaceId);
    if (!workspace) {
      fail('KB_WORKSPACE_MISSING', 404, { workspaceId });
    }
    const config = await this.configLoader();
    const scope = await resolveScope({ root: this.root, workspace, docsDir: config.docsDir });
    const existing = this.stores.get(scope.scopeId);
    if (existing) {
      return existing;
    }
    const store = new ScopeStore(scope);
    await store.init();
    await this.recoverStore(store);
    this.stores.set(scope.scopeId, store);
    return store;
  }
  /** Restore published-but-unrecorded jobs, interrupt stale runs, drop leftover staging. */
  async recoverStore(store) {
    await cleanStaging(store);
    const pointer = await store.current();
    if (pointer.generationId) {
      const release = await readReleaseManifest(store, pointer.generationId);
      if (!release) {
        fail('KB_POINTER_CORRUPT', 500, {
          generationId: pointer.generationId,
          instruction: 'Rebuild the knowledge base from saved sources.',
        });
      }
      if (release.jobId) {
        const manifest = await store.jobs();
        const job = manifest.jobs.find((item) => item.id === release.jobId);
        if (job && ['running', 'cancelling', 'queued'].includes(job.status)) {
          await this.queue.update(store, job.id, {
            status: 'completed',
            stage: 'published',
            generationId: pointer.generationId,
            error: null,
            finishedAt: now(),
          });
        }
      }
    }
    await this.queue.recover(store);
  }
  async runJob(job, { store, signal, onStage }) {
    this.assertOpen();
    if (job.kind === 'ingest' || job.kind === 'rebuild') {
      return runCompile({
        ctx: this.ctx,
        llm: this.ctx.llm,
        configLoader: this.configLoader,
        store,
        job,
        signal,
        onStage,
        installation: this.installation,
      });
    }
    if (job.kind === 'lint') {
      return this.runSemanticLint({ store, signal, onStage });
    }
    fail('KB_JOB_INVALID', 400, { kind: job.kind });
  }
  async enqueueCompile(store, kind, sourceIds) {
    const rules = await store.rules();
    const manifest = await store.sources();
    const active = manifest.sources.filter((source) => source.status !== 'excluded');
    const revisions = Object.fromEntries(active.map((source) => [source.id, source.revision]));
    return this.queue.enqueue(store, {
      kind,
      requestKey: randomUUID(),
      inputHash: digest([kind, sourceIds || null, revisions, rules.rulesHash]),
      sourceIds: sourceIds || null,
      sourceRevisions: revisions,
      rulesHash: rules.rulesHash,
    });
  }
  /**
   * Import whitelisted files, then optionally queue one ingest job.
   * @param store - The owning scope store.
   * @param input - {files, requestKey, ingest, signal}.
   * @returns Per-item results plus the queued job when ingest was requested.
   */
  async importFiles(store, { files, requestKey, ingest, signal }) {
    this.assertOpen();
    if (!requestKey || typeof requestKey !== 'string') {
      fail('KB_IMPORT_INVALID', 400, { reason: 'requestKey required' });
    }
    const result = await importFiles(store, { files, signal });
    if (ingest && result.saved) {
      result.job = await this.enqueueCompile(
        store,
        'ingest',
        result.results.filter((item) => item.status === 'saved').map((item) => item.sourceId),
      );
    }
    return result;
  }
  /** Sessions visible to one workspace through the shared conversation library. */
  async sessionEntries(workspace) {
    const { library, adapters } = this.conversations || {};
    if (!library || !adapters?.length) {
      fail('KB_SESSIONS_UNAVAILABLE', 503);
    }
    await library.ready();
    const db = await library.store.database();
    const ids = new Set();
    for (const row of db
      .prepare('SELECT scope FROM scope_access WHERE owner=?')
      .all(library.owner)) {
      ids.add(row.scope);
    }
    const entries = [];
    for (const id of ids) {
      const scope = db.prepare('SELECT * FROM scopes WHERE id=?').get(id);
      if (
        !scope ||
        !adapters.some(
          (adapter) => adapter.source === scope.source && adapter.instance === scope.instance,
        )
      ) {
        continue;
      }
      const origin = JSON.parse(scope.payload);
      if (workspace && scope.source !== 'codex' && !matchesWorkspacePath(origin, workspace.path)) {
        continue;
      }
      for (const entry of await library.store.list(id)) {
        if (
          workspace &&
          scope.source === 'codex' &&
          !matchesWorkspacePath({ path: entry.cwd }, workspace.path)
        ) {
          continue;
        }
        const versions = await library.store.versions(entry.conversationId);
        if (!versions.length) {
          continue;
        }
        entries.push({
          ...entry,
          source: scope.source,
          snapshotVersion: entry.snapshotVersion || versions[0].version,
          sourceScopeId: id,
          sourceInstanceId: conversationHash(scope.instance),
        });
      }
    }
    return entries;
  }
  /**
   * List importable sessions with their per-session knowledge state.
   * @param workspaceId - Target workspace identity.
   * @returns {sessions, workspace} for the import picker.
   */
  async sessionOptions(workspaceId) {
    const store = await this.scope(workspaceId);
    const workspace = this.registry.list().find((item) => item.id === workspaceId);
    const entries = await this.sessionEntries(workspace);
    const manifest = await store.sources();
    const sessions = entries.map((entry) => {
      const id = sourceIdentity(store.scope.scopeId, 'session', {
        provider: entry.source,
        instance: entry.sourceInstanceId,
        sessionId: entry.id,
      });
      const saved = manifest.sources.find((item) => item.id === id && item.status !== 'excluded');
      return { ...entry, sourceId: saved?.id || null, state: saved ? 'saved' : 'missing' };
    });
    return {
      sessions,
      workspace: { id: workspace.id, title: workspace.title || workspace.id, path: workspace.path },
    };
  }
  /**
   * Describe selectable turns and their state against the prior session import.
   * @param store - The owning scope store.
   * @param input - {id, version?}; id is the library conversation ID.
   * @returns {entry, version, versions, turns} with importable flags and the
   *   normalized frozen messages of each turn for the read-only preview.
   */
  async sessionDetail(store, { id, version }) {
    const workspace = this.registry.list().find((item) => item.id === store.scope.workspaceId);
    const entries = await this.sessionEntries(workspace);
    const entry = entries.find((item) => item.conversationId === id);
    if (!entry) {
      fail('KB_SESSION_MISSING', 404, { id });
    }
    const { library } = this.conversations;
    const snapshot = await library.store.project(id, version || entry.snapshotVersion);
    const sourceId = sourceIdentity(store.scope.scopeId, 'session', {
      provider: entry.source,
      instance: entry.sourceInstanceId,
      sessionId: entry.id,
    });
    let prior = [];
    const manifest = await store.sources();
    if (manifest.sources.some((item) => item.id === sourceId && item.status !== 'excluded')) {
      const { provenance } = await getSource(store, sourceId);
      prior = provenance.turns || [];
    }
    const turns = describeTurns(snapshot).map((item) => {
      let existing;
      let ambiguous = false;
      try {
        existing = matchingTurn(prior, item);
      } catch {
        ambiguous = true;
      }
      const conflict =
        ambiguous ||
        (existing &&
          entry.source === 'codex' &&
          item.key.startsWith('number:') &&
          existing.anchor !== item.anchor);
      let knowledgeState;
      if (conflict) {
        knowledgeState = 'conflict';
      } else if (!existing) {
        knowledgeState = 'new';
      } else if (existing.hash === item.hash && existing.key === item.key) {
        knowledgeState = 'same';
      } else {
        knowledgeState = 'changed';
      }
      return {
        key: item.key,
        position: item.position,
        number: item.number,
        status: item.turn.status,
        syncable: item.turn.syncable,
        importable: !conflict,
        knowledgeState,
        messages: sessionMessages(item.turn),
      };
    });
    return {
      entry,
      version: snapshot.version,
      versions: await library.store.versions(id),
      turns,
    };
  }
  /**
   * Export selected session turns to Markdown files, then import through the source pipeline.
   * Selections stay inside the library lock so snapshots cannot change mid-export.
   * @param store - The owning scope store.
   * @param input - {selections:[{id,version,turnKeys}], mode, ingest, signal}.
   * @returns Per-session outcomes plus the queued ingest job when requested.
   */
  async importSessions(store, { selections, mode = 'merge', ingest, signal }) {
    this.assertOpen();
    if (
      !Array.isArray(selections) ||
      !selections.length ||
      selections.length > LIMITS.maxSessionsPerImport ||
      !['merge', 'replace'].includes(mode)
    ) {
      fail('KB_SELECTION_INVALID', 400);
    }
    if (new Set(selections.map((item) => item?.id)).size !== selections.length) {
      fail('KB_SELECTION_INVALID', 400, { reason: 'duplicate session' });
    }
    const workspace = this.registry.list().find((item) => item.id === store.scope.workspaceId);
    const entries = await this.sessionEntries(workspace);
    const { library } = this.conversations;
    const results = await withDocumentLock(library.store.path, async () => {
      this.assertOpen();
      if (library.closed) {
        fail('KB_SESSIONS_UNAVAILABLE', 503);
      }
      const prepared = [];
      for (const selected of selections) {
        signal?.throwIfAborted();
        const entry = entries.find((item) => item.conversationId === selected?.id);
        if (
          !entry ||
          typeof selected.version !== 'string' ||
          !Array.isArray(selected.turnKeys) ||
          !selected.turnKeys.length ||
          new Set(selected.turnKeys).size !== selected.turnKeys.length
        ) {
          fail('KB_SELECTION_INVALID', 400);
        }
        const snapshot = await library.store.projectLocked(entry.conversationId, selected.version);
        const turns = describeTurns(snapshot).filter((turn) =>
          selected.turnKeys.includes(turn.key),
        );
        if (
          turns.length !== selected.turnKeys.length ||
          turns.some((item) => !sessionMessages(item.turn).length)
        ) {
          fail('KB_SELECTION_INVALID', 400);
        }
        const origin = {
          provider: entry.source,
          instance: entry.sourceInstanceId,
          sessionId: entry.id,
        };
        const id = sourceIdentity(store.scope.scopeId, 'session', origin);
        const manifest = await store.sources();
        let prior = [];
        if (manifest.sources.some((item) => item.id === id && item.status !== 'excluded')) {
          prior = (await getSource(store, id)).provenance.turns || [];
        }
        const merged = mergeSessionTurns(prior, turns, { source: entry.source, mode });
        const document = buildSessionDocument({
          title: entry.title,
          origin,
          snapshotVersion: snapshot.version,
          turns: merged.turns,
        });
        prepared.push({ origin, title: entry.title, document, counts: merged.counts, id });
      }
      const outcomes = [];
      for (const item of prepared) {
        signal?.throwIfAborted();
        const saved = await importSessionMarkdown(store, {
          origin: item.origin,
          title: item.title,
          markdown: item.document.markdown,
          provenance: {
            sessionExportVersion: SESSION_EXPORT_VERSION,
            snapshotVersion: item.document.turns.at(-1)?.snapshotVersion || null,
            turns: item.document.turns,
          },
          signal,
        });
        outcomes.push({ sessionId: item.origin.sessionId, ...item.counts, ...saved });
      }
      return outcomes;
    });
    const response = {
      results: results,
      saved: results.filter((item) => item.status === 'saved').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
    };
    if (ingest && response.saved) {
      response.job = await this.enqueueCompile(
        store,
        'ingest',
        results.filter((item) => item.status === 'saved').map((item) => item.sourceId),
      );
    }
    return response;
  }
  /**
   * Queue one compile or semantic-lint job with requestKey idempotency.
   * @param store - The owning scope store.
   * @param input - {kind, sourceIds?, requestKey}.
   * @returns The queued or existing job record.
   */
  async createJob(store, { kind, sourceIds, requestKey }) {
    this.assertOpen();
    if (!JOB_KINDS.includes(kind)) {
      fail('KB_JOB_INVALID', 400, { kind });
    }
    if (kind === 'ingest') {
      const manifest = await store.sources();
      const active = new Set(
        manifest.sources
          .filter((source) => source.status !== 'excluded')
          .map((source) => source.id),
      );
      if (
        !Array.isArray(sourceIds) ||
        !sourceIds.length ||
        sourceIds.some((id) => !active.has(id))
      ) {
        fail('KB_JOB_INVALID', 400, { reason: 'sourceIds must name saved sources' });
      }
    }
    if (kind === 'lint') {
      const pointer = await store.current();
      if (!pointer.generationId) {
        fail('KB_RELEASE_MISSING', 409);
      }
    }
    const rules = await store.rules();
    const manifest = await store.sources();
    const revisions = Object.fromEntries(
      manifest.sources
        .filter((source) => source.status !== 'excluded')
        .map((source) => [source.id, source.revision]),
    );
    return this.queue.enqueue(store, {
      kind,
      requestKey,
      inputHash: digest([kind, sourceIds || null, revisions, rules.rulesHash]),
      sourceIds: sourceIds || null,
      sourceRevisions: revisions,
      rulesHash: rules.rulesHash,
    });
  }
  async jobs(store) {
    const manifest = await store.jobs();
    return {
      jobs: [...manifest.jobs].sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)),
      ),
    };
  }
  /** Read one job record; unknown IDs reject. */
  async job(store, jobId) {
    const manifest = await store.jobs();
    const job = manifest.jobs.find((item) => item.id === jobId);
    if (!job) {
      fail('KB_JOB_MISSING', 404, { jobId });
    }
    return job;
  }
  async cancelJob(store, jobId) {
    return this.queue.cancel(store, jobId);
  }
  async resumeJob(store, jobId) {
    this.assertOpen();
    return this.queue.resume(store, jobId);
  }
  /** Load the published generation with parsed pages; cached per generation. */
  async release(store) {
    const pointer = await store.current();
    if (!pointer.generationId) {
      return null;
    }
    const cached = this.indexCache.get(store.scope.scopeId);
    if (cached?.generationId === pointer.generationId) {
      return cached;
    }
    const manifest = await readReleaseManifest(store, pointer.generationId);
    if (!manifest) {
      fail('KB_POINTER_CORRUPT', 500, { generationId: pointer.generationId });
    }
    const pages = await readWikiPages(store.path('releases', pointer.generationId, 'wiki'));
    const release = {
      generationId: pointer.generationId,
      manifest,
      pages,
      index: new WikiSearchIndex({
        generationId: pointer.generationId,
        pages,
        sourceRevisions: manifest.sourceRevisions,
      }),
    };
    this.indexCache.set(store.scope.scopeId, release);
    return release;
  }
  /**
   * List published pages; Host aggregates (index/overview/log) are included.
   * @param store - The owning scope store.
   * @returns {generationId, pages, publishedAt} or an empty catalog.
   */
  async listPages(store) {
    const release = await this.release(store);
    if (!release) {
      return { generationId: null, pages: [], publishedAt: null };
    }
    const aggregates = [];
    for (const name of ['index', 'overview', 'log']) {
      const text = await readFile(
        store.path('releases', release.generationId, 'wiki', name + '.md'),
        'utf8',
      ).catch(() => null);
      if (text !== null) {
        aggregates.push({ pageId: name, title: name, type: 'aggregate', text });
      }
    }
    return {
      generationId: release.generationId,
      publishedAt: release.manifest.createdAt,
      pages: [
        ...release.pages.map((page) => ({
          pageId: page.pageId,
          title: page.meta.title,
          type: page.meta.type,
          sources: page.meta.sources,
          updatedAt: page.meta.updatedAt,
        })),
        ...aggregates.map(({ pageId, title, type }) => ({ pageId, title, type, sources: [] })),
      ],
    };
  }
  /**
   * Read one published page with its full text.
   * @param store - The owning scope store.
   * @param pageId - Logical page path or a Host aggregate name.
   * @returns {generationId, pageId, meta?, text}.
   */
  async getPage(store, pageId) {
    const release = await this.release(store);
    if (!release) {
      fail('KB_RELEASE_MISSING', 409);
    }
    if (['index', 'overview', 'log'].includes(pageId)) {
      const text = await readFile(
        store.path('releases', release.generationId, 'wiki', pageId + '.md'),
        'utf8',
      );
      return { generationId: release.generationId, pageId, text };
    }
    const page = release.pages.find((item) => item.pageId === pageId);
    if (!page) {
      fail('KB_PAGE_MISSING', 404, { pageId });
    }
    return {
      generationId: release.generationId,
      pageId,
      meta: page.meta,
      text: page.text,
      links: page.links,
    };
  }
  /**
   * Keyword search over the published generation.
   * @param store - The owning scope store.
   * @param input - {query, answerableOnly?}.
   * @returns {generationId, hits, neighbors}.
   */
  async search(store, { query, answerableOnly }) {
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) {
      fail('KB_QUERY_INVALID', 400);
    }
    const release = await this.release(store);
    if (!release) {
      return { generationId: null, hits: [], neighbors: [] };
    }
    return {
      generationId: release.generationId,
      ...release.index.search(query, { answerableOnly }),
    };
  }
  /**
   * Build a frozen evidence pack from search hits for writing and context consumers.
   * @param store - The owning scope store.
   * @param input - {query, limit?}; limit caps returned pages.
   * @returns {generationId, pages:[{pageId,title,text,sources}]} pinned to one generation.
   */
  async evidence(store, { query, limit = 4 }) {
    const release = await this.release(store);
    if (!release) {
      return { generationId: null, pages: [] };
    }
    const { hits } = release.index.search(query, { answerableOnly: true });
    const size = Math.min(8, Math.max(1, Number(limit) || 4));
    return {
      generationId: release.generationId,
      pages: hits.slice(0, size).map((hit) => {
        const page = release.pages.find((item) => item.pageId === hit.pageId);
        return {
          pageId: page.pageId,
          title: page.meta.title,
          text: page.text,
          sources: page.meta.sources,
        };
      }),
    };
  }
  /**
   * Answer one question with a controlled model task over frozen evidence.
   * @param store - The owning scope store.
   * @param input - {question, mode?, signal}; mode wiki (default) or raw.
   * @returns {answer, citations, generationId} with validated evidence references.
   */
  async query(store, { question, mode = 'wiki', signal }) {
    this.assertOpen();
    if (typeof question !== 'string' || !question.trim() || question.length > 8000) {
      fail('KB_QUERY_INVALID', 400);
    }
    if (!['wiki', 'raw'].includes(mode)) {
      fail('KB_QUERY_INVALID', 400, { mode });
    }
    const config = await this.configLoader();
    const provider = this.ctx.subagents?.getProvider?.(config.ai?.delegation?.provider || 'spawn');
    if (!provider?.capabilities?.toolFilter || provider.inheritsParentContext !== false) {
      fail('KB_PROVIDER_UNAVAILABLE', 503);
    }
    const release = await this.release(store);
    const rules = await store.rules();
    const documents = [];
    const citable = new Map();
    if (mode === 'wiki') {
      if (!release) {
        fail('KB_RELEASE_MISSING', 409);
      }
      const { hits, neighbors } = release.index.search(question, { answerableOnly: true });
      const selected = [...hits, ...neighbors].slice(0, LIMITS.searchHits);
      if (!selected.length) {
        fail('KB_NO_EVIDENCE', 409, { instruction: 'Import and compile sources first.' });
      }
      for (const hit of selected) {
        const page = release.pages.find((item) => item.pageId === hit.pageId);
        documents.push({
          id: 'wiki:' + page.pageId,
          kind: 'wiki',
          title: page.meta.title,
          body: page.text,
          version: page.hash,
          required: true,
        });
        citable.set('wiki:' + page.pageId, {
          version: page.hash,
          lineCount: page.text.split('\n').length,
        });
      }
      const sourceIds = new Set(selected.flatMap((hit) => hit.sources.map((ref) => ref.id)));
      for (const id of sourceIds) {
        const { source, content } = await getSource(store, id);
        documents.push({
          id: 'source:' + id,
          kind: 'source',
          title: source.title,
          body: content,
          version: source.revision,
          required: false,
        });
        citable.set('source:' + id, {
          version: source.revision,
          lineCount: content.split('\n').length,
        });
      }
    } else {
      const manifest = await store.sources();
      const active = manifest.sources.filter((source) => source.status !== 'excluded');
      const ranked = active
        .map((source) => ({ source, score: rawScore(source, question) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      if (!ranked.length) {
        fail('KB_NO_EVIDENCE', 409);
      }
      for (const { source } of ranked) {
        const { content } = await getSource(store, source.id);
        documents.push({
          id: 'source:' + source.id,
          kind: 'source',
          title: source.title,
          body: content,
          version: source.revision,
          required: true,
        });
        citable.set('source:' + source.id, {
          version: source.revision,
          lineCount: content.split('\n').length,
        });
      }
    }
    const owner = await createWorkspaceTaskAgent(
      this.ctx,
      { id: store.scope.workspaceId, path: store.scope.workspaceRoot },
      signal,
    );
    try {
      const budget = await resolveSyncBudget({
        ctx: this.ctx,
        llm: this.ctx.llm,
        parentAgent: owner.agent,
        signal,
      });
      const result = await runModelStep({
        ctx: this.ctx,
        llm: this.ctx.llm,
        config,
        owner,
        store,
        signal,
        installation: this.installation,
        kind: 'query',
        promptKey: 'kb-query',
        documents,
        instruction: question,
        budget,
        description: 'ReqHub knowledge query',
      });
      const citations = [];
      for (const citation of result.citations) {
        const known = citable.get(citation?.documentId);
        if (
          !known ||
          citation.version !== known.version ||
          !Number.isSafeInteger(citation.startLine) ||
          !Number.isSafeInteger(citation.endLine) ||
          citation.startLine < 1 ||
          citation.endLine < citation.startLine ||
          citation.endLine > known.lineCount
        ) {
          fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'invalid citation', citation });
        }
        citations.push(citation);
      }
      return {
        answer: result.answer,
        citations,
        generationId: release?.generationId || null,
      };
    } finally {
      await owner.dispose();
    }
  }
  /**
   * Structural lint returns findings directly; semantic lint queues a model job.
   * @param store - The owning scope store.
   * @param input - {mode, requestKey?}.
   * @returns {findings} or {job}.
   */
  async lint(store, { mode, requestKey }) {
    this.assertOpen();
    const release = await this.release(store);
    if (!release) {
      fail('KB_RELEASE_MISSING', 409);
    }
    if (mode === 'structural') {
      const pages = [...release.pages];
      const indexText = await readFile(
        store.path('releases', release.generationId, 'wiki', 'index.md'),
        'utf8',
      ).catch(() => null);
      if (indexText !== null) {
        pages.push({
          pageId: 'index',
          meta: { type: 'aggregate', sources: [] },
          body: indexText,
          links: extractWikilinks(indexText),
        });
      }
      return {
        generationId: release.generationId,
        findings: structuralLint({
          pages,
          sourceRevisions: release.manifest.sourceRevisions,
        }),
      };
    }
    if (mode !== 'semantic') {
      fail('KB_LINT_INVALID', 400, { mode });
    }
    const job = await this.createJob(store, {
      kind: 'lint',
      requestKey: requestKey || randomUUID(),
    });
    return { job };
  }
  async runSemanticLint({ store, signal, onStage }) {
    const config = await this.configLoader();
    const provider = this.ctx.subagents?.getProvider?.(config.ai?.delegation?.provider || 'spawn');
    if (!provider?.capabilities?.toolFilter || provider.inheritsParentContext !== false) {
      fail('KB_PROVIDER_UNAVAILABLE', 503);
    }
    onStage?.('reading');
    const release = await this.release(store);
    if (!release) {
      fail('KB_RELEASE_MISSING', 409);
    }
    const pages = release.pages.filter((page) => page.meta.type !== 'source').slice(0, 40);
    if (!pages.length) {
      return { skipped: true, summary: { reason: 'no-generated-pages' } };
    }
    const documents = pages.map((page) => ({
      id: 'wiki:' + page.pageId,
      kind: 'wiki',
      title: page.meta.title,
      body: page.text,
      version: page.hash,
      required: true,
    }));
    const owner = await createWorkspaceTaskAgent(
      this.ctx,
      { id: store.scope.workspaceId, path: store.scope.workspaceRoot },
      signal,
    );
    try {
      const budget = await resolveSyncBudget({
        ctx: this.ctx,
        llm: this.ctx.llm,
        parentAgent: owner.agent,
        signal,
      });
      onStage?.('analyzing');
      const result = await runModelStep({
        ctx: this.ctx,
        llm: this.ctx.llm,
        config,
        owner,
        store,
        signal,
        installation: this.installation,
        kind: 'lint',
        promptKey: 'kb-lint',
        documents,
        instruction: 'Check the frozen Wiki pages for semantic problems. Do not modify pages.',
        budget,
        description: 'ReqHub knowledge semantic lint',
      });
      const known = new Map(pages.map((page) => ['wiki:' + page.pageId, page]));
      for (const finding of result.findings) {
        const page = known.get('wiki:' + finding?.pageId);
        if (!page || typeof finding.reason !== 'string' || !finding.reason.trim()) {
          fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'invalid finding', finding });
        }
        for (const ref of finding.evidence || []) {
          const doc = known.get(ref?.documentId);
          if (
            !doc ||
            ref.version !== doc.hash ||
            !Number.isSafeInteger(ref.startLine) ||
            !Number.isSafeInteger(ref.endLine) ||
            ref.startLine < 1 ||
            ref.endLine < ref.startLine ||
            ref.endLine > doc.text.split('\n').length
          ) {
            fail('KB_MODEL_OUTPUT_INVALID', 400, { reason: 'invalid finding evidence', ref });
          }
        }
      }
      return {
        findings: result.findings,
        summary: { findings: result.findings.length, checkedPages: pages.length },
      };
    } finally {
      await owner.dispose();
    }
  }
  /**
   * Exclude one source and queue a rebuild; user-only authorization happens at the route.
   * @param store - The owning scope store.
   * @param id - Host-generated source ID.
   * @returns {source, job} where job republishes without the excluded source.
   */
  async deleteSource(store, id) {
    this.assertOpen();
    const source = await excludeSource(store, id);
    const manifest = await store.sources();
    const remaining = manifest.sources.filter((item) => item.status !== 'excluded');
    const job = remaining.length ? await this.enqueueCompile(store, 'rebuild') : null;
    if (!remaining.length) {
      await this.clearRelease(store);
    }
    return { source, job };
  }
  /**
   * Save user-maintained rules and queue a rebuild when content exists.
   * @param store - The owning scope store.
   * @param input - {purpose?, schema?, language?}.
   * @returns {rules, job}.
   */
  async saveRules(store, input) {
    this.assertOpen();
    const rules = await store.saveRules(input);
    const manifest = await store.sources();
    const job = manifest.sources.some((source) => source.status !== 'excluded')
      ? await this.enqueueCompile(store, 'rebuild')
      : null;
    return { rules, job };
  }
  async clearRelease(store) {
    await store.run(async () => {
      await writeJsonAtomic(store.path('current.json'), { generationId: null });
      for (const entry of await readdir(store.path('releases'), { withFileTypes: true }).catch(
        () => [],
      )) {
        if (entry.isDirectory()) {
          await rm(join(store.path('releases'), entry.name), { recursive: true, force: true });
        }
      }
    });
    this.indexCache.delete(store.scope.scopeId);
  }
  /**
   * Reset one scope to empty; user-only authorization happens at the route.
   * Cancels active jobs, then clears sources, releases, and rules back to defaults.
   * @param store - The owning scope store.
   * @param expectedEpoch - Epoch precondition observed by the user.
   * @returns Completion after the reset commits.
   */
  async reset(store, expectedEpoch) {
    this.assertOpen();
    const manifest = await store.jobs();
    for (const job of manifest.jobs) {
      if (['queued', 'running', 'cancelling'].includes(job.status)) {
        await this.queue.cancel(store, job.id);
      }
    }
    await store.run(async () => {
      const meta = await store.meta();
      if (meta.epoch !== expectedEpoch) {
        fail('KB_RESET_CONFIRM_REQUIRED', 409, { epoch: meta.epoch });
      }
      meta.epoch += 1;
      await writeJsonAtomic(store.path('scope.json'), meta);
      await writeJsonAtomic(store.path('sources.json'), {
        schemaVersion: SCHEMA_VERSION,
        sources: [],
      });
      await writeJsonAtomic(store.path('current.json'), { generationId: null });
      for (const dir of ['releases', 'staging', join('raw', 'sources')]) {
        for (const entry of await readdir(store.path(dir), { withFileTypes: true }).catch(
          () => [],
        )) {
          await rm(join(store.path(dir), entry.name), { recursive: true, force: true });
        }
      }
    });
    this.indexCache.delete(store.scope.scopeId);
    await store.saveRules({ purpose: null, schema: null, language: 'auto' });
  }
  /** Stop new work and cancel every producer before any asynchronous teardown waits. */
  beginClose() {
    this.closed = true;
    this.sync.beginClose();
    this.queue.beginClose();
  }
  /** Abort all jobs, wait for real completion, then close every store. */
  close() {
    this.closing ||= (async () => {
      this.beginClose();
      try {
        await disposeAll([
          () => this.sync.close(),
          () => this.queue.close(),
          () => this.installation.dispose(),
          () => this.context.close(),
          ...[...this.stores.values()].map((store) => () => store.close()),
        ]);
      } finally {
        this.stores.clear();
        this.indexCache.clear();
      }
    })();
    return this.closing;
  }
}

function rawScore(source, question) {
  const needle = question.toLowerCase();
  const title = source.title.toLowerCase();
  const path = (source.origin.relativePath || '').toLowerCase();
  let score = 0;
  for (const term of needle.split(/\s+/).filter(Boolean)) {
    if (title.includes(term)) {
      score += 2;
    }
    if (path.includes(term)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Create the application facade; wiring owns disposal.
 * @param options - {ctx, registry, profileDir}.
 * @returns The KnowledgeApplication instance.
 */
export function createKnowledgeApplication(options) {
  return new KnowledgeApplication(options);
}

export { listSources, getSource, stateByPath, publicError };
