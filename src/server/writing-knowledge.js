const knowledgeError = (code, status = 400) => Object.assign(new Error(code), { status });

/**
 * Freeze one V2 scope with Wiki pages preferred over raw-source fallback.
 * @param knowledge - V2 read-only knowledge context.
 * @param scope - Resolved authorized context scope.
 * @param origin - Persisted provenance for the selected scope.
 * @param selectedScopeIds - Scope identities authorized for this task.
 * @returns Bounded frozen documents for the writing runtime.
 */
export function freezeWritingKnowledge(knowledge, scope, origin, selectedScopeIds = [origin.id]) {
  if (!selectedScopeIds.includes(origin.id) || scope.identity !== origin.id) {
    throw knowledgeError('WRITING_SCOPE_DENIED', 403);
  }
  const metadata = scope.store.activeDocumentMetadata(10001);
  if (metadata.length > 10000) {
    throw knowledgeError('WRITING_KNOWLEDGE_BUDGET', 413);
  }
  const documents = metadata
    .map((item) => scope.store.entry(item.id))
    .filter(
      (doc) => doc && doc.sources.every((source) => source.status === 'active'),
    )
    .map((doc) => ({ ...doc, scopeId: origin.id, kind: 'source' }));
  const pages = (scope.store.release?.pages || [])
    .map((page) => scope.store.wikiEntry(page))
    .filter(Boolean)
    .map((doc) => ({ ...doc, scopeId: origin.id, kind: 'wiki' }));
  for (const doc of documents) {
    doc.wikiFallback = pages.length === 0;
  }
  if (pages.length) {
    documents.push(...pages, {
      id: 'wiki-index:' + origin.id,
      kind: 'index',
      tags: [],
      scopeId: origin.id,
      title: origin.workspace_title,
      version: pages[0].ruleVersion,
      generationId: scope.store.release.generationId,
      sources: [],
      body: JSON.stringify({
        scopeId: origin.id,
        generationId: scope.store.release.generationId,
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
 * Verify that every frozen Wiki citation still belongs to the current V2 release.
 * @param knowledge - V2 read-only knowledge context.
 * @param evidence - Frozen evidence returned by the writing runtime.
 * @param selectedScopeIds - Scope identities authorized for this task.
 * @returns Resolves after generation, page, rule and source revisions pass validation.
 */
export async function verifyWritingWiki(
  knowledge,
  evidence,
  selectedScopeIds = evidence.map((ref) => ref.scopeId),
) {
  const allowed = new Set(selectedScopeIds);
  const origins = await knowledge.catalog();
  const scopes = new Map();
  for (const id of allowed) {
    const origin = origins.find((item) => item.id === id);
    const scope = origin && (await knowledge.scope(origin.workspace_id));
    if (!scope || scope.identity !== id) {
      throw knowledgeError('WRITING_SCOPE_DENIED', 403);
    }
    await knowledge.refreshSources(scope);
    scopes.set(id, scope);
  }
  for (const ref of evidence.filter((item) => item.kind === 'wiki')) {
    const scope = scopes.get(ref.scopeId);
    if (!scope || !allowed.has(ref.scopeId)) {
      throw knowledgeError('WRITING_SCOPE_DENIED', 403);
    }
    const current = scope.store.entry(ref.id || 'wiki:' + ref.pageId);
    if (
      !current ||
      current.pageId !== ref.pageId ||
      current.version !== ref.version ||
      current.ruleVersion !== ref.ruleVersion ||
      current.generationId !== ref.generationId
    ) {
      throw knowledgeError('WRITING_KNOWLEDGE_STALE', 409);
    }
  }
}
