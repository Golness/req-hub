import { fail } from './contracts.js';

/**
 * Resolve exact user-selected document versions from authorized V2 scopes.
 * @param knowledge - V2 read-only knowledge context.
 * @param refs - Exact {scopeId, documentId, version} references.
 * @param signal - Owning request or task cancellation signal.
 * @returns Frozen documents with their authorized origins.
 */
export async function resolveKnowledgeReferences(knowledge, refs = [], signal) {
  if (!Array.isArray(refs) || refs.length > 30) {
    fail('ENHANCEMENT_INVALID_INPUT');
  }
  const origins = await knowledge.catalog();
  const result = [];
  const seen = new Set();
  for (const ref of refs) {
    signal?.throwIfAborted();
    const documentId = ref?.documentId || ref?.id;
    if (
      !ref ||
      typeof ref.scopeId !== 'string' ||
      typeof documentId !== 'string' ||
      !Number.isSafeInteger(ref.version) ||
      seen.has(documentId)
    ) {
      fail('ENHANCEMENT_INVALID_INPUT');
    }
    seen.add(documentId);
    const origin = origins.find((item) => item.id === ref.scopeId);
    const scope = origin && (await knowledge.scope(origin.workspace_id));
    if (!scope || scope.identity !== ref.scopeId) {
      fail('ENHANCEMENT_SCOPE_DENIED', 403);
    }
    await knowledge.refreshSources(scope);
    const doc = scope.store.entry(documentId);
    if (
      !doc ||
      doc.version !== ref.version ||
      doc.sources.some((source) => source.status !== 'active')
    ) {
      const reason = !doc
        ? 'missing'
        : doc.version !== ref.version
          ? 'version_changed'
          : 'source_changed';
      fail('ENHANCEMENT_INPUT_CHANGED', 409, {
        documentId,
        scopeId: ref.scopeId,
        workspaceTitle: origin.workspace_title,
        expectedVersion: ref.version,
        actualVersion: doc?.version ?? null,
        reason,
        sources:
          doc?.sources.map(({ relativePath, status }) => ({ relativePath, status })) || [],
      });
    }
    const { versions, ...snapshot } = doc;
    result.push({ doc: { ...snapshot, scopeId: ref.scopeId }, origin });
  }
  return result;
}

/**
 * Freeze a bounded read-only context for a technical-design sync task.
 * @param knowledge - V2 read-only knowledge context.
 * @param scopeIds - Explicitly selected scope identities.
 * @param query - User search text.
 * @param signal - Owning task cancellation signal.
 * @param referenceRefs - Exact references selected in the UI.
 * @returns Frozen documents and source revisions; no current session is consulted.
 */
export async function freezeKnowledgeContext(
  knowledge,
  scopeIds = [],
  query = '',
  signal,
  referenceRefs = [],
) {
  if (!Array.isArray(scopeIds) || !Array.isArray(referenceRefs)) {
    fail('ENHANCEMENT_INVALID_INPUT');
  }
  // A sync without a selected knowledge scope must not require a knowledge
  // service; the frozen context is simply empty.
  if (!scopeIds.length && !referenceRefs.length) {
    return { documents: [], sources: [] };
  }
  if (
    !knowledge ||
    scopeIds.length > 30 ||
    typeof query !== 'string' ||
    query.length > 1000
  ) {
    fail('ENHANCEMENT_INVALID_INPUT');
  }
  const documents = [];
  const sources = [];
  const ids = new Set();
  let bytes = 0;
  const append = (doc, scopeId) => {
    if (!doc || ids.has(doc.id) || documents.length >= 30) {
      return;
    }
    if (doc.sources.some((source) => source.status !== 'active')) {
      fail('ENHANCEMENT_INPUT_CHANGED', 409);
    }
    const body = String(doc.body || '');
    if (bytes + Buffer.byteLength(body) > 2000000) {
      fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
    }
    ids.add(doc.id);
    bytes += Buffer.byteLength(body);
    documents.push({
      id: doc.id,
      scopeId,
      version: doc.version,
      title: doc.title,
      body,
      kind: doc.kind,
      sources: doc.sources,
      linkedSourceIds: doc.linkedSourceIds || [],
    });
    sources.push({
      scopeId,
      documentId: doc.id,
      version: doc.version,
      sourceHash: doc.sources[0]?.sourceHash || null,
    });
  };
  for (const { doc } of await resolveKnowledgeReferences(knowledge, referenceRefs, signal)) {
    append(doc, doc.scopeId);
  }
  const origins = await knowledge.catalog();
  for (const id of [...new Set(scopeIds)]) {
    signal?.throwIfAborted();
    const origin = origins.find((item) => item.id === id);
    const scope = origin && (await knowledge.scope(origin.workspace_id));
    if (!scope || scope.identity !== id) {
      fail('ENHANCEMENT_SCOPE_DENIED', 403);
    }
    await knowledge.refreshSources(scope);
    for (const hit of scope.store.search(query, 3).hits) {
      append(scope.store.entry(hit.id), scope.identity);
    }
  }
  return { documents, sources };
}
