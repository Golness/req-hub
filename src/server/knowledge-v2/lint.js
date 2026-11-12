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
          reason: '链接目标不存在',
          suggestion: '修正链接或重建相关页面',
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
        reason: '没有其他页面链接到该页',
        suggestion: '在相关页面补充链接',
      });
    }
    if (meta.type !== 'source' && !page.links.length) {
      findings.push({
        kind: 'no_outlink',
        level: 'warning',
        pageId: page.pageId,
        reason: '页面没有出链',
        suggestion: '补充相关页面链接',
      });
    }
    if (meta.type !== 'source' && !meta.sources.length) {
      findings.push({
        kind: 'no_source',
        level: 'error',
        pageId: page.pageId,
        reason: '页面没有来源',
        suggestion: '补充来源或移除该页',
      });
    }
    for (const ref of meta.sources) {
      if (sourceRevisions[ref.id] !== ref.revision) {
        findings.push({
          kind: 'stale_source',
          level: 'error',
          pageId: page.pageId,
          sourceId: ref.id,
          reason: '来源缺失或版本过期',
          suggestion: '重建知识库',
        });
      }
    }
    if (index && !indexed.has(page.pageId)) {
      findings.push({
        kind: 'index_missing',
        level: 'warning',
        pageId: page.pageId,
        reason: '索引未收录该页',
        suggestion: '重建索引',
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
