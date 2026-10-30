import { knowledgeError } from './knowledge/source-reader.js';

function pageIsCurrent(database, scopeId, page, allowedScopes, visiting = new Set()) {
  if (visiting.size >= 30) {
    throw knowledgeError('WRITING_KNOWLEDGE_BUDGET', 413);
  }
  if (
    page.status !== 'ready' ||
    page.revision.ruleVersion !== database.rules(scopeId).version ||
    visiting.has(page.id)
  ) {
    return false;
  }
  const next = new Set(visiting).add(page.id);
  return page.revision.evidence.every((ref) => {
    const row = database.db
      .prepare('SELECT payload FROM knowledge_source_snapshots WHERE scope_id=? AND id=?')
      .get(scopeId, ref.snapshotId);
    if (!row) {
      return false;
    }
    const snapshot = JSON.parse(row.payload);
    // Unselected origins cannot validate current claims for this writing scope.
    const sourceScope = snapshot.scopeId || scopeId;
    if (!allowedScopes.has(sourceScope)) {
      return false;
    }
    if (snapshot.kind === 'wiki') {
      const upstream = database.page(sourceScope, snapshot.pageId);
      return (
        upstream.version === ref.version &&
        pageIsCurrent(database, sourceScope, upstream, allowedScopes, next)
      );
    }
    const source = database.db
      .prepare(
        'SELECT d.version,s.status FROM documents d JOIN sources s ON s.scope_id=d.scope_id AND s.path=d.path WHERE d.scope_id=? AND d.id=?',
      )
      .get(sourceScope, ref.documentId);
    return source?.status === 'active' && source.version === ref.version;
  });
}

/**
 * Freeze the Wiki catalog and its authorized source versions for one scope.
 * @param knowledge - The shared knowledge service.
 * @param scope - The resolved, authorized scope.
 * @param origin - Persisted provenance for the selected scope.
 * @param [selectedScopeIds] - Explicitly selected origins available to this task.
 * @returns Frozen documents. Source fallback applies only when no valid Wiki page exists.
 */
export function freezeWritingKnowledge(knowledge, scope, origin, selectedScopeIds = [origin.id]) {
  const sources = scope.store.list(10001, undefined, { activeOnly: true });
  const database = knowledge.wiki?.database();
  const rows = database?.pages(origin.id, '', 10001).items || [];
  if (sources.length > 10000 || rows.length > 10000) {
    throw knowledgeError('WRITING_KNOWLEDGE_BUDGET', 413);
  }
  const rules = database?.rules(origin.id);
  const pages = rows
    .filter((row) => row.status === 'ready')
    .map((row) => {
      const page = database.page(origin.id, row.id);
      if (!pageIsCurrent(database, origin.id, page, new Set(selectedScopeIds))) {
        return null;
      }
      const linkedSources = [];
      const provenance = [];
      for (const ref of page.revision.evidence) {
        const saved = database.db
          .prepare('SELECT payload FROM knowledge_source_snapshots WHERE scope_id=? AND id=?')
          .get(origin.id, ref.snapshotId);
        if (!saved) {
          return null;
        }
        const snapshot = JSON.parse(saved.payload);
        provenance.push({ ...ref, scopeId: snapshot.scopeId, title: snapshot.title });
        if (snapshot.kind !== 'wiki' && selectedScopeIds.includes(snapshot.scopeId || origin.id)) {
          linkedSources.push(ref.documentId);
        }
      }
      return {
        id: 'wiki:' + page.id,
        pageId: page.id,
        kind: 'wiki',
        tags: [page.page_type],
        scopeId: origin.id,
        title: page.title,
        version: page.version,
        ruleVersion: rules.version,
        body: page.body,
        linkedSourceIds: linkedSources,
        evidence: provenance,
        sources: [
          { relativePath: 'wiki/' + page.slug + '.md', workspaceTitle: origin.workspace_title },
        ],
      };
    })
    .filter(Boolean);
  const documents = sources.map((doc) => ({
    ...doc,
    scopeId: origin.id,
    kind: 'source',
    wikiFallback: !pages.length,
  }));
  if (pages.length) {
    documents.push(...pages, {
      id: 'wiki-index:' + origin.id,
      kind: 'index',
      tags: [],
      scopeId: origin.id,
      title: origin.workspace_title,
      version: rules.version,
      sources: [],
      body: JSON.stringify({
        scopeId: origin.id,
        pages: pages.map(({ id, title, version, body }) => ({
          id,
          title,
          version,
          summary: body.slice(0, 160),
        })),
      }),
    });
  }
  if (Buffer.byteLength(JSON.stringify(documents)) > 20000000) {
    throw knowledgeError('WRITING_KNOWLEDGE_BUDGET', 413);
  }
  return documents;
}

/**
 * Reject a Wiki citation after a page, rule, or source status changes.
 * @param knowledge - The shared knowledge service.
 * @param evidence - Frozen evidence returned by the owned writing runtime.
 * @param [selectedScopeIds] - Authorized origins whose current sources must be checked.
 * @returns Resolves after current source and Wiki versions pass validation.
 */
export async function verifyWritingWiki(
  knowledge,
  evidence,
  selectedScopeIds = evidence.map((ref) => ref.scopeId),
) {
  const allowed = new Set(selectedScopeIds);
  for (const id of allowed) {
    const origin = knowledge
      .database()
      .scopes()
      .find((item) => item.id === id);
    const scope = origin && (await knowledge.scope(origin.workspace_id));
    if (!scope || scope.identity !== id) {
      throw knowledgeError('WRITING_SCOPE_DENIED', 403);
    }
    await knowledge.refreshSources(scope);
  }
  for (const ref of evidence.filter((item) => item.kind === 'wiki')) {
    const origin = knowledge
      .database()
      .scopes()
      .find((item) => item.id === ref.scopeId);
    const scope = origin && (await knowledge.scope(origin.workspace_id));
    if (!scope || scope.identity !== ref.scopeId) {
      throw knowledgeError('WRITING_SCOPE_DENIED', 403);
    }
    await knowledge.refreshSources(scope);
    const database = knowledge.wiki.database();
    const page = database.page(ref.scopeId, ref.pageId);
    if (
      page.status !== 'ready' ||
      page.version !== ref.version ||
      database.rules(ref.scopeId).version !== ref.ruleVersion ||
      !pageIsCurrent(database, ref.scopeId, page, allowed)
    ) {
      throw knowledgeError('WRITING_KNOWLEDGE_STALE', 409);
    }
  }
}
