import { creationStatus, updateMain } from '../creation.js';
import { loadConfig } from '../config.js';
import { json, readBody } from '../utils.js';

export function createCreationRoutes(registry, configLoader = loadConfig) {
  const controllers = new Set(), pending = new Set(); let closed = false;
  const handler = (req, res) => {
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); req.on('aborted', abort);
    const ownerSignal = req.operationExec?.signal;
    if (ownerSignal?.aborted) abort(); else ownerSignal?.addEventListener('abort', abort, { once: true });
    const cancelBody = () => { if (req.method === 'POST' && !req.readableEnded) req.destroy(new Error('CREATE_CANCELLED')); };
    controller.signal.addEventListener('abort', cancelBody, { once: true });
    const timeout = setTimeout(abort, 120000); timeout.unref?.();
    const task = (async () => {
      try {
        if (closed) throw Object.assign(new Error('CREATE_CLOSED'), { status: 503 });
        const url = new URL(req.url, 'http://localhost');
        let input;
        try { input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : JSON.parse(await readBody(req)); }
        catch { throw Object.assign(new Error('CREATE_INVALID_INPUT'), { status: 400 }); }
        controller.signal.throwIfAborted();
        const workspace = registry.list().find(item => item.id === input?.workspaceId);
        if (!workspace) throw Object.assign(new Error('CREATE_WORKSPACE_MISSING'), { status: 404 });
        let value;
        if (req.method === 'GET' && url.pathname === '/req-hub/create-status') value = await creationStatus(workspace, await configLoader(), controller.signal);
        else if (req.method === 'POST' && url.pathname === '/req-hub/update-main') value = await updateMain(workspace, input.expectedHead, controller.signal, input.branch);
        else throw Object.assign(new Error('CREATE_INVALID_INPUT'), { status: 405 });
        json(res, value);
      } catch (error) { json(res, { error: controller.signal.aborted ? 'CREATE_CANCELLED' : /^CREATE_[A-Z_]+$/.test(error.message) ? error.message : 'CREATE_FAILED' }, error.status || 500); }
    })().finally(() => { clearTimeout(timeout); req.removeListener('aborted', abort); ownerSignal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelBody); controllers.delete(controller); pending.delete(task); });
    pending.add(task); return task;
  };
  return { routes: [{ kind: 'exact', path: '/req-hub/create-status', handler }, { kind: 'exact', path: '/req-hub/update-main', handler }], async dispose() { closed = true; for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending]); } };
}
