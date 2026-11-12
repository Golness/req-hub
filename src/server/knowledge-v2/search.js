/** Keyword scoring adapted from dsh-knowledge 2.15.4 (MIT), vendored here by ReqHub. */
import { LIMITS } from './contracts.js';
import { isAnswerable } from './lint.js';

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

/**
 * English words plus Han bigrams for the in-memory keyword index.
 * @param text - Source text.
 * @returns Normalized search terms.
 */
export function searchTerms(text) {
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

/**
 * Rank one indexed entry against a query; exact phrases win.
 * @param entry - {title, body, tags}.
 * @param query - User search text.
 * @returns The relevance score.
 */
export function scoreEntry(entry, query) {
  const normalize = (text) => text.toLowerCase().replace(/\s+/gu, ' ').trim();
  const title = normalize(entry.title);
  const body = normalize(entry.body);
  const tags = normalize((entry.tags || []).join(' '));
  const combined = `${title}\n${body}\n${tags}`;
  const phrase = normalize(query);
  if (phrase && combined.includes(phrase)) {
    return 0.98;
  }
  const terms = searchTerms(query);
  if (!terms.length) {
    return 0.25;
  }
  const coverage = (field) => terms.filter((term) => field.includes(term)).length / terms.length;
  return Math.min(
    0.97,
    0.05 + coverage(combined) * 0.72 + coverage(title) * 0.13 + coverage(tags) * 0.1,
  );
}

/** In-memory index over one published generation; discardable and rebuildable. */
export class WikiSearchIndex {
  /**
   * @param input - {generationId, pages, sourceRevisions}; parsed release pages.
   */
  constructor({ generationId, pages, sourceRevisions }) {
    this.generationId = generationId;
    this.sourceRevisions = sourceRevisions;
    this.entries = pages
      .filter((page) => !['index', 'log'].includes(page.pageId))
      .map((page) => ({
        pageId: page.pageId,
        title: page.meta.title,
        type: page.meta.type,
        body: page.body,
        links: page.links.map((link) => link.split('|')[0]),
        sources: page.meta.sources,
        answerable: isAnswerable(page, sourceRevisions),
        tags: [page.meta.type],
      }));
    this.byId = new Map(this.entries.map((entry) => [entry.pageId, entry]));
  }
  /**
   * Top hits plus one-hop link neighbors, stable sorted.
   * @param query - User search text.
   * @param [options] - {answerableOnly} for question evidence selection.
   * @returns {hits, neighbors} with page metadata and snippets.
   */
  search(query, { answerableOnly = false } = {}) {
    const scored = this.entries
      .filter((entry) => !answerableOnly || entry.answerable)
      .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .filter((item) => item.score > 0.25)
      .sort((a, b) => b.score - a.score || a.entry.pageId.localeCompare(b.entry.pageId));
    const hits = scored.slice(0, LIMITS.searchHits).map(({ entry, score }) => ({
      pageId: entry.pageId,
      title: entry.title,
      type: entry.type,
      score,
      snippet: entry.body.slice(0, 240),
      sources: entry.sources,
      answerable: entry.answerable,
    }));
    const hitIds = new Set(hits.map((hit) => hit.pageId));
    const neighbors = [];
    for (const hit of hits) {
      for (const target of this.byId.get(hit.pageId)?.links || []) {
        const entry = this.byId.get(target);
        if (!entry || hitIds.has(target) || neighbors.some((item) => item.pageId === target)) {
          continue;
        }
        if (answerableOnly && !entry.answerable) {
          continue;
        }
        neighbors.push({
          pageId: entry.pageId,
          title: entry.title,
          type: entry.type,
          score: 0.2,
          snippet: entry.body.slice(0, 240),
          sources: entry.sources,
          answerable: entry.answerable,
        });
        if (neighbors.length >= LIMITS.searchNeighbors) {
          return { hits, neighbors };
        }
      }
    }
    return { hits, neighbors };
  }
}

/**
 * Deterministic related-page selection for compile preparation.
 * @param pages - Parsed current staging pages.
 * @param query - Source title plus lead text.
 * @returns Up to four relevant pages, best first.
 */
export function selectRelatedPages(pages, query) {
  return pages
    .filter((page) => page.meta.type !== 'source')
    .map((page) => ({
      page,
      score: scoreEntry({ title: page.meta.title, body: page.body, tags: [] }, query),
    }))
    .filter((item) => item.score > 0.3)
    .sort((a, b) => b.score - a.score || a.page.pageId.localeCompare(b.page.pageId))
    .slice(0, 4)
    .map((item) => item.page);
}
