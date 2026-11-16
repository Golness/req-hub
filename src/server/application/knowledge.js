import { fail, publicError } from '../knowledge-v2/contracts.js';
import { assertWorkspaceCaller } from './caller.js';
import {
  listSources,
  getSource,
  stateByPath,
  listFileCandidates,
} from '../knowledge-v2/source-repository.js';

/**
 * Execute scoped knowledge operations independently of the transport.
 * @param app - Existing KnowledgeApplication facade.
 * @param path - An explicitly catalogued path within the knowledge namespace.
 * @param method - Catalogued HTTP-compatible method.
 * @param input - Validated operation parameters, including workspace identity.
 * @param caller - Trusted caller kind and cancellation context.
 * @returns A structured result; destructive actions enforce user-only access here.
 */
export async function executeKnowledgeOperation(app, path, method, input, caller = {}) {
  const response = (value, status = 200) => ({ status, value });
  try {
    caller.signal?.throwIfAborted();
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('KB_INPUT_INVALID', 400);
    }
    if (typeof input.workspaceId !== 'string' || !input.workspaceId) {
      fail('KB_INPUT_INVALID', 400, { reason: 'workspaceId required' });
    }
    if (caller.kind === 'agent') {
      await assertWorkspaceCaller(
        caller,
        app.registry?.list().find((workspace) => workspace.id === input.workspaceId),
      );
    }
    const store = await app.scope(input.workspaceId);
    const userOnly = () => {
      if (caller.kind === 'agent') {
        fail('KB_USER_REQUIRED', 403);
      }
    };
    const signal = caller.signal;

    if (method === 'GET' && path === '/sources') {
      return response(
        await listSources(store, {
          query: input.query,
          kind: input.kind,
          status: input.status,
          offset: input.offset,
          limit: input.limit,
        }),
      );
    }
    // Concrete collection routes must precede the /sources/:id catch-all;
    // otherwise "sessions" and "files" would be parsed as source IDs.
    if (method === 'GET' && path === '/sources/files/candidates') {
      return response(await listFileCandidates(store, { signal }));
    }
    if (method === 'GET' && path === '/sources/sessions') {
      return response(await app.sessionOptions(input.workspaceId));
    }
    if (method === 'GET' && path === '/sources/sessions/detail') {
      return response(await app.sessionDetail(store, { id: input.id, version: input.version }));
    }
    if (method === 'POST' && path === '/sources/sessions') {
      return response(
        await app.importSessions(store, {
          selections: input.selections,
          mode: input.mode,
          ingest: input.ingest === true,
          signal,
        }),
      );
    }
    if (method === 'POST' && path === '/sources/files') {
      return response(
        await app.importFiles(store, {
          files: input.files,
          requestKey: input.requestKey,
          ingest: input.ingest === true,
          signal,
        }),
      );
    }
    if (method === 'GET' && path === '/source-state') {
      if (typeof input.path !== 'string' || !input.path) {
        fail('KB_INPUT_INVALID', 400, { reason: 'path required' });
      }
      return response(await stateByPath(store, input.path));
    }
    const sourceMatch = path.match(/^\/sources\/([^/]+)(\/delete)?$/);
    if (sourceMatch && method === 'GET' && !sourceMatch[2]) {
      return response(await getSource(store, sourceMatch[1]));
    }
    if (sourceMatch && method === 'POST' && sourceMatch[2]) {
      userOnly();
      return response(await app.deleteSource(store, sourceMatch[1]));
    }
    if (method === 'GET' && path === '/settings') {
      return response(await app.sync.settings(input.workspaceId));
    }
    if (method === 'POST' && path === '/settings') {
      userOnly();
      return response(
        await app.sync.saveSettings(input.workspaceId, {
          expectedVersion: input.expectedVersion,
          values: input.values,
        }),
      );
    }
    if (method === 'POST' && path === '/jobs') {
      const job = await app.createJob(store, {
        kind: input.kind,
        sourceIds: input.sourceIds,
        requestKey: input.requestKey,
      });
      return response({ ...job, jobId: job.id }, job.status === 'queued' ? 202 : 200);
    }
    if (method === 'GET' && path === '/jobs') {
      return response(await app.jobs(store));
    }
    const jobMatch = path.match(/^\/jobs\/([^/]+)(?:\/(cancel|resume))?$/);
    if (jobMatch) {
      if (method === 'GET' && !jobMatch[2]) {
        return response(await app.job(store, jobMatch[1]));
      }
      if (method === 'POST' && jobMatch[2] === 'cancel') {
        return response(await app.cancelJob(store, jobMatch[1]));
      }
      if (method === 'POST' && jobMatch[2] === 'resume') {
        userOnly();
        return response(await app.resumeJob(store, jobMatch[1]), 202);
      }
    }
    if (method === 'GET' && path === '/pages') {
      return response(await app.listPages(store));
    }
    if (method === 'GET' && path.startsWith('/pages/')) {
      const pageId = decodeURIComponent(path.slice('/pages/'.length));
      return response(await app.getPage(store, pageId));
    }
    if (method === 'GET' && path === '/search') {
      return response(
        await app.search(store, { query: input.q, answerableOnly: input.answerable === '1' }),
      );
    }
    if (method === 'POST' && path === '/query') {
      return response(
        await app.query(store, { question: input.question, mode: input.mode, signal }),
      );
    }
    if (method === 'POST' && path === '/evidence') {
      return response(await app.evidence(store, { query: input.query, limit: input.limit }));
    }
    if (method === 'POST' && path === '/lint') {
      const result = await app.lint(store, { mode: input.mode, requestKey: input.requestKey });
      return response(result, result.job ? 202 : 200);
    }
    if (method === 'GET' && path === '/rules') {
      return response(await store.rules());
    }
    if (method === 'POST' && path === '/rules') {
      userOnly();
      return response(
        await app.saveRules(store, {
          purpose: input.purpose,
          schema: input.schema,
          language: input.language,
        }),
      );
    }
    if (method === 'POST' && path === '/reset') {
      userOnly();
      const meta = await store.meta();
      if (input.confirm !== store.scope.scopeId || input.expectedEpoch !== meta.epoch) {
        fail('KB_RESET_CONFIRM_REQUIRED', 409, {
          scopeId: store.scope.scopeId,
          epoch: meta.epoch,
        });
      }
      await app.reset(store, input.expectedEpoch);
      return response({ reset: true });
    }
    fail('KB_ROUTE_MISSING', 404, { path });
  } catch (error) {
    return response({ error: publicError(error) }, error.status || 500);
  }
}
