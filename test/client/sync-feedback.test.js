import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { syncActivityText, syncErrorText } = require('../../src/client/utils/syncFeedback.js');
const zh = require('../../src/client/locales/zh.js');

it.each([
  'SYNC_RETRY_INVALID',
  'SYNC_RETRY_NODE_INVALID',
  'SYNC_RETRY_INPUT_CHANGED',
  'SYNC_USER_CANCELLED',
])('localizes %s and preserves the failed node', (code) => {
  const label = zh[`sync.error.${code}`];
  expect(label).toBeTypeOf('string');
  expect(syncErrorText(`${code}: code-0`)).toBe(`${label}: code-0`);
});

it('retains diagnostics when a recognized Host error has no installed translation', () => {
  const key = 'sync.error.SYNC_RETRY_INPUT_CHANGED';
  const previous = zh[key];
  try {
    delete zh[key];
    expect(syncErrorText('SYNC_RETRY_INPUT_CHANGED: code-0')).toBe(
      'SYNC_RETRY_INPUT_CHANGED: code-0',
    );
  } finally {
    zh[key] = previous;
  }
});

it('describes real preparation counts and preserves provider diagnostics while deduplicating errors', () => {
  expect(syncActivityText({ stage: 'sources', current: 12, total: 40 })).toBe(
    '正在冻结代码文件… (12/40)',
  );
  const text = syncErrorText('EXECUTION_ERROR: Model offline；EXECUTION_ERROR: Model offline');
  expect(text).toBe('子代理执行出错: Model offline');
  expect(syncErrorText('MAX_TOKENS_REACHED')).toBe('子代理达到输出长度限制');
  expect(syncErrorText('SYNC_SUBAGENT_FAILED')).not.toContain('SYNC_SUBAGENT_FAILED');
  expect(
    syncErrorText(
      'EVIDENCE_NOT_FULLY_READ: code.0.diff; nextOffset=8000; totalChars=16000; remaining=2. Continue req_hub_sync_read at this exact offset; no output has been written by this call.',
    ),
  ).toBe('子代理未完整读取必读证据：code.0.diff（读取位置 8000/16000，尚有 2 项未完成）');
});
