/** Adapted from dsh-knowledge 2.15.4 (MIT), local-provider.ts. See NOTICE.md. */
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
 * Build an escaped full-text query from user search text.
 * @param text - Source text.
 * @returns The FTS expression.
 */
export function toFtsQuery(text) {
  return text
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(' OR ');
}

/**
 * Extract search terms for the non-FTS fallback.
 * @param text - Source text.
 * @returns Normalized search terms.
 */
export function fallbackTerms(text) {
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
 * Rank a stored document against the supplied query.
 * @param entry - Stored document metadata.
 * @param query - User search text.
 * @returns The relevance score.
 */
export function relevanceScore(entry, query) {
  const normalize = (text) => text.toLowerCase().replace(/\s+/gu, ' ').trim();
  const title = normalize(entry.title);
  const body = normalize(entry.body);
  const tags = normalize(entry.tags.join(' '));
  const combined = `${title}\n${body}\n${tags}`;
  if (combined.includes(normalize(query))) {
    return 0.98;
  }
  const terms = fallbackTerms(query);
  if (!terms.length) {
    return 0.25;
  }
  const coverage = (field) => terms.filter((term) => field.includes(term)).length / terms.length;
  return Math.min(
    0.97,
    0.05 + coverage(combined) * 0.72 + coverage(title) * 0.13 + coverage(tags) * 0.1,
  );
}
