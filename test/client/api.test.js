import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const api = require('../../src/client/api/index.js');

afterEach(() => vi.unstubAllGlobals());
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const stream = (text) =>
  new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(text);
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });

it('encodes identity and resource parameters and rejects undeclared or escaping URLs', async () => {
  expect(api.endpoint('read', { workspaceId: 'a&b', path: '订单/a.md' })).toBe(
    '/req-hub/read?workspaceId=a%26b&path=%E8%AE%A2%E5%8D%95%2Fa.md',
  );
  expect(api.endpoint('writingAssets', { workspaceId: 'w' }, 'a.png')).toBe(
    '/req-hub/writing/assets/a.png?workspaceId=w',
  );
  expect(
    api.endpoint(
      'knowledge-v2',
      { workspaceId: 'current' },
      '/sources?workspaceId=stale&offset=20',
    ),
  ).toBe('/req-hub/knowledge-v2/sources?workspaceId=current&offset=20');
  for (const url of [
    'https://example.com',
    '/req-hub/unknown',
    '/req-hub/writing/../config',
    '/req-hub/writing/%2e%2e/config',
  ]) {
    await expect(api.request(url)).rejects.toMatchObject({ code: 'API_ENDPOINT_INVALID' });
  }
});

it('preserves structured errors and failed job data without retrying writes', async () => {
  const fetch = vi.fn(async () =>
    json(
      {
        error: {
          code: 'CONFIG_CONFLICT',
          params: { field: 'a' },
          details: { revision: 2 },
          retryable: false,
        },
      },
      409,
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    api.requestJson(api.endpoint('config'), { json: { workspaceId: 'ws' } }),
  ).rejects.toMatchObject({
    code: 'CONFIG_CONFLICT',
    status: 409,
    details: { revision: 2 },
    params: { field: 'a' },
    retryable: false,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"workspaceId":"ws"}' });
  const job = { status: 'failed', error: 'JOB_FAILED' };
  fetch.mockResolvedValueOnce(json(job));
  expect(await api.requestJson(api.endpoint('task-reports'))).toBe(job);
});

it('does not send pre-cancelled requests and rejects results cancelled during JSON decoding', async () => {
  const controller = new AbortController();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  controller.abort();
  await expect(
    api.requestJson(api.endpoint('config'), { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
  const next = new AbortController();
  fetch.mockResolvedValue({
    ok: true,
    json: async () => {
      next.abort();
      return {};
    },
  });
  await expect(
    api.requestJson(api.endpoint('config'), { signal: next.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

it('preserves complete multibyte stream records and an unterminated final result', async () => {
  const events = [];
  await api.readSyncEvents(stream('data: {"title":"订单"}\r\n\r\ndata: {"type":"done"}'), (value) =>
    events.push(value),
  );
  expect(events).toEqual([{ title: '订单' }, { type: 'done' }]);
  const progress = vi.fn();
  expect(
    await api.readConversationResponse(
      {
        ok: true,
        headers: { get: () => 'application/x-ndjson' },
        body: stream(
          '{"type":"progress","completed":1}\n{"type":"result","result":{"title":"订单"}}',
        ),
      },
      progress,
    ),
  ).toEqual({ title: '订单' });
  expect(progress).toHaveBeenCalledWith({ type: 'progress', completed: 1 });
});

it('waits for source cancellation and releases the reader after callback failure', async () => {
  let finish;
  const cancelled = new Promise((resolve) => {
    finish = resolve;
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {}\n'));
    },
    cancel() {
      return cancelled;
    },
  });
  let settled = false;
  const reading = api.readSyncEvents(body, () => {
    throw Error('CALLBACK_FAILURE');
  });
  reading.catch(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(body.locked).toBe(true);
  finish();
  await expect(reading).rejects.toThrow('CALLBACK_FAILURE');
  expect(body.locked).toBe(false);
});

it('cancels a blocked reader and rejects oversized UTF-8 records instead of truncating', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  const controller = new AbortController();
  const reading = api.readLines(body, () => {}, { signal: controller.signal });
  controller.abort();
  await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  await expect(api.readLines(stream('订单'), () => {}, { maxLineBytes: 5 })).rejects.toMatchObject({
    code: 'API_STREAM_TOO_LARGE',
  });
});
