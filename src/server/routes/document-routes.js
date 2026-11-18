import { assertWorkspaceCaller } from '../application/caller.js';
import { json, readBody } from '../utils.js';

/**
 * Share replica inspection and failed-target retry between authenticated UI and Agent tools.
 * @param registry - Authoritative workspace registry.
 * @param documents - Plugin-owned replica service.
 * @returns Exact routes with a shared application operation and workspace authorization.
 */
export function createDocumentRoutes(registry, documents) {
  return ['status', 'retry'].map((action) => {
    const method = action === 'status' ? 'GET' : 'POST';
    const execute = async (input, caller = {}) => {
      const workspace = registry.list().find((item) => item.id === input.workspaceId);
      if (!workspace) {
        throw Object.assign(new Error('DOCUMENT_WORKSPACE_MISSING'), { status: 404 });
      }
      if (caller.kind === 'agent') {
        await assertWorkspaceCaller(caller, workspace);
      }
      caller.signal?.throwIfAborted();
      const offset = Number(input.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw Object.assign(new Error('DOCUMENT_INPUT_INVALID'), { status: 400 });
      }
      const value =
        action === 'status'
          ? await documents.list(input.workspaceId, offset)
          : await documents.retry(input.workspaceId, input.path);
      return { status: 200, value };
    };
    return {
      kind: 'exact',
      path: `/req-hub/documents/${action}`,
      operation: { action: `documents/${action}`, methods: [method], execute },
      async handler(req, res) {
        if (req.method !== method) {
          return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
        }
        try {
          const input =
            method === 'GET'
              ? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)
              : JSON.parse(await readBody(req, 16000));
          const result = await execute(input, {
            kind: req.operationExec ? 'agent' : 'user',
            agent: req.operationExec?.agent,
            signal: req.operationExec?.signal,
          });
          return json(res, result.value);
        } catch (error) {
          return json(res, { error: error.code || error.message }, error.status || 500);
        }
      },
    };
  });
}
