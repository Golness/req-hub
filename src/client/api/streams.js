'use strict';
const { request, readJson, ApiError } = require('./transport.js');
// Resolve presentation copy only while consuming a stream: locale settings also use this API.
const clientError = (...args) => require('../utils/serverMessage.js').clientError(...args);
const t = (...args) => require('../locale.js').t(...args);

/**
 * Decode complete UTF-8 lines with bounded buffering and caller-owned cancellation.
 * @param body - ReadableStream returned by the Host.
 * @param consume - Awaited callback for each complete line, including the final partial line.
 * @param options - Optional signal and maximum buffered line bytes.
 * @returns Completion after the reader is cancelled or reaches EOF and its lock is released.
 */
async function readLines(body, consume, { signal, maxLineBytes = 8 * 1024 * 1024 } = {}) {
  if (!body) {
    throw new ApiError('API_STREAM_MISSING');
  }
  signal?.throwIfAborted();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let cancellation;
  const cancel = (reason) => {
    cancellation ||= reader.cancel(reason).catch(() => {
      // Preserve the original failure when an already disconnected source rejects cancellation.
    });
    return cancellation;
  };
  const abort = () => {
    void cancel(signal.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  let pending = '';
  let complete = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      pending += decoder.decode(value, { stream: !done });
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        if (encoder.encode(line).byteLength > maxLineBytes) {
          throw new ApiError('API_STREAM_TOO_LARGE');
        }
        pending = pending.slice(index + 1);
        await consume(line);
        signal?.throwIfAborted();
      }
      if (encoder.encode(pending).byteLength > maxLineBytes) {
        throw new ApiError('API_STREAM_TOO_LARGE');
      }
      if (done) {
        if (pending) {
          await consume(pending.replace(/\r$/, ''));
        }
        signal?.throwIfAborted();
        complete = true;
        break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete) {
      await cancel(signal?.reason);
    }
    reader.releaseLock();
  }
}

/**
 * Consume ReqHub's single-JSON-data-line SSE protocol without swallowing callback failures.
 * @param body - Host progress stream.
 * @param onEvent - Awaited progress callback.
 * @param options - Caller-owned signal and line budget.
 * @returns Completion after all events and reader cleanup.
 */
async function readSyncEvents(body, onEvent, options) {
  if (!body) {
    throw new Error(t('syncEvents.message001'));
  }
  return readLines(
    body,
    async (line) => {
      if (!line.startsWith('data:')) {
        return;
      }
      let event;
      try {
        event = JSON.parse(line.slice(5).trimStart());
      } catch (cause) {
        const error = new ApiError('API_RESPONSE_INVALID', { cause });
        error.message = t('syncEvents.message002');
        throw error;
      }
      await onEvent(event);
    },
    options,
  );
}

/**
 * Consume the shared conversation JSON/NDJSON protocol, keeping progress and terminal data distinct.
 * @param response - Host response, including JSON preflight errors.
 * @param onProgress - Callback for complete progress records.
 * @param options - Caller cancellation and buffered-line budget.
 * @returns The complete final result; missing results and stream errors reject.
 */
async function readConversationResponse(response, onProgress, options) {
  if (!response.ok || !response.headers?.get('content-type')?.includes('application/x-ndjson')) {
    const data = await readJson(response, options?.signal);
    if (data.error) {
      throw clientError(data.error, t('common.loadFailed'));
    }
    return data;
  }
  let result;
  await readLines(
    response.body,
    async (line) => {
      if (!line.trim()) {
        return;
      }
      const event = JSON.parse(line);
      if (event.type === 'error') {
        throw clientError(event.error);
      }
      if (event.type === 'progress') {
        await onProgress?.(event);
      }
      if (event.type === 'result') {
        result = event.result;
      }
    },
    options,
  );
  if (!result) {
    throw Error(t('CodexSessionsSection.message009'));
  }
  return result;
}

/** @param url - Catalog URL. @param options - Request options. @returns A checked raw stream response. */
async function requestStream(url, options) {
  const response = await request(url, options);
  if (!response.ok) {
    await readJson(response, options?.signal);
  }
  return response;
}

module.exports = { readLines, readSyncEvents, readConversationResponse, requestStream };
