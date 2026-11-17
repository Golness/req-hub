'use strict';
const { endpoint } = require('./endpoints.js');
const { requestJson } = require('./transport.js');

/**
 * Call a workspace-scoped JSON namespace using one ownership and serialization contract.
 * @param namespace - Catalogued namespace.
 * @param path - Namespace-local resource path.
 * @param workspaceId - Explicit owning workspace.
 * @param body - Optional write payload; null/undefined selects a read.
 * @param signal - Request cancellation.
 * @param sessionId - Optional actual selected session for delegated work.
 * @returns Complete Host JSON with structured failures preserved.
 */
function scopedRequest(namespace, path, workspaceId, body, signal, sessionId) {
  const read = body === null || body === undefined;
  return requestJson(endpoint(namespace, read ? { workspaceId } : undefined, path), {
    signal,
    ...(read ? {} : { json: { ...body, workspaceId } }),
    ...(sessionId ? { headers: { 'x-session-id': sessionId } } : {}),
  });
}

module.exports = {
  scopedRequest,
  ...require('./endpoints.js'),
  ...require('./transport.js'),
  ...require('./streams.js'),
};
