import { estimateArtifactReadTokens } from '../../sync-budget.js';
import { fail } from './contracts.js';

/** Resolve selected scopes before retrieval; never search the global index and filter afterwards. */
export async function resolveKnowledgeReferences(knowledge, refs = [], signal) {
  if (!Array.isArray(refs) || refs.length > 30) fail('ENHANCEMENT_INVALID_INPUT');
  const result = [], seen = new Set();
  for (const ref of refs) {
    signal?.throwIfAborted();
    if (!ref || typeof ref.id !== 'string' || typeof ref.scopeId !== 'string' || !Number.isSafeInteger(ref.version)) fail('ENHANCEMENT_INVALID_INPUT');
    if (seen.has(ref.id)) fail('ENHANCEMENT_INVALID_INPUT'); seen.add(ref.id);
    const origin = knowledge.database().scopes().find(scope => scope.id === ref.scopeId);
    if (!origin) fail('ENHANCEMENT_SCOPE_DENIED', 403);
    const scope = await knowledge.scope(origin.workspace_id);
    if (scope.identity !== ref.scopeId) fail('ENHANCEMENT_SCOPE_DENIED', 403);
    await knowledge.refreshSources(scope);
    const doc = scope.store.entry(ref.id);
    if (!doc || doc.version !== ref.version || doc.sources.some(source => source.status !== 'active')) fail('ENHANCEMENT_INPUT_CHANGED', 409, {
      documentId: ref.id, scopeId: ref.scopeId, workspaceTitle: origin.workspace_title,
      expectedVersion: ref.version, actualVersion: doc?.version ?? null,
      reason: !doc ? 'missing' : doc.version !== ref.version ? 'version_changed' : 'source_changed',
      sources: doc?.sources.map(({ relativePath, status }) => ({ relativePath, status })) || [],
    });
    const { versions, ...snapshot } = doc;
    result.push({ origin, doc: { ...snapshot, scopeId: ref.scopeId } });
  }
  return result;
}
export async function freezeKnowledgeContext(knowledge, scopeIds = [], query, signal, referenceRefs = []) {
  if (Array.isArray(scopeIds) && !scopeIds.length && Array.isArray(referenceRefs) && !referenceRefs.length) return [];
  if (!knowledge || !Array.isArray(scopeIds) || scopeIds.length > 10 || scopeIds.some(id => typeof id !== 'string') || typeof query !== 'string' || query.length > 500) fail('ENHANCEMENT_INVALID_INPUT');
  const documents = [], seen = new Set(); let tokens = 0;
  const append = (doc, id) => {
    if (seen.has(doc.id)) return; seen.add(doc.id);
    const artifactId = 'knowledge.' + documents.length;
    const text = JSON.stringify({ documentId: doc.id, scopeId: id, version: doc.version, sources: doc.sources, body: doc.body });
    tokens += estimateArtifactReadTokens(artifactId, text);
    if (tokens > 7000) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
    documents.push({ id: artifactId, text, documentId: doc.id, scopeId: id, version: doc.version, sourceHash: doc.sources[0].sourceHash });
  };
  for (const { doc } of await resolveKnowledgeReferences(knowledge, referenceRefs, signal)) append(doc, doc.scopeId);
  for (const id of [...new Set(scopeIds)]) {
    signal?.throwIfAborted(); const origin = knowledge.database().scopes().find(scope => scope.id === id);
    if (!origin) fail('ENHANCEMENT_SCOPE_DENIED', 403);
    const scope = await knowledge.scope(origin.workspace_id);
    if (scope.identity !== id) fail('ENHANCEMENT_SCOPE_DENIED', 403);
    await knowledge.refreshSources(scope);
    for (const hit of scope.store.search(query, 3).hits) {
      const doc = scope.store.entry(hit.id);
      if (!doc || doc.sources.some(source => source.status !== 'active')) fail('ENHANCEMENT_INPUT_CHANGED', 409);
      append(doc, id);
    }
  }
  return documents;
}
