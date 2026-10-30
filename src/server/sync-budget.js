import { estimateSubagentInputTokens, MAX_SYNC_INPUT_TOKENS } from './token-utils.js';

export const DEFAULT_RESULT_CHARS = 8192;

/**
 * Workload backstop, not a replacement for the complete input-token budget.
 * Allow capacity-sized reading rather than forcing every model into 24 pages.
 * 2048 tokens/page deliberately leaves slack for short pages and small artifacts.
 * @param inputLimit - Effective model input-token capacity.
 * @param configured - Explicit read-page limit, when configured.
 * @returns The effective maximum number of evidence pages.
 */
export function analysisReadPageLimit(inputLimit, configured) {
  if (
    configured !== undefined &&
    (!Number.isSafeInteger(configured) || configured < 8 || configured > 128)
  ) {
    throw new Error('SYNC_READ_PAGE_LIMIT_INVALID');
  }
  return configured ?? Math.min(128, Math.max(24, Math.ceil(inputLimit / 2048)));
}

/**
 * Mirror the Host's capacity/compaction formula without importing internal packages.
 * @param [options] - Model context capacity, output reservation and compaction settings.
 * @returns The input budget and its reserved-cost breakdown.
 */
export function calculateSyncBudget({
  provider,
  model,
  contextWindow,
  maxTokens = 8000,
  compaction,
} = {}) {
  if (contextWindow === undefined) {
    return {
      provider,
      model,
      limit: MAX_SYNC_INPUT_TOKENS,
      source: 'fallback',
      outputTokens: maxTokens,
    };
  }
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 0
  ) {
    throw new Error('SYNC_MODEL_BUDGET_INVALID');
  }
  let capacity = contextWindow - maxTokens;
  let threshold;
  if (
    compaction?.auto !== false &&
    compaction?.thresholdRatio !== undefined &&
    compaction?.headroomTokens !== undefined
  ) {
    const override = compaction.modelPolicies?.find(
      (policy) => policy.provider === provider && policy.model === model,
    );
    threshold = Math.floor(
      Math.min(
        contextWindow * (override?.thresholdRatio ?? compaction.thresholdRatio),
        capacity - (override?.headroomTokens ?? compaction.headroomTokens),
      ),
    );
    capacity = Math.min(capacity, threshold);
  }
  // Leave room for estimate error before the Host's automatic lossy compaction.
  const limit = Math.floor(capacity * 0.9);
  if (limit <= 0) {
    throw new Error('SYNC_MODEL_BUDGET_INVALID');
  }
  return {
    provider,
    model,
    contextWindow,
    outputTokens: maxTokens,
    compactionThreshold: threshold,
    limit,
    source: 'model',
  };
}

/**
 * Resolve the delegated model and effective complete-input budget.
 * @param [options] - Host services, parent Agent, model options and cancellation.
 * @returns The model capacity and available analysis budget.
 */
export async function resolveSyncBudget({
  ctx,
  llm,
  parentAgent,
  agentOptions = {},
  signal,
  request,
} = {}) {
  const child = request && ctx?.agents?.get?.(request.sessionId);
  const owner = child?.ctx || parentAgent?.ctx || ctx;
  const inherited = { ...parentAgent?.options };
  const header = parentAgent?.session?.requestHeader?.()?.config;
  // Spawn inherits the durable request route, while retaining configured output options.
  if (header) {
    Object.assign(inherited, { provider: header.provider, model: header.model });
  }
  const route = {
    ...inherited,
    ...Object.fromEntries(Object.entries(agentOptions).filter(([, value]) => value !== undefined)),
    ...request,
  };
  const service = llm || owner?.get?.('llm') || ctx?.get?.('llm');
  const info =
    route.provider && route.model && service?.resolveModelInfo
      ? await service.resolveModelInfo(route.provider, route.model, signal)
      : undefined;
  return calculateSyncBudget({
    provider: route.provider,
    model: route.model,
    contextWindow: info?.context?.contextWindow,
    maxTokens: route.maxTokens ?? info?.defaultMaxTokens ?? 8000,
    compaction: owner?.get?.('compaction')?.config,
  });
}

/**
 * Limit the serialized result, including JSON escaping, to the Host's pruning boundary.
 * @param artifactId - Server-owned evidence artifact identity.
 * @param text - Source text.
 * @param offset - Exact continuation offset into the artifact.
 * @param limit - Requested page size within the result budget.
 * @param sha256 - Expected frozen artifact hash.
 * @param [thresholdChars] - Maximum serialized result length.
 * @param [decorate] - Callback adding metadata before the complete-result size check.
 * @returns One page with exact continuation and end-of-file metadata.
 */
export function syncReadPage(
  artifactId,
  text,
  offset,
  limit,
  sha256,
  thresholdChars = DEFAULT_RESULT_CHARS,
  decorate = (value) => value,
) {
  const cap = Math.min(DEFAULT_RESULT_CHARS, thresholdChars) - 128;
  const result = (end) =>
    decorate({
      artifactId,
      offset,
      nextOffset: end,
      eof: end === text.length,
      sha256,
      text: text.slice(offset, end),
    });
  let low = offset;
  let high = Math.min(text.length, offset + limit);
  let end = offset;
  if (Array.from(JSON.stringify(result(high))).length <= cap) {
    end = high;
    low = high + 1;
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Array.from(JSON.stringify(result(middle))).length <= cap) {
      end = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) {
    end--;
  }
  if (
    end === offset &&
    (offset < text.length || Array.from(JSON.stringify(result(end))).length > cap)
  ) {
    throw new Error('SYNC_READ_PAGE_TOO_SMALL');
  }
  return result(end);
}

/**
 * Measure paged evidence including its result wrappers.
 * @param id - Identity resolved within the supplied scope.
 * @param text - Source text.
 * @returns The read workload and token estimate.
 */
export function estimateArtifactReadCost(id, text) {
  let offset = 0;
  let total = 0;
  let pages = 0;
  do {
    const page = syncReadPage(
      id,
      text,
      offset,
      8000,
      '0'.repeat(64),
      DEFAULT_RESULT_CHARS,
      (value) => ({
        ...value,
        readState: { remaining: 999999, next: { artifactId: id, offset: text.length } },
      }),
    );
    // Includes the result and the assistant's tool call/arguments on every page.
    total += estimateSubagentInputTokens(JSON.stringify(page)) + 384;
    pages++;
    offset = page.nextOffset;
    if (page.eof) {
      break;
    }
  } while (true);
  return { tokens: total, pages };
}
/**
 * Estimate tokens for complete paged artifact reads.
 * @param id - Identity resolved within the supplied scope.
 * @param text - Source text.
 * @returns The estimated read-result tokens.
 */
export function estimateArtifactReadTokens(id, text) {
  return estimateArtifactReadCost(id, text).tokens;
}
