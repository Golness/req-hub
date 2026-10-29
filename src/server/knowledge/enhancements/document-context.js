import { normalizeSourcePath } from '../source-reader.js';
import { buildGraph, impact } from './graph.js';
import { bounded, digest, fail } from './contracts.js';

const active = doc => doc?.type === 'document' && doc.sources.every(source => source.status === 'active');
export function contextPath(value) {
  try { return normalizeSourcePath(value); } catch { fail('ENHANCEMENT_SCOPE_DENIED', 403); }
}
/** Cheap, lazy document associations. No model, MCP call or native indexing on reads. */
export async function documentContext(service, scope, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('ENHANCEMENT_INVALID_INPUT');
  if (input.documentId !== undefined && (typeof input.documentId !== 'string' || !input.documentId || input.documentId.length > 200) || input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 500)) fail('ENHANCEMENT_INVALID_INPUT');
  const settings = await service.settings();
  service.database().scope(scope.identity);
  await service.knowledge.refreshSources(scope);
  const path = input.path ? contextPath(input.path) : null;
  const requirementPath = input.requirementPath ? contextPath(input.requirementPath + '/draft.md').slice(0, -'/draft.md'.length) : null;
  const current = input.documentId ? scope.store.entry(input.documentId) : path ? scope.store.entryByPath(path) : null;
  if (input.documentId && (!current || current.type !== 'document')) fail('ENHANCEMENT_REFERENCE_INVALID', 404);
  const rows = scope.store.activeDocumentMetadata(settings.maxNodes + 1);
  const limited = rows.length > settings.maxNodes;
  const metadata = rows;
  let graph = await service.graph(scope, {}), graphError;
  if (settings.enabled && !limited) {
    const docs = metadata.map(row => { const { versions, ...doc } = scope.store.entry(row.id); return { ...doc, scopeId: scope.identity }; });
    const basis = docs.map(doc => ({ id: doc.id, version: doc.version, hash: doc.sources[0].sourceHash }));
    if (!graph || digest(graph.documents) !== digest(basis)) {
      try {
        bounded(docs, settings.maxInputBytes);
        graph = service.database().publish(scope.identity, buildGraph(docs, scope.identity, settings), settings);
      } catch (error) {
        if (error.message !== 'ENHANCEMENT_BUDGET_EXCEEDED') throw error;
        graphError = error.message;
      }
    }
  }
  const currentDocs = current ? [current] : requirementPath ? scope.store.entriesInRequirement(requirementPath, settings.maxDocuments + 1) : [];
  if (currentDocs.length > settings.maxDocuments) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
  const refs = currentDocs.filter(active).map(doc => ({ id: doc.id, scopeId: scope.identity, version: doc.version }));
  const entityIds = new Set((graph?.entities || []).filter(entity => entity.documents.some(doc => currentDocs.some(current => current.id === doc.id))).map(entity => entity.id));
  const relations = (graph?.relations || []).filter(relation => entityIds.has(relation.sourceId) || entityIds.has(relation.targetId));
  const related = new Map();
  const add = (id, reason, relation) => {
    const doc = scope.store.entry(id); if (!active(doc) || currentDocs.some(current => current.id === id)) return;
    const item = related.get(id) || { id, scopeId: scope.identity, workspaceId: scope.workspaceId, version: doc.version, title: doc.title, path: doc.sources[0].relativePath, reasons: [], confirmed: false };
    if (!item.reasons.includes(reason)) item.reasons.push(reason);
    if (relation?.reviewState === 'confirmed' && relation.type !== 'code_related' && relation.validity === 'valid' && !graph?.stale) item.confirmed = true;
    related.set(id, item);
  };
  for (const entity of graph?.entities || []) {
    if (entityIds.has(entity.id)) for (const doc of entity.documents) add(doc.id, 'same_requirement');
    for (const relation of relations.filter(item => item.reviewState !== 'rejected' && [item.sourceId, item.targetId].includes(entity.id))) {
      if (!entityIds.has(entity.id)) for (const doc of entity.documents) add(doc.id, relation.type, relation);
    }
    if ((graph?.unresolved || []).some(item => currentDocs.some(doc => doc.id === item.documentId) && item.targetId === entity.id)) for (const doc of entity.documents) add(doc.id, 'reference');
  }
  let impactLimited = false;
  if (graph && !graph.stale) for (const entityId of entityIds) {
    const affected = impact(graph, { entityId, direction: 'dependents', depth: Math.min(2, settings.maxDepth) }, settings);
    impactLimited ||= affected.truncated;
    for (const item of affected.results) for (const doc of graph.entities.find(entity => entity.id === item.id)?.documents || []) add(doc.id, 'business_impact', { reviewState: 'confirmed', type: 'explicit_dependency', validity: 'valid' });
  }
  const query = input.query || requirementPath?.split('/').at(-1) || '';
  if (typeof query !== 'string' || query.length > 500) fail('ENHANCEMENT_INVALID_INPUT');
  if (query) for (const hit of scope.store.search(query, 5).hits) add(hit.id, 'text_match');
  return bounded({ enabled: settings.enabled, scopeId: scope.identity, indexed: !!current && active(current), documentRefs: refs,
    limits: { maxDepth: settings.maxDepth },
    jobs: service.database().summaries(scope.identity, 20).filter(job => currentDocs.some(doc => job.contextDocIds?.includes(doc.id)) || requirementPath && job.contextRequirement === requirementPath),
    documents: currentDocs.map(doc => ({ id: doc.id, version: doc.version, title: doc.title, path: doc.sources[0].relativePath })),
    related: [...related.values()], graph: graph ? { ...graph, relations } : null,
    limited: limited || !!graphError, impactLimited, graphError }, settings.maxResultBytes);
}
