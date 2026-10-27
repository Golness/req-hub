import { Readable, Writable } from 'node:stream';

// One Host operation implementation, reached by both authenticated HTTP and
// agent tools. Existing handlers retain their validation and transactional work.
export function createOperations(routes) {
  const catalog = routes.filter(route => route.kind === 'exact' && !['/req-hub/open-in-explorer'].includes(route.path));
  const byAction = new Map(catalog.map(route => [route.path.slice('/req-hub/'.length), route]));
  // Prefix APIs have explicit operation paths; never let a tool select an arbitrary URL.
  for (const [action, path] of [
    ['knowledge-search', '/req-hub/knowledge/search'], ['knowledge-search-status', '/req-hub/knowledge/search/status'],
    ['knowledge-status', '/req-hub/knowledge/status'], ['knowledge-entries', '/req-hub/knowledge/entries'],
    ['knowledge-source', '/req-hub/knowledge/source'],
    ['knowledge-entry', '/req-hub/knowledge/entries/:id'], ['knowledge-build', '/req-hub/knowledge/builds'],
    ['knowledge-job', '/req-hub/knowledge/builds/:id'], ['knowledge-cancel', '/req-hub/knowledge/builds/:id/cancel'],
    ['writing-options', '/req-hub/writing/options'], ['writing-optimize', '/req-hub/writing/optimize'],
    ['writing-job', '/req-hub/writing/jobs/:id'], ['writing-cancel', '/req-hub/writing/jobs/:id/cancel'],
  ]) {
    const route = routes.find(item => item.kind === 'prefix' && path.startsWith(item.path + '/'));
    if (route) byAction.set(action, { ...route, operationPath: path });
  }
  const dispatch = (route, req, res) => route.handler(req, res);
  return {
    routes: routes.map(route => ({ ...route, handler: (req, res) => dispatch(route, req, res) })),
    actions: [...byAction.keys()],
    async execute({ action, method = 'GET', query = {}, body, id }, exec) {
      const route = byAction.get(action);
      if (!route) throw new Error('UNKNOWN_OPERATION');
      exec.signal?.throwIfAborted();
      const params = { ...query };
      const sessionId = exec.agent?.session?.id;
      // The caller's actual agent owns delegation; it cannot impersonate another session.
      if (action === 'writing-optimize' && body && typeof body === 'object') body = { ...body, sessionId };
      const path = route.operationPath || route.path;
      if (path.includes(':id') && (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id))) throw new Error('INVALID_OPERATION_ID');
      const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      request.method = method; request.url = path.replace(':id', encodeURIComponent(id || '')) + '?' + new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
      request.headers = { 'content-type': 'application/json', ...(sessionId ? { 'x-session-id': sessionId } : {}) };
      let bytes = 0; const chunks = [];
      const response = new Writable({ write(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) return callback(new Error('OPERATION_OUTPUT_TOO_LARGE'));
        chunks.push(Buffer.from(chunk)); callback();
      } });
      response.statusCode = 200;
      response.writeHead = (status, headers) => { response.statusCode = status; response.headers = headers; response.headersSent = true; return response; };
      response.setHeader = () => response;
      let responseError;
      response.on('error', error => { responseError = error; });
      const abort = () => request.destroy(exec.signal.reason);
      request.on('error', () => {});
      exec.signal?.addEventListener('abort', abort, { once: true });
      try {
        await dispatch(route, request, response);
        if (responseError) throw responseError;
        exec.signal?.throwIfAborted();
        const text = Buffer.concat(chunks).toString('utf8');
        let value; try { value = JSON.parse(text); } catch { value = text; }
        return { status: response.statusCode, value };
      } finally { exec.signal?.removeEventListener('abort', abort); request.destroy(); response.destroy(); }
    },
  };
}

export function installOperationTool(ctx, operations) {
  return ctx.tools.register({
    name: 'req_hub_action',
    description: 'Run ReqHub application operations using the same Host implementation as the UI. Use GET to inspect, POST to change data. Writing actions use the calling session. User-only OS interactions are excluded.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: operations.actions }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
      query: { type: 'object', additionalProperties: true }, body: { type: 'object', additionalProperties: true }, id: { type: 'string' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => operations.execute(args, exec),
  });
}
