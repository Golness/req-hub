import { expect, it } from 'vitest';
import general from '../../src/shared/general.cjs';
import { limits } from '../../src/server/knowledge/enhancements/contracts.js';

it('uses shared enhancement budgets and defaults without feature overrides', () => {
  const config = {
    general: {
      taskTimeoutMs: 45000,
      knowledgeMaxInputBytes: 8000,
      knowledgeMaxResultBytes: 3000,
    },
    knowledgeV2: { timeoutMs: 1, maxInputBytes: 1, maxResultBytes: 1 },
    enhancements: { timeoutMs: 2, maxInputBytes: 2, maxResultBytes: 2 },
  };
  expect(limits(config)).toMatchObject({
    timeoutMs: 45000,
    maxInputBytes: 8000,
    maxResultBytes: 3000,
  });
  expect(limits({})).toMatchObject({
    timeoutMs: 1200000,
    maxInputBytes: 2000000,
    maxResultBytes: 250000,
  });
});

it('removes former overrides without migrating them or changing unrelated policies', () => {
  const config = {
    knowledgeV2: { timeoutMs: 1, maxInputBytes: 1, autoManage: true },
    enhancements: { maxResultBytes: 1, indexTimeoutMs: 60000 },
    ai: { delegation: { timeout: 1, provider: 'spawn' } },
    sync: { dailyUpdateTime: '03:00' },
  };
  expect(general.withoutIndependentSettings(config)).toEqual({
    knowledgeV2: { autoManage: true },
    enhancements: { indexTimeoutMs: 60000 },
    ai: { delegation: { provider: 'spawn' } },
    sync: { dailyUpdateTime: '03:00' },
  });
  expect(config.knowledgeV2.timeoutMs).toBe(1);
});
