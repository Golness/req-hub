import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readSyncEvents } = require('../../src/client/utils/syncEvents.js');
function stream(parts) { return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } }); }
it('delivers a final error event without a trailing newline and handles fragmented transport', async () => {
  const events = [];
  await readSyncEvents(stream(['data: {"type":"sync_started","syncId":"t"}\r\n\r\n', 'data: {"type":"err', 'or","error":"执行失败"}']), async event => events.push(event));
  expect(events.map(e => e.type)).toEqual(['sync_started', 'error']); expect(events[1].error).toBe('执行失败');
});
it('propagates business handler errors instead of swallowing them as parse errors', async () => {
  await expect(readSyncEvents(stream(['data: {"type":"error"}\n']), () => { throw new Error('BUSINESS_FAILURE'); })).rejects.toThrow('BUSINESS_FAILURE');
});
it('reports malformed JSON separately from business failures', async () => {
  await expect(readSyncEvents(stream(['data: {invalid}\n']), () => {})).rejects.toThrow('同步事件格式错误');
});
