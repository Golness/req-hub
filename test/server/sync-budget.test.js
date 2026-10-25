import { describe, it, expect } from 'vitest';
import { calculateSyncBudget, resolveSyncBudget, syncReadPage, estimateArtifactReadTokens } from '../../src/server/sync-budget.js';
import { estimateTextTokens, estimateSubagentInputTokens, estimateMessageTokens } from '../../src/server/token-utils.js';

describe('sync estimates and effective Host capacity', () => {
  it('uses one multilingual token estimate rather than UTF-8 byte counts', () => {
    expect(estimateSubagentInputTokens('x'.repeat(9000))).toBe(3008);
    expect(estimateSubagentInputTokens('中文'.repeat(1000))).toBe(4008);
    expect(estimateMessageTokens({ content: '中文' })).toBe(estimateTextTokens('中文') + 4);
    expect(estimateSubagentInputTokens('中文')).toBeLessThan(Buffer.byteLength('中文') + 8);
  });
  it('scales both below and above the fallback limit and reserves actual completion tokens', () => {
    expect(calculateSyncBudget().limit).toBe(150000);
    expect(calculateSyncBudget({ contextWindow: 64000, maxTokens: 8000 }).limit).toBe(50400);
    expect(calculateSyncBudget({ contextWindow: 256000, maxTokens: 16000 }).limit).toBe(216000);
    expect(() => calculateSyncBudget({ contextWindow: 8000, maxTokens: 8000 })).toThrow('INVALID');
  });
  it('stays below DSH automatic compaction pressure with exact model overrides', () => {
    const compaction = { thresholdRatio: 0.8, headroomTokens: 65536,
      modelPolicies: [{ provider: 'p', model: 'large', headroomTokens: 16384 }] };
    const budget = calculateSyncBudget({ provider: 'p', model: 'small', contextWindow: 128000, compaction });
    expect(budget.compactionThreshold).toBe(54464);
    expect(budget.limit).toBe(49017);
    expect(calculateSyncBudget({ provider: 'p', model: 'large', contextWindow: 128000, compaction }).limit).toBe(92160);
  });
  it('resolves the configured child route and later checks the actual routed child scope', async () => {
    const requests = [];
    const llm = { async resolveModelInfo(provider, model) { requests.push([provider, model]); return { context: { contextWindow: model === 'configured' ? 256000 : 128000 } }; } };
    const parentAgent = { options: { provider: 'p', model: 'parent', maxTokens: 8000 } };
    const ctx = { get: name => name === 'llm' ? llm : undefined,
      agents: { get: () => ({ ctx: { get: name => name === 'compaction' ? { config: { thresholdRatio: 0.8, headroomTokens: 65536 } } : undefined } }) } };
    expect((await resolveSyncBudget({ ctx, parentAgent, agentOptions: { model: 'configured' } })).limit).toBe(223200);
    const actual = await resolveSyncBudget({ ctx, parentAgent, request: { sessionId: 'child', provider: 'q', model: 'routed', maxTokens: 4000 } });
    expect(actual.compactionThreshold).toBe(58464);
    expect(actual.outputTokens).toBe(4000);
    expect(requests).toEqual([['p', 'configured'], ['q', 'routed']]);
  });
  it('pages escaped JSON and Unicode without exceeding DSH pruning limits or losing text', () => {
    const text = ('"\\\n\t中文' + String.fromCodePoint(0x20000)).repeat(2500);
    const pages = []; let offset = 0;
    do {
      const page = syncReadPage('evidence', text, offset, 8000, '0'.repeat(64), 4096);
      expect(Array.from(JSON.stringify(page)).length).toBeLessThan(4096);
      expect(page.nextOffset).toBeGreaterThan(offset);
      expect(page.text.endsWith('\uD840')).toBe(false);
      pages.push(page.text); offset = page.nextOffset;
      if (page.eof) break;
    } while (true);
    expect(pages.join('')).toBe(text);
    expect(estimateArtifactReadTokens('evidence', text)).toBeGreaterThan(estimateTextTokens(text));
    expect(() => syncReadPage('evidence', text, 0, 8000, '0'.repeat(64), 100)).toThrow('TOO_SMALL');
  });
});
