import { estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';

export const DEFAULT_RESULT_CHARS = 8192;

/** Mirror the Host's capacity/compaction formula without importing internal packages. */
export function calculateSyncBudget({ provider, model, contextWindow, maxTokens = 8000, compaction } = {}) {
  if (contextWindow === undefined) return { provider, model, limit: MAX_SYNC_INPUT_TOKENS, source: 'fallback', outputTokens: maxTokens };
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens < 0) throw new Error('SYNC_MODEL_BUDGET_INVALID');
  let capacity = contextWindow - maxTokens;
  let threshold;
  if (compaction?.auto !== false && compaction?.thresholdRatio !== undefined && compaction?.headroomTokens !== undefined) {
    const override = compaction.modelPolicies?.find(policy => policy.provider === provider && policy.model === model);
    threshold = Math.floor(Math.min(contextWindow * (override?.thresholdRatio ?? compaction.thresholdRatio),
      capacity - (override?.headroomTokens ?? compaction.headroomTokens)));
    capacity = Math.min(capacity, threshold);
  }
  // Leave room for estimate error before the Host's automatic lossy compaction.
  const limit = Math.floor(capacity * 0.9);
  if (limit <= 0) throw new Error('SYNC_MODEL_BUDGET_INVALID');
  return { provider, model, contextWindow, outputTokens: maxTokens, compactionThreshold: threshold, limit, source: 'model' };
}

export async function resolveSyncBudget({ ctx, llm, parentAgent, agentOptions = {}, signal, request } = {}) {
  const child = request && ctx?.agents?.get?.(request.sessionId);
  const owner = child?.ctx || parentAgent?.ctx || ctx;
  const inherited = { ...parentAgent?.options };
  const header = parentAgent?.session?.requestHeader?.()?.config;
  // Spawn inherits the durable request route, while retaining configured output options.
  if (header) Object.assign(inherited, { provider: header.provider, model: header.model });
  const route = { ...inherited, ...Object.fromEntries(Object.entries(agentOptions).filter(([, value]) => value !== undefined)), ...request };
  const service = llm || owner?.get?.('llm') || ctx?.get?.('llm');
  const info = route.provider && route.model && service?.resolveModelInfo
    ? await service.resolveModelInfo(route.provider, route.model, signal) : undefined;
  return calculateSyncBudget({ provider: route.provider, model: route.model,
    contextWindow: info?.context?.contextWindow,
    maxTokens: route.maxTokens ?? info?.defaultMaxTokens ?? 8000,
    compaction: owner?.get?.('compaction')?.config });
}

/** Limit the serialized result, including JSON escaping, to the Host's pruning boundary. */
export function syncReadPage(artifactId, text, offset, limit, sha256, thresholdChars = DEFAULT_RESULT_CHARS, decorate = value => value) {
  const cap = Math.min(DEFAULT_RESULT_CHARS, thresholdChars) - 128;
  const result = end => decorate({ artifactId, offset, nextOffset: end, eof: end === text.length, sha256, text: text.slice(offset, end) });
  let low = offset, high = Math.min(text.length, offset + limit), end = offset;
  if (Array.from(JSON.stringify(result(high))).length <= cap) { end = high; low = high + 1; }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Array.from(JSON.stringify(result(middle))).length <= cap) { end = middle; low = middle + 1; }
    else high = middle - 1;
  }
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  if (end === offset && (offset < text.length || Array.from(JSON.stringify(result(end))).length > cap)) throw new Error('SYNC_READ_PAGE_TOO_SMALL');
  return result(end);
}

export function estimateArtifactReadCost(id, text) {
  let offset = 0, total = 0, pages = 0;
  do {
    const page = syncReadPage(id, text, offset, 8000, '0'.repeat(64), DEFAULT_RESULT_CHARS,
      value => ({ ...value, readState: { remaining: 999999, next: { artifactId: id, offset: text.length } } }));
    // Includes the result and the assistant's tool call/arguments on every page.
    total += estimateSubagentInputTokens(JSON.stringify(page)) + 384;
    pages++;
    offset = page.nextOffset;
    if (page.eof) break;
  } while (true);
  return { tokens: total, pages };
}
export function estimateArtifactReadTokens(id, text) { return estimateArtifactReadCost(id, text).tokens; }
