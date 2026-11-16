import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

// Direct catalog entries share application methods with HTTP. Unmigrated operations
// retain a bounded compatibility bridge until their application boundary is extracted.
/**
 * Expose an explicit operation catalog shared by HTTP handlers and Agent tools.
 * @param routes - Host route definitions sharing one business implementation.
 * @returns The operation dispatcher and its action catalog.
 */
export function createOperations(routes) {
  const catalog = routes.filter(
    (route) => route.kind === 'exact' && !['/req-hub/open-in-explorer'].includes(route.path),
  );
  const byAction = new Map(catalog.map((route) => [route.path.slice('/req-hub/'.length), route]));
  const direct = new Map();
  for (const route of routes) {
    for (const operation of route.operations || (route.operation ? [route.operation] : [])) {
      direct.set(operation.action, operation);
    }
  }
  // Prefix APIs have explicit operation paths; never let a tool select an arbitrary URL.
  for (const [action, path] of [
    ...[
      'rules',
      'query',
      'evidence',
      'lint',
      'search',
      'settings',
      'sources',
      'sources/files',
      'source-state',
      'sources/sessions',
      'sources/sessions/detail',
      'pages',
      'jobs',
      'reset',
    ].map((action) => [
      'knowledge-v2-' + action.replaceAll('/', '-'),
      '/req-hub/knowledge-v2/' + action,
    ]),
    ['knowledge-v2-source', '/req-hub/knowledge-v2/sources/:id'],
    ['knowledge-v2-source-delete', '/req-hub/knowledge-v2/sources/:id/delete'],
    ['knowledge-v2-page', '/req-hub/knowledge-v2/pages/:id'],
    ['knowledge-v2-job', '/req-hub/knowledge-v2/jobs/:id'],
    ['knowledge-v2-job-cancel', '/req-hub/knowledge-v2/jobs/:id/cancel'],
    ['knowledge-v2-job-resume', '/req-hub/knowledge-v2/jobs/:id/resume'],
    ['knowledge-document-context', '/req-hub/knowledge/enhancements/context'],
    ['knowledge-enhancement-start', '/req-hub/knowledge/enhancements/jobs'],
    ['knowledge-enhancement-job', '/req-hub/knowledge/enhancements/jobs/:id'],
    ['knowledge-enhancement-cancel', '/req-hub/knowledge/enhancements/jobs/:id/cancel'],
    ['knowledge-enhancement-review', '/req-hub/knowledge/enhancements/reviews'],
    ['knowledge-graph-entities', '/req-hub/knowledge/graph/entities'],
    ['knowledge-graph-relations', '/req-hub/knowledge/graph/relations'],
    ['knowledge-graph-impact', '/req-hub/knowledge/graph/impact'],
    ['writing-options', '/req-hub/writing/options'],
    ['writing-knowledge', '/req-hub/writing/knowledge'],
    ['writing-optimize', '/req-hub/writing/optimize'],
    ['writing-assets', '/req-hub/writing/assets'],
    ['writing-save', '/req-hub/writing/save'],
    ['writing-jobs', '/req-hub/writing/jobs'],
    ['writing-job', '/req-hub/writing/jobs/:id'],
    ['writing-cancel', '/req-hub/writing/jobs/:id/cancel'],
  ]) {
    const route = routes.find((item) => item.kind === 'prefix' && path.startsWith(item.path + '/'));
    if (route) {
      byAction.set(action, { ...route, operationPath: path });
    }
  }
  const dispatch = (route, req, res) => route.handler(req, res);
  return {
    routes: routes.map((route) => ({ ...route, handler: (req, res) => dispatch(route, req, res) })),
    actions: [...new Set([...byAction.keys(), ...direct.keys()])],
    async execute({ action, method = 'GET', query = {}, body, id }, exec) {
      const operation = direct.get(action);
      if (operation) {
        exec.signal?.throwIfAborted();
        if (!operation.methods.includes(method)) {
          return { status: 405, value: { error: 'METHOD_NOT_ALLOWED' } };
        }
        let result;
        try {
          result = await operation.execute(
            { ...(method === 'GET' ? query : body), ...(id === undefined ? {} : { id }) },
            { ...exec, kind: 'agent' },
            () => {},
            method,
          );
        } catch (error) {
          result = {
            status: error.status || 500,
            value: {
              error: error.code || error.message,
              ...(error.details ? { details: error.details } : {}),
            },
          };
        }
        exec.signal?.throwIfAborted();
        const rendered = [{ type: 'text', text: JSON.stringify(result) }];
        if (Buffer.byteLength(JSON.stringify(rendered)) + 1024 > 8 * 1024 * 1024) {
          throw new Error('OPERATION_OUTPUT_TOO_LARGE');
        }
        return result;
      }
      const route = byAction.get(action);
      if (!route) {
        throw new Error('UNKNOWN_OPERATION');
      }
      exec.signal?.throwIfAborted();
      const params = { ...query };
      const sessionId = exec.agent?.session?.id;
      // The caller's actual agent owns delegation; it cannot impersonate another session.
      if (action === 'writing-optimize' && body && typeof body === 'object') {
        body = { ...body, sessionId };
      }
      const path = route.operationPath || route.path;
      if (
        path.includes(':id') &&
        (typeof id !== 'string' || !id || id.length > 512 || /[\x00-\x1f]/.test(id))
      ) {
        throw new Error('INVALID_OPERATION_ID');
      }
      const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      request.operationExec = exec;
      request.method = method;
      request.url =
        path.replace(':id', encodeURIComponent(id || '')) +
        '?' +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        );
      request.headers = {
        'content-type': 'application/json',
        ...(sessionId ? { 'x-session-id': sessionId } : {}),
      };
      let bytes = 0;
      const chunks = [];
      const response = new Writable({
        write(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) {
            return callback(new Error('OPERATION_OUTPUT_TOO_LARGE'));
          }
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      response.statusCode = 200;
      response.writeHead = (status, headers) => {
        response.statusCode = status;
        response.headers = headers;
        response.headersSent = true;
        return response;
      };
      response.setHeader = () => response;
      let responseError;
      response.on('error', (error) => {
        responseError = error;
      });
      const abort = () => request.destroy(exec.signal.reason);
      request.on('error', () => {});
      exec.signal?.addEventListener('abort', abort, { once: true });
      try {
        await dispatch(route, request, response);
        // Sync handlers start owned work when the request body ends; wait for its result.
        if (action === 'phased-sync' && !response.writableEnded) {
          await finished(response, { signal: exec.signal, cleanup: true });
        }
        if (responseError) {
          throw responseError;
        }
        exec.signal?.throwIfAborted();
        const text = Buffer.concat(chunks).toString('utf8');
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          value = text;
        }
        return { status: response.statusCode, value };
      } finally {
        exec.signal?.removeEventListener('abort', abort);
        request.destroy();
        response.destroy();
      }
    },
  };
}

/**
 * Register Agent access to the shared Host operation dispatcher.
 * @param ctx - The injected Host context.
 * @param operations - The shared operation dispatcher.
 * @param run - Plugin-owned async scope used to bind configuration and track in-flight work.
 * @returns The tool registration disposer.
 */
export function installOperationTool(ctx, operations, run = (callback) => callback()) {
  return ctx.tools.register({
    name: 'req_hub_action',
    description:
      'Run ReqHub application operations using the same Host implementation as the UI. Use GET to inspect, POST to change data. Writing actions use the calling session. User-only OS interactions are excluded.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: operations.actions },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        query: { type: 'object', additionalProperties: true },
        body: { type: 'object', additionalProperties: true },
        id: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => run(() => operations.execute(args, exec)),
  });
}
