/** Adapted from dsh-knowledge 2.15.4 (MIT), local-provider.ts. See NOTICE.md. */
const STOP_TERMS = new Set(['the', 'and', 'for', 'how', 'what', 'or', 'is', 'of', 'to', '什么', '如何', '怎么', '是否', '帮我', '一下', '请你']);

export function toFtsQuery(text) {
  return text.split(/\s+/u).filter(Boolean).slice(0, 20).map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function fallbackTerms(text) {
  const terms = new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/g) || []);
  for (const sequence of text.match(/\p{Script=Han}+/gu) || []) {
    const chars = [...sequence];
    if (chars.length === 1) terms.add(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i] + chars[i + 1]);
  }
  const candidates = [...terms].filter(term => !STOP_TERMS.has(term));
  if (candidates.length <= 40) return candidates;
  return Array.from({ length: 40 }, (_, i) => candidates[Math.round(i * (candidates.length - 1) / 39)]);
}

export function relevanceScore(entry, query) {
  const normalize = text => text.toLowerCase().replace(/\s+/gu, ' ').trim();
  const title = normalize(entry.title), body = normalize(entry.body), tags = normalize(entry.tags.join(' '));
  const combined = `${title}\n${body}\n${tags}`;
  if (combined.includes(normalize(query))) return .98;
  const terms = fallbackTerms(query);
  if (!terms.length) return .25;
  const coverage = field => terms.filter(term => field.includes(term)).length / terms.length;
  return Math.min(.97, .05 + coverage(combined) * .72 + coverage(title) * .13 + coverage(tags) * .1);
}
