import { json, readBody } from '../utils.js';
import { executeKnowledgeOperation } from '../application/knowledge.js';

const PREFIX = '/req-hub/knowledge-v2';

/**
 * Adapt the shared knowledge use cases to authenticated HTTP and the explicit tool catalog.
 * @param app - Existing KnowledgeApplication facade.
 * @returns A prefix route with direct operation descriptors.
 */
export function createKnowledgeV2Routes(app) {
  const operations = [
    ['rules', '/rules', ['GET', 'POST']],
    ['query', '/query', ['POST']],
    ['evidence', '/evidence', ['POST']],
    ['lint', '/lint', ['POST']],
    ['search', '/search', ['GET']],
    ['settings', '/settings', ['GET', 'POST']],
    ['sources', '/sources', ['GET']],
    ['sources-files', '/sources/files', ['POST']],
    ['source-state', '/source-state', ['GET']],
    ['sources-sessions', '/sources/sessions', ['GET', 'POST']],
    ['sources-sessions-detail', '/sources/sessions/detail', ['GET']],
    ['pages', '/pages', ['GET']],
    ['jobs', '/jobs', ['GET', 'POST']],
    ['reset', '/reset', ['POST']],
    ['source', '/sources/:id', ['GET']],
    ['source-delete', '/sources/:id/delete', ['POST']],
    ['page', '/pages/:id', ['GET']],
    ['job', '/jobs/:id', ['GET']],
    ['job-cancel', '/jobs/:id/cancel', ['POST']],
    ['job-resume', '/jobs/:id/resume', ['POST']],
  ].map(([action, path, methods]) => ({
    action: 'knowledge-v2-' + action,
    methods,
    execute: (input, caller, _onEvent, method) =>
      executeKnowledgeOperation(
        app,
        path.replace(':id', encodeURIComponent(input.id || '')),
        method,
        input,
        caller,
      ),
  }));
  return [
    {
      kind: 'prefix',
      path: PREFIX,
      operations,
      async handler(req, res) {
        try {
          const url = new URL(req.url, 'http://localhost');
          const input =
            req.method === 'POST'
              ? JSON.parse(await readBody(req))
              : Object.fromEntries(url.searchParams);
          const result = await executeKnowledgeOperation(
            app,
            url.pathname.slice(PREFIX.length) || '/',
            req.method,
            input,
            {
              kind: req.operationExec ? 'agent' : 'user',
              agent: req.operationExec?.agent,
              signal: req.operationExec?.signal,
            },
          );
          return json(res, result.value, result.status);
        } catch (error) {
          return json(res, { error: error.message }, error.status || 400);
        }
      },
    },
  ];
}
