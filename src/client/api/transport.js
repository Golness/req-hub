'use strict';
const { isEndpoint } = require('./endpoints.js');

/** A stable Host failure preserving transport status, structured details and the original result. */
class ApiError extends Error {
  constructor(code, { status = 0, details, params, data, retryable, cause } = {}) {
    super(code, { cause });
    Object.assign(this, { code, status, details, params, data, retryable });
  }
}

function responseError(response, data) {
  const failure = data?.error;
  const descriptor = failure && typeof failure === 'object' ? failure : {};
  return new ApiError(
    descriptor.code || (typeof failure === 'string' && failure) || data?.code || 'API_HTTP_FAILED',
    {
      status: response.status,
      details: descriptor.details || data?.details,
      params: descriptor.params,
      retryable: descriptor.retryable,
      data,
    },
  );
}

/**
 * Make exactly one same-origin request. Callers own cancellation; writes are never retried.
 * @param url - URL produced by the endpoint catalog.
 * @param options - Fetch options, with an optional json value for automatic JSON encoding.
 * @returns The Response for callers that must inspect conflicts, missing records or streams.
 */
async function request(url, options = {}) {
  if (!isEndpoint(url)) {
    throw new ApiError('API_ENDPOINT_INVALID');
  }
  const { json, ...init } = options;
  init.signal?.throwIfAborted();
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.method ||= 'POST';
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    init.signal?.throwIfAborted();
    if (cause?.name === 'AbortError') {
      throw cause;
    }
    throw new ApiError('API_NETWORK_FAILED', { cause });
  }
  if (init.signal?.aborted) {
    try {
      await response.body?.cancel?.();
    } catch (error) {
      // A locked or already cancelled body is released by its current reader.
    }
    init.signal.throwIfAborted();
  }
  return response;
}

/**
 * Decode one JSON result and preserve Host error descriptors on failed HTTP responses.
 * @param response - The response to consume once.
 * @param signal - Caller cancellation checked after asynchronous body decoding.
 * @returns Parsed data, including failed job records; malformed JSON and HTTP failures reject.
 */
async function readJson(response, signal) {
  let data;
  try {
    data = await response.json();
  } catch (cause) {
    signal?.throwIfAborted();
    throw new ApiError(response.ok ? 'API_RESPONSE_INVALID' : 'API_HTTP_FAILED', {
      status: response.status,
      cause,
    });
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    throw responseError(response, data);
  }
  return data;
}

/** @param url - Catalog URL. @param options - Owned request options. @returns Parsed Host data. */
async function requestJson(url, options) {
  return readJson(await request(url, options), options?.signal);
}

/**
 * Read a Host-converted document with its warnings and artifact metadata intact.
 * @param url - Catalogued read or sync-artifact endpoint.
 * @param options - Owned request options, including cancellation.
 * @returns The complete document result; parsing and authorization failures reject.
 */
async function requestFile(url, options) {
  return requestJson(url, options);
}

module.exports = { request, requestJson, readJson, requestFile, ApiError };
