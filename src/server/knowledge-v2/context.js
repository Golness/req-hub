import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, fail, pageType } from './contracts.js';
import { sourceIsStale } from './source-repository.js';

const STOP_TERMS = new Set([
  'the',
  'and',
  'for',
  'how',
  'what',
  'or',
  'is',
  'of',
  'to',
  '什么',
  '如何',
  '怎么',
  '是否',
  '帮我',
  '一下',
  '请你',
]);

/** Extract bounded search terms, including Chinese bigrams. */
export function fallbackTerms(text) {
  const terms = new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) || []);
  for (const sequence of text.match(/\p{Script=Han}+/gu) || []) {
    const chars = [...sequence];
    if (chars.length === 1) {
      terms.add(chars[0]);
    }
    for (let i = 0; i < chars.length - 1; i++) {
      terms.add(chars[i] + chars[i + 1]);
    }
  }
  const candidates = [...terms].filter((term) => !STOP_TERMS.has(term));
  if (candidates.length <= 40) {
    return candidates;
  }
  return Array.from(
    { length: 40 },
    (_, i) => candidates[Math.round((i * (candidates.length - 1)) / 39)],
  );
}

/** Rank a document against user search text using the legacy-compatible score range. */
export function relevanceScore(entry, query) {
  const normalize = (text) =>
    String(text || '')
      .toLowerCase()
      .replace(/\s+/gu, ' ')
      .trim();
  const title = normalize(entry.title);
  const body = normalize(entry.body);
  const tags = normalize((entry.tags || []).join(' '));
  const combined = `${title}\n${body}\n${tags}`;
  if (normalize(query) && combined.includes(normalize(query))) {
    return 0.98;
  }
  const terms = fallbackTerms(query);
  if (!terms.length) {
    return 0.25;
  }
  const coverage = (field) => terms.filter((term) => field.includes(term)).length / terms.length;
  return Math.min(
    0.97,
    0.05 + coverage(combined) * 0.72 + coverage(title) * 0.13 + coverage(tags) * 0.1,
  );
}

const revisionNumber = (revision) => Number(String(revision).replace(/^rev-/, ''));
const versionNumber = (value) => parseInt(digest(value).slice(0, 12), 16);
const normalizePath = (value) => String(value || '').replaceAll('\\', '/');

/** Synchronous read-only projection over immutable V2 snapshots and the current release. */
export class KnowledgeContextStore {
  constructor(scope, manifest, release, rules, staleIds = new Set()) {
    this.scope = scope;
    this.manifest = manifest;
    this.release = release;
    this.rules = rules;
    this.staleIds = staleIds;
  }

  sourceRecord(id) {
    return this.manifest.sources.find((source) => source.id === id && source.status !== 'excluded');
  }

  sourceRef(record) {
    return {
      scopeId: this.scope.scopeId,
      documentId: record.id,
      snapshotId: record.id,
      version: revisionNumber(record.revision),
      revision: record.revision,
      path: record.origin.relativePath,
      relativePath: record.origin.relativePath || 'sessions/' + record.origin.sessionId + '.md',
      sourceHash: record.rawHash,
      status: this.staleIds.has(record.id)
        ? 'stale'
        : record.status === 'excluded'
          ? 'excluded'
          : 'active',
      workspaceTitle: this.scope.workspace.title,
      title: record.title,
    };
  }

  sourceEntry(record) {
    if (!record) {
      return null;
    }
    let body;
    try {
      body = readFileSync(this.storePath(record.contentPath), 'utf8');
    } catch {
      return null;
    }
    const source = this.sourceRef(record);
    return {
      id: record.id,
      scopeId: this.scope.scopeId,
      workspaceId: this.scope.workspaceId,
      title: record.title,
      path: source.relativePath,
      version: source.version,
      revision: record.revision,
      kind: 'source',
      type: 'document',
      tags: [record.kind],
      body,
      sources: [source],
      versions: [],
    };
  }

  wikiIsCurrent() {
    return Boolean(this.release && this.release.manifest.rulesHash === this.rules.rulesHash);
  }

  wikiEntry(page) {
    if (!this.wikiIsCurrent()) {
      return null;
    }
    const linked = [];
    const evidence = [];
    for (const ref of page.meta.sources || []) {
      const record = this.sourceRecord(ref.id);
      const publishedRevision = this.release.manifest.sourceRevisions?.[ref.id];
      if (
        !record ||
        this.staleIds.has(ref.id) ||
        record.revision !== ref.revision ||
        publishedRevision !== ref.revision
      ) {
        return null;
      }
      const source = this.sourceRef(record);
      linked.push(record.id);
      evidence.push(source);
    }
    const source = evidence[0] || {
      scopeId: this.scope.scopeId,
      relativePath: 'wiki/' + page.pageId + '.md',
      workspaceTitle: this.scope.workspace.title,
      status: 'active',
    };
    return {
      id: 'wiki:' + page.pageId,
      pageId: page.pageId,
      scopeId: this.scope.scopeId,
      title: page.meta.title,
      path: source.relativePath,
      version: versionNumber([this.release.generationId, page.pageId, page.hash]),
      ruleVersion: versionNumber(this.rules.rulesHash),
      generationId: this.release.generationId,
      kind: 'wiki',
      type: 'wiki',
      tags: [page.meta.type || pageType(page.pageId)],
      body: page.body,
      linkedSourceIds: linked,
      evidence,
      sources: [source],
      versions: [],
    };
  }

  storePath(path) {
    return join(this.scope.dir, ...String(path).split('/'));
  }

  entry(id) {
    if (String(id).startsWith('wiki:')) {
      const pageId = String(id).slice(5);
      const page = this.release?.pages.find((item) => item.pageId === pageId);
      return page ? this.wikiEntry(page) : null;
    }
    return this.sourceEntry(this.sourceRecord(id));
  }

  entryByPath(path) {
    const normalized = normalizePath(path);
    const record = this.manifest.sources.find(
      (source) =>
        source.status !== 'excluded' && normalizePath(source.origin.relativePath) === normalized,
    );
    return this.sourceEntry(record);
  }

  activeDocumentMetadata(limit = 1000) {
    return this.manifest.sources
      .filter((source) => source.status !== 'excluded')
      .slice(0, limit)
      .map((record) => {
        const source = this.sourceRef(record);
        return {
          id: record.id,
          scopeId: this.scope.scopeId,
          title: record.title,
          path: source.relativePath,
          version: source.version,
          revision: record.revision,
          tags: [record.kind],
          sources: [source],
        };
      });
  }

  entriesInRequirement(prefix, limit = 1000) {
    const base = normalizePath(prefix).replace(/\/$/, '') + '/';
    return this.manifest.sources
      .filter(
        (source) =>
          source.status !== 'excluded' &&
          normalizePath(source.origin.relativePath).startsWith(base),
      )
      .slice(0, limit)
      .map((record) => this.sourceEntry(record))
      .filter(Boolean);
  }

  listMetadata(limit = 51, cursor = 0, query = '') {
    const needle = query.toLowerCase();
    return this.activeDocumentMetadata(10000)
      .filter(
        (entry) =>
          !needle ||
          entry.title.toLowerCase().includes(needle) ||
          entry.path.toLowerCase().includes(needle),
      )
      .slice(cursor, cursor + limit);
  }

  search(query, limit = 8) {
    const entries = this.manifest.sources
      .filter((source) => source.status !== 'excluded')
      .map((record) => this.sourceEntry(record))
      .filter(Boolean);
    if (this.release && this.wikiIsCurrent()) {
      entries.push(...this.release.pages.map((page) => this.wikiEntry(page)).filter(Boolean));
    }
    return {
      hits: entries
        .map((entry) => ({ entry, score: relevanceScore(entry, query) }))
        .filter(({ score }) => !String(query || '').trim() || score > 0.05)
        .sort(
          (left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id),
        )
        .slice(0, limit)
        .map(({ entry, score }) => ({
          id: entry.id,
          title: entry.title,
          version: entry.version,
          score,
          snippet: entry.body.slice(0, 240),
          sources: entry.sources,
        })),
    };
  }

  sources() {
    return this.manifest.sources.map((record) => ({
      id: record.id,
      path: record.origin.relativePath,
      relativePath: record.origin.relativePath,
      status: this.staleIds.has(record.id) ? 'stale' : 'active',
      version: revisionNumber(record.revision),
      revision: record.revision,
      sourceHash: record.rawHash,
    }));
  }

  status() {
    return {
      documentCount: this.manifest.sources.length,
      activeCount: this.manifest.sources.filter((source) => source.status !== 'excluded').length,
      wikiPageCount: this.release?.pages.length || 0,
      generationId: this.release?.generationId || null,
    };
  }
}

function originFor(scope) {
  return {
    id: scope.scopeId,
    workspace_id: scope.workspaceId,
    workspace_title: scope.workspace.title,
    workspace_root: scope.workspaceRoot,
    docs_root: scope.docsRoot,
  };
}

/** Minimal read-only knowledge facade used by writing, sync and enhancement services. */
export class KnowledgeContext {
  constructor(application) {
    this.application = application;
    this.registry = application.registry;
    this.databasePath = join(application.root, 'context');
    this.scopes = new Map();
  }

  /** Drop cached read-only projections when the owning application closes. */
  close() {
    this.scopes.clear();
  }

  async createScope(store, staleIds = new Set()) {
    const [manifest, release, rules] = await Promise.all([
      store.sources(),
      this.application.release(store),
      store.rules(),
    ]);
    const wrapper = {
      identity: store.scope.scopeId,
      workspaceId: store.scope.workspaceId,
      workspace: store.scope.workspace,
      docsRoot: store.scope.docsRoot,
      origin: originFor(store.scope),
      store: null,
    };
    wrapper.store = new KnowledgeContextStore(store.scope, manifest, release, rules, staleIds);
    wrapper.store.backend = store;
    return wrapper;
  }

  async scope(workspaceId) {
    const store = await this.application.scope(workspaceId);
    const cached = this.scopes.get(store.scope.scopeId);
    if (cached) {
      return cached;
    }
    const scope = await this.createScope(store);
    this.scopes.set(scope.identity, scope);
    return scope;
  }

  async refreshSources(scope) {
    const store = await this.application.scope(scope.workspaceId);
    if (store.scope.scopeId !== scope.identity) {
      fail('WRITING_SCOPE_DENIED', 403);
    }
    const manifest = await store.sources();
    const staleIds = new Set();
    for (const source of manifest.sources) {
      if (source.status !== 'excluded' && (await sourceIsStale(store, source))) {
        staleIds.add(source.id);
      }
    }
    const refreshed = await this.createScope(store, staleIds);
    scope.store = refreshed.store;
    scope.workspace = refreshed.workspace;
    scope.docsRoot = refreshed.docsRoot;
    scope.origin = refreshed.origin;
    return scope;
  }

  async catalog() {
    const result = [];
    for (const workspace of this.registry.list()) {
      try {
        result.push((await this.scope(workspace.id)).origin);
      } catch {
        // An invalid workspace is not exposed as a readable knowledge scope.
      }
    }
    return result;
  }
}
