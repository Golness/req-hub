import { extractWikilinks } from './contracts.js';

const AGGREGATE_TYPES = new Set(['source', 'topic']);

/**
 * Deterministic structural checks over one published generation.
 * @param input - {pages, sourceRevisions}; pages from readStagingPages or a release.
 * @returns Findings with kind, level, pageId and a stable reason.
 */
export function structuralLint({ pages, sourceRevisions }) {
  const findings = [];
  const byId = new Map(pages.map((page) => [page.pageId, page]));
  const linked = new Set();
  for (const page of pages) {
    for (const target of page.links) {
      const id = target.split('|')[0];
      linked.add(id);
      if (!byId.has(id) && !['overview', 'index', 'log'].includes(id)) {
        findings.push({
          kind: 'broken_link',
          level: 'error',
          pageId: page.pageId,
          target: id,
          reason: 'KB_LINT_LINK_TARGET_MISSING',
          suggestion: 'KB_LINT_FIX_LINK_TARGET',
        });
      }
    }
  }
  const index = pages.find((page) => page.pageId === 'index');
  const indexed = new Set(
    index ? extractWikilinks(index.body).map((link) => link.split('|')[0]) : [],
  );
  for (const page of pages) {
    const { meta } = page;
    if (!AGGREGATE_TYPES.has(meta.type) && !linked.has(page.pageId)) {
      findings.push({
        kind: 'orphan',
        level: 'warning',
        pageId: page.pageId,
        reason: 'KB_LINT_NO_INBOUND_LINKS',
        suggestion: 'KB_LINT_ADD_INBOUND_LINKS',
      });
    }
    if (meta.type !== 'source' && !page.links.length) {
      findings.push({
        kind: 'no_outlink',
        level: 'warning',
        pageId: page.pageId,
        reason: 'KB_LINT_NO_OUTBOUND_LINKS',
        suggestion: 'KB_LINT_ADD_OUTBOUND_LINKS',
      });
    }
    if (meta.type !== 'source' && !meta.sources.length) {
      findings.push({
        kind: 'no_source',
        level: 'error',
        pageId: page.pageId,
        reason: 'KB_LINT_NO_SOURCES',
        suggestion: 'KB_LINT_ADD_SOURCE_OR_REMOVE',
      });
    }
    for (const ref of meta.sources) {
      if (sourceRevisions[ref.id] !== ref.revision) {
        findings.push({
          kind: 'stale_source',
          level: 'error',
          pageId: page.pageId,
          sourceId: ref.id,
          reason: 'KB_LINT_SOURCE_OUTDATED',
          suggestion: 'KB_LINT_REBUILD_KB',
        });
      }
    }
    if (index && !indexed.has(page.pageId)) {
      findings.push({
        kind: 'index_missing',
        level: 'warning',
        pageId: page.pageId,
        reason: 'KB_LINT_PAGE_NOT_INDEXED',
        suggestion: 'KB_LINT_REBUILD_INDEX',
      });
    }
  }
  return findings;
}

/** Pages with missing or stale sources must not enter the answer evidence set. */
export function isAnswerable(page, sourceRevisions) {
  return (
    page.meta.sources.length > 0 &&
    page.meta.sources.every((ref) => sourceRevisions[ref.id] === ref.revision)
  );
}
