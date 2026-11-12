import { json, readBody } from '../utils.js';
import { fail, publicError } from '../knowledge-v2/contracts.js';
import { listSources, getSource, stateByPath } from '../knowledge-v2/source-repository.js';

const PREFIX = '/req-hub/knowledge-v2';

/**
 * Thin knowledge-v2 routes; all business logic lives in the application facade.
 * Destructive actions (delete/reset/rules) reject Agent operation execution.
 * @param app - The KnowledgeApplication instance.
 * @returns Route definitions for authenticated registration.
 */
export function createKnowledgeV2Routes(app) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.slice(PREFIX.length) || '/';
      const input =
        req.method === 'POST'
          ? JSON.parse(await readBody(req))
          : Object.fromEntries(url.searchParams);
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('KB_INPUT_INVALID', 400);
      }
      if (typeof input.workspaceId !== 'string' || !input.workspaceId) {
        fail('KB_INPUT_INVALID', 400, { reason: 'workspaceId required' });
      }
      const store = await app.scope(input.workspaceId);
      const userOnly = () => {
        if (req.operationExec) {
          fail('KB_USER_REQUIRED', 403);
        }
      };
      const signal = req.operationExec?.signal;
      const method = req.method;

      if (method === 'GET' && path === '/sources') {
        return json(
          res,
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
      if (method === 'GET' && path === '/sources/sessions') {
        return json(res, await app.sessionOptions(input.workspaceId));
      }
      if (method === 'GET' && path === '/sources/sessions/detail') {
        return json(res, await app.sessionDetail(store, { id: input.id, version: input.version }));
      }
      if (method === 'POST' && path === '/sources/sessions') {
        return json(
          res,
          await app.importSessions(store, {
            selections: input.selections,
            mode: input.mode,
            ingest: input.ingest === true,
            signal,
          }),
        );
      }
      if (method === 'POST' && path === '/sources/files') {
        return json(
          res,
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
        return json(res, await stateByPath(store, input.path));
      }
      const sourceMatch = path.match(/^\/sources\/([^/]+)(\/delete)?$/);
      if (sourceMatch && method === 'GET' && !sourceMatch[2]) {
        return json(res, await getSource(store, sourceMatch[1]));
      }
      if (sourceMatch && method === 'POST' && sourceMatch[2]) {
        userOnly();
        return json(res, await app.deleteSource(store, sourceMatch[1]));
      }
      if (method === 'GET' && path === '/settings') {
        return json(res, await app.sync.settings(input.workspaceId));
      }
      if (method === 'POST' && path === '/settings') {
        userOnly();
        return json(
          res,
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
        return json(res, { ...job, jobId: job.id }, job.status === 'queued' ? 202 : 200);
      }
      if (method === 'GET' && path === '/jobs') {
        return json(res, await app.jobs(store));
      }
      const jobMatch = path.match(/^\/jobs\/([^/]+)(?:\/(cancel|resume))?$/);
      if (jobMatch) {
        if (method === 'GET' && !jobMatch[2]) {
          return json(res, await app.job(store, jobMatch[1]));
        }
        if (method === 'POST' && jobMatch[2] === 'cancel') {
          return json(res, await app.cancelJob(store, jobMatch[1]));
        }
        if (method === 'POST' && jobMatch[2] === 'resume') {
          userOnly();
          return json(res, await app.resumeJob(store, jobMatch[1]), 202);
        }
      }
      if (method === 'GET' && path === '/pages') {
        return json(res, await app.listPages(store));
      }
      if (method === 'GET' && path.startsWith('/pages/')) {
        const pageId = decodeURIComponent(path.slice('/pages/'.length));
        return json(res, await app.getPage(store, pageId));
      }
      if (method === 'GET' && path === '/search') {
        return json(
          res,
          await app.search(store, { query: input.q, answerableOnly: input.answerable === '1' }),
        );
      }
      if (method === 'POST' && path === '/query') {
        return json(
          res,
          await app.query(store, { question: input.question, mode: input.mode, signal }),
        );
      }
      if (method === 'POST' && path === '/evidence') {
        return json(res, await app.evidence(store, { query: input.query, limit: input.limit }));
      }
      if (method === 'POST' && path === '/lint') {
        const result = await app.lint(store, { mode: input.mode, requestKey: input.requestKey });
        return json(res, result, result.job ? 202 : 200);
      }
      if (method === 'GET' && path === '/rules') {
        return json(res, await store.rules());
      }
      if (method === 'POST' && path === '/rules') {
        userOnly();
        return json(
          res,
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
        return json(res, { reset: true });
      }
      fail('KB_ROUTE_MISSING', 404, { path });
    } catch (error) {
      json(res, { error: publicError(error) }, error.status || 500);
    }
  };
  return [{ kind: 'prefix', path: PREFIX, handler }];
}
