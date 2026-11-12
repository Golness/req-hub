import { estimateArtifactReadTokens } from '../../sync-budget.js';
import {
  freezeKnowledgeContext as freezeV2KnowledgeContext,
  resolveKnowledgeReferences as resolveV2KnowledgeReferences,
} from '../../knowledge-v2/reference-context.js';
import { fail } from './contracts.js';

/**
 * Resolve exact V2 references for enhancement jobs.
 * @param knowledge - V2 read-only knowledge context.
 * @param refs - Exact {id|documentId, scopeId, version} references.
 * @param signal - Owning task cancellation signal.
 * @returns Frozen documents and their authorized origins.
 */
export async function resolveKnowledgeReferences(knowledge, refs = [], signal) {
  return resolveV2KnowledgeReferences(knowledge, refs, signal);
}

/**
 * Freeze V2 documents into the bounded artifact shape consumed by enhancement workers.
 * @param knowledge - V2 read-only knowledge context.
 * @param scopeIds - Explicitly selected scope identities.
 * @param query - Retrieval query.
 * @param signal - Owning task cancellation signal.
 * @param referenceRefs - Additional exact-version references.
 * @returns Versioned read-only artifacts; no session or current-page state is consulted.
 */
export async function freezeKnowledgeContext(
  knowledge,
  scopeIds = [],
  query = '',
  signal,
  referenceRefs = [],
) {
  if (!scopeIds.length && !referenceRefs.length) {
    return [];
  }
  if (
    !knowledge ||
    !Array.isArray(scopeIds) ||
    scopeIds.length > 10 ||
    scopeIds.some((id) => typeof id !== 'string') ||
    typeof query !== 'string' ||
    query.length > 500
  ) {
    fail('ENHANCEMENT_INVALID_INPUT');
  }
  const frozen = await freezeV2KnowledgeContext(
    knowledge,
    scopeIds,
    query,
    signal,
    referenceRefs,
  );
  const documents = [];
  const seen = new Set();
  let tokens = 0;
  for (const doc of frozen.documents) {
    if (seen.has(doc.id)) {
      continue;
    }
    seen.add(doc.id);
    const artifactId = 'knowledge.' + documents.length;
    const text = JSON.stringify({
      documentId: doc.id,
      scopeId: doc.scopeId,
      version: doc.version,
      sources: doc.sources,
      body: doc.body,
    });
    tokens += estimateArtifactReadTokens(artifactId, text);
    if (tokens > 7000) {
      fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
    }
    documents.push({
      id: artifactId,
      text,
      documentId: doc.id,
      scopeId: doc.scopeId,
      version: doc.version,
      sourceHash: doc.sources[0]?.sourceHash || null,
    });
  }
  return documents;
}
