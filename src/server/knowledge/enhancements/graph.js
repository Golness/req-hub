import { fromMarkdown } from 'mdast-util-from-markdown';
import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, fail, bounded } from './contracts.js';

const walk = (node, visit) => { visit(node); for (const child of node.children || []) walk(child, visit); };
const source = entry => entry.sources[0];
export const requirementKey = entry => source(entry).relativePath.split('/').slice(0, 2).join('/');
const clean = value => value.replaceAll('\\', '/').replace(/#.*$/, '').replace(/:\d+(?::\d+)?$/, '');
export function buildGraph(documents, scopeId, settings) {
  const entities = [], references = [], relations = [], unresolved = [];
  const byKey = new Map(), links = new Map();
  for (const doc of documents.filter(doc => doc.type === 'document')) {
    const key = requirementKey(doc);
    if (!byKey.has(key)) { const entity = { id: digest([scopeId, key]), key, name: key.split('/').at(-1), documents: [] }; entities.push(entity); byKey.set(key, entity); }
    byKey.get(key).documents.push({ id: doc.id, version: doc.version, path: source(doc).relativePath });
    links.set(source(doc).relativePath, byKey.get(key));
  }
  const add = (a, b, type, evidence) => {
    if (a.id === b.id) return;
    const key = digest([scopeId, a.key, b.key, type]);
    let relation = relations.find(item => item.key === key);
    if (!relation) { relation = { id: key, key, sourceId: a.id, targetId: b.id, type, validity: 'valid', evidence: [], reviewState: 'candidate' }; relations.push(relation); }
    if (relations.length > settings.maxEdges || relation.evidence.length >= 100) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
    relation.evidence.push(evidence);
  };
  for (const doc of documents.filter(doc => doc.type === 'document')) {
    const origin = byKey.get(requirementKey(doc));
    const tree = fromMarkdown(doc.body);
    const candidates = [];
    walk(tree, node => {
      if (node.type === 'link' || node.type === 'definition') candidates.push({ path: node.url, line: node.position.start.line, kind: 'link' });
      if (['inlineCode', 'code'].includes(node.type)) {
        for (const match of (node.value || '').matchAll(/(?:[\p{L}\p{N}_.@ -]+\/)+[\p{L}\p{N}_. -]+\.(?:[cm]?[jt]sx?|java|py|go|rs|vue|cs|cpp|h|md|html?)(?::\d+)?/gu)) candidates.push({ path: match[0].trim(), line: node.position.start.line, kind: node.type === 'code' ? 'example' : 'mention' });
      }
    });
    if (candidates.length > settings.maxEdges) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
    for (const item of candidates) {
      if (references.length + unresolved.length > settings.maxEdges) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
      if (typeof item.path !== 'string' || /^[a-z]+:/i.test(item.path) || item.path.startsWith('/')) continue;
      let path; try { path = clean(decodeURIComponent(item.path)); } catch { continue; }
      const relative = posix.normalize(posix.join(posix.dirname(source(doc).relativePath), path));
      const target = links.get(relative) || links.get(path) || byKey.get(path.replace(/\/$/, ''));
      const evidence = { documentId: doc.id, version: doc.version, sourceHash: source(doc).sourceHash, line: item.line, text: item.path };
      if (target) {
        const line = doc.body.split('\n')[item.line - 1] || '';
        if (!/(?:不再|无需|不|取消)依赖|示例|尚待/.test(line) && /依赖|前置|先完成/.test(line) && item.kind !== 'example') add(origin, target, 'explicit_dependency', evidence);
        else unresolved.push({ ...evidence, reason: 'reference_only', targetId: target.id });
      } else if (!/\.(md|html?)$/i.test(path)) references.push({ id: digest([doc.id, item.line, path]), entityId: origin.id, path: clean(path), kind: item.kind, ...evidence });
      else unresolved.push({ ...evidence, reason: 'unresolved' });
    }
  }
  const graph = { id: randomUUID(), scopeId, createdAt: new Date().toISOString(), documents: documents.map(doc => ({ id: doc.id, version: doc.version, hash: source(doc).sourceHash })), entities, references, relations, unresolved, code: { status: 'disabled' } };
  for (const relation of relations) relation.basisHash = digest(relation.evidence);
  if (entities.length > settings.maxNodes || relations.length > settings.maxEdges) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
  return bounded(graph, settings.maxResultBytes);
}
export function impact(graph, input, settings) {
  if (!graph.entities.some(entity => entity.id === input.entityId)) fail('ENHANCEMENT_REFERENCE_INVALID', 422);
  const depth = Number(input.depth || 2), nodes = Number(input.maxNodes || settings.maxNodes), edges = Number(input.maxEdges || settings.maxEdges);
  if (![depth, nodes, edges].every(Number.isSafeInteger) || depth < 1 || depth > settings.maxDepth || nodes < 1 || nodes > settings.maxNodes || edges < 1 || edges > settings.maxEdges || !['dependencies', 'dependents'].includes(input.direction || 'dependents')) fail('ENHANCEMENT_INVALID_INPUT');
  if (input.mode && !['business', 'related'].includes(input.mode)) fail('ENHANCEMENT_INVALID_INPUT');
  const related = input.mode === 'related';
  const usable = graph.relations.filter(r => r.validity === 'valid' && r.reviewState !== 'rejected' && (related ? true : r.reviewState === 'confirmed' && r.type !== 'code_related'));
  const visited = new Set([input.entityId]), queue = [{ id: input.entityId, depth: 0, path: [] }], results = [], frontier = [];
  let count = 0, reason = null;
  const started = Date.now();
  for (let head = 0; head < queue.length; head++) {
    if (Date.now() - started > 1000) { reason = 'timeout'; break; }
    const item = queue[head];
    if (item.depth >= depth) { frontier.push(item.id); reason ||= 'maxDepth'; continue; }
    for (const relation of usable.filter(r => (input.direction === 'dependencies' ? r.sourceId : r.targetId) === item.id)) {
      if (++count > edges) { reason = 'maxEdges'; break; }
      const id = input.direction === 'dependencies' ? relation.targetId : relation.sourceId;
      if (visited.has(id)) continue;
      if (visited.size >= nodes) { reason = 'maxNodes'; break; }
      visited.add(id); const next = { id, depth: item.depth + 1, path: [...item.path, relation.id] }; queue.push(next); results.push(next);
    }
    if (reason && reason !== 'maxDepth') { frontier.push(item.id, ...queue.slice(head + 1).map(n => n.id)); break; }
  }
  return bounded({ revision: graph.id, reviewSeq: graph.reviewSeq, results, truncated: !!reason, limitReason: reason, frontier: frontier.slice(0, 20) }, settings.maxResultBytes);
}
