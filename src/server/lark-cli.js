import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { BoundedSemaphore } from './concurrency/BoundedSemaphore.js';
import { inspectLarkTarget, larkTargetRevision } from './lark-target.js';
import { listLarkTargets } from './lark-target-browser.js';
import { larkCliError } from './lark-errors.js';
import {
  bindAllLarkWorkspaces,
  larkWorkspacesRevision,
  listLarkWorkspaceBindings,
} from './lark-workspace-bindings.js';
import { createLarkDocumentPublisher, pushLarkDocuments, syncLarkFile } from './lark-file-sync.js';
import { loadConfig, saveConfig } from './config.js';
import { verifyLarkApplication } from './lark-application.js';
import { validateLarkSettings } from './lark-settings.js';
export { validateLarkSettings } from './lark-settings.js';
import { json, readBody } from './utils.js';

async function executablePath(value) {
  const native = async (candidate) => {
    const resolved = await realpath(candidate);
    if (resolved.replaceAll('\\', '/').endsWith('/@larksuite/cli/scripts/run.js')) {
      return join(dirname(resolved), '..', 'bin', 'lark-cli');
    }
    return resolved;
  };
  if (value !== 'lark-cli') {
    return native(value);
  }
  if (!process.env.PATH) {
    throw new Error('LARK_CLI_NOT_FOUND');
  }
  // npm installs a CMD shim on Windows. Execute the native binary directly so
  // cancellation owns the real process and no shell parses user parameters.
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    const filename = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli';
    for (const candidate of [
      join(directory, filename),
      join(directory, 'node_modules', '@larksuite', 'cli', 'bin', filename),
    ]) {
      try {
        await access(candidate);
        return await native(candidate);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) {
          throw error;
        }
      }
    }
  }
  throw new Error('LARK_CLI_NOT_FOUND');
}

/**
 * Serialize bounded CLI operations with cancellable waiting; release only after child exit.
 * @param registry - Registered workspaces whose publication bindings may be changed.
 * @returns Authenticated-route definitions and an asynchronous disposer.
 */
export function createLarkCliRoutes(registry = { list: () => [] }) {
  const controller = new AbortController();
  const tasks = new Set();
  const queue = new BoundedSemaphore(1);
  const run = async (settings, args, signal, input, options = {}) => {
    const executable = await executablePath(settings.executable).catch((error) => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        throw new Error('LARK_CLI_NOT_FOUND');
      }
      throw error;
    });
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        cwd: options.cwd || homedir(),
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
        },
      });
      let failure;
      let size = 0;
      const output = [];
      const diagnostics = [];
      const stop = (code) => {
        failure ||= new Error(code);
        child.kill('SIGKILL');
      };
      const abort = () => stop('LARK_CHECK_CANCELLED');
      const timer = setTimeout(() => stop('LARK_CHECK_TIMEOUT'), settings.timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', (error) => {
        failure ||= new Error(error.code === 'ENOENT' ? 'LARK_CLI_NOT_FOUND' : 'LARK_CHECK_FAILED');
      });
      if (input !== undefined) {
        child.stdin.on('error', () => stop('LARK_CONFIGURE_FAILED'));
        child.stdin.end(input);
      }
      const collect = (chunk, stdout) => {
        size += chunk.length;
        if (size > 256000) {
          stop('LARK_OUTPUT_LIMIT');
        } else if (stdout) {
          output.push(chunk);
        } else {
          diagnostics.push(chunk);
        }
      };
      child.stdout.on('data', (chunk) => collect(chunk, true));
      child.stderr.on('data', (chunk) => collect(chunk, false));
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (failure || signal.aborted || code !== 0) {
          const error =
            failure || larkCliError(Buffer.concat(diagnostics).toString('utf8'), settings.identity);
          error.details = {
            ...error.details,
            identity: settings.identity,
            ...(Number.isSafeInteger(code) ? { exitCode: code } : {}),
          };
          reject(error);
        } else {
          resolve(Buffer.concat(output).toString('utf8'));
        }
      });
      if (signal.aborted) {
        abort();
      }
    });
  };
  /** Reserve the single CLI slot for both interactive and scheduled pushes. */
  const acquireSlot = async (signal) => {
    if (queue.waitingCount >= 16) {
      throw Object.assign(new Error('LARK_QUEUE_FULL'), { status: 429 });
    }
    const waiting = new AbortController();
    const timer = setTimeout(() => waiting.abort(), 30000);
    try {
      const { slot } = await queue.acquire(AbortSignal.any([signal, waiting.signal]));
      return slot;
    } catch (error) {
      if (signal.aborted) {
        throw new Error('LARK_CHECK_CANCELLED');
      }
      if (waiting.signal.aborted) {
        throw new Error('LARK_QUEUE_TIMEOUT');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  /** Run a non-HTTP (scheduler-owned) CLI operation with the saved connection. */
  const runWithSlot = async (task, signal) => {
    if (controller.signal.aborted) {
      throw new Error('LARK_CHECK_CANCELLED');
    }
    const owned = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const slot = await acquireSlot(owned);
    try {
      owned.throwIfAborted();
      const config = await loadConfig();
      const settings = validateLarkSettings(config.lark);
      return await task({ config, settings, signal: owned });
    } finally {
      slot.release();
    }
  };
  const check = async (req, res, action) => {
    if (req.method !== 'POST') {
      return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
    }
    if (action !== 'check' && req.operationExec) {
      return json(res, { error: 'LARK_USER_REQUIRED' }, 403);
    }
    if (controller.signal.aborted) {
      return json(res, { ready: false, code: 'LARK_CHECK_CANCELLED' }, 503);
    }
    const disconnected = new AbortController();
    const abort = () => disconnected.abort();
    res.on('close', abort);
    const signal = AbortSignal.any([
      controller.signal,
      disconnected.signal,
      ...(req.operationExec?.signal ? [req.operationExec.signal] : []),
    ]);
    let slot;
    try {
      let input = {};
      const abortBody = () => req.destroy(new Error('LARK_CHECK_CANCELLED'));
      const bodyTimer = setTimeout(() => req.destroy(new Error('LARK_CHECK_TIMEOUT')), 30000);
      try {
        signal.throwIfAborted();
        signal.addEventListener('abort', abortBody, { once: true });
        input = JSON.parse(await readBody(req, 16000));
      } finally {
        clearTimeout(bodyTimer);
        signal.removeEventListener('abort', abortBody);
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('LARK_CONFIG_INVALID');
      }
      if (input.lark !== undefined && req.operationExec) {
        return json(res, { error: 'LARK_USER_REQUIRED' }, 403);
      }
      slot = await acquireSlot(signal);
      signal.throwIfAborted();
      const existing = await loadConfig();
      const settings = validateLarkSettings(input.lark === undefined ? existing.lark : input.lark);
      if (action === 'file-sync') {
        // Synchronization always uses the saved connection, never a request body.
        const result = await syncLarkFile({
          registry,
          config: existing,
          settings: validateLarkSettings(existing.lark),
          workspaceId: input.workspaceId,
          path: input.path,
          execute: run,
          signal,
        });
        return json(res, {
          synced: true,
          ...result,
          code: result.action === 'created' ? 'LARK_SYNC_CREATED' : 'LARK_SYNC_UPDATED',
        });
      }
      if (action.startsWith('target-')) {
        if (action === 'target-list') {
          return json(res, await listLarkWorkspaceBindings(registry, existing, signal));
        }
        if (action === 'target-default-save') {
          const batch = await bindAllLarkWorkspaces({
            registry,
            settings,
            spaceId: input.spaceId,
            expectedRevision: input.expectedDefaultRevision,
            loadConfig,
            saveConfig,
            execute: run,
            signal,
          });
          const binding = batch.targets[input.workspaceId] || null;
          return json(res, {
            saved: true,
            code: 'LARK_TARGET_SAVED',
            binding,
            revision: larkTargetRevision(binding),
            defaultRevision: batch.defaultRevision,
            total: batch.total,
            created: batch.created,
            reused: batch.reused,
          });
        }
        const workspace = registry.list().find((item) => item.id === input.workspaceId);
        if (!workspace) {
          throw new Error('LARK_WORKSPACE_INVALID');
        }
        if (action === 'target-remove') {
          if (input.expectedRevision !== larkTargetRevision(existing.larkTargets?.[workspace.id])) {
            throw new Error('LARK_TARGET_CONFLICT');
          }
          const targets = Object.assign(Object.create(null), existing.larkTargets);
          delete targets[workspace.id];
          signal.throwIfAborted();
          await saveConfig({ ...existing, larkTargets: targets });
          return json(res, {
            saved: true,
            binding: null,
            revision: null,
            defaultRevision: larkWorkspacesRevision(registry.list(), {
              ...existing,
              larkTargets: targets,
            }),
            code: 'LARK_TARGET_REMOVED',
          });
        }
        const root = await realpath(workspace.path);
        if (action === 'target-options') {
          return json(res, await listLarkTargets(settings, input, run, signal));
        }
        const stored = existing.larkTargets?.[workspace.id];
        const binding = stored?.workspaceRoot === root ? stored : null;
        if (action === 'target-get') {
          return json(res, {
            binding,
            revision: larkTargetRevision(stored),
            defaultRevision: larkWorkspacesRevision(registry.list(), existing),
            workspaceTitle: workspace.title || workspace.id,
          });
        }
        if (input.useDefault) {
          throw new Error('LARK_TARGET_INVALID');
        }
        const workspaceName = workspace.title || workspace.id;
        const validateCurrent = async () => {
          signal.throwIfAborted();
          const current = await loadConfig();
          const currentWorkspace = registry.list().find((item) => item.id === workspace.id);
          if (
            !currentWorkspace ||
            (await realpath(currentWorkspace.path)) !== root ||
            (currentWorkspace.title || currentWorkspace.id) !== workspaceName
          ) {
            throw new Error('LARK_WORKSPACE_INVALID');
          }
          if (
            input.expectedRevision !== larkTargetRevision(current.larkTargets?.[workspace.id]) ||
            JSON.stringify(validateLarkSettings(current.lark)) !== JSON.stringify(settings)
          ) {
            throw new Error('LARK_TARGET_CONFLICT');
          }
          signal.throwIfAborted();
          return current;
        };
        const target = await inspectLarkTarget(settings, input.selection || input.url, run, signal);
        if (action === 'target-check') {
          return json(res, { checked: true, code: 'LARK_TARGET_CHECK_OK', target });
        }
        const current = await validateCurrent();
        const targets = Object.assign(Object.create(null), current.larkTargets);
        const next = target ? { ...target, workspaceRoot: root } : null;
        if (next) {
          targets[workspace.id] = next;
        } else {
          delete targets[workspace.id];
        }
        signal.throwIfAborted();
        await saveConfig({ ...current, larkTargets: targets });
        return json(res, {
          saved: true,
          binding: next,
          revision: larkTargetRevision(next),
          defaultRevision: larkWorkspacesRevision(registry.list(), {
            ...current,
            larkTargets: targets,
          }),
          code: next ? 'LARK_TARGET_SAVED' : 'LARK_TARGET_REMOVED',
        });
      }
      if (action === 'configure' || action === 'app-check') {
        await verifyLarkApplication(input, settings.timeoutMs, signal);
        if (action === 'app-check') {
          return json(res, { credentialsValid: true, code: 'LARK_APP_CHECK_OK' });
        }
        const args = [
          'config',
          'init',
          '--app-id',
          input.appId,
          '--app-secret-stdin',
          '--brand',
          input.brand,
          ...(settings.profile ? ['--name', settings.profile] : []),
        ];
        const secret = input.appSecret;
        delete input.appSecret;
        await run(settings, args, signal, secret + '\n').catch((error) => {
          if (error.message === 'LARK_CHECK_FAILED') {
            throw new Error('LARK_CONFIGURE_FAILED');
          }
          throw error;
        });
        return json(res, { configured: true, code: 'LARK_APP_SAVED' });
      }
      const prefix = settings.profile ? ['--profile', settings.profile] : [];
      const version = await run(settings, [...prefix, '--version'], signal);
      const versionMatch = version.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
      if (!versionMatch) {
        throw new Error('LARK_RESPONSE_INVALID');
      }
      const raw = await run(settings, [...prefix, 'auth', 'status', '--json', '--verify'], signal);
      let status;
      try {
        status = JSON.parse(raw);
      } catch {
        throw new Error('LARK_RESPONSE_INVALID');
      }
      const data = status?.data || status;
      const identity = data?.identities?.[settings.identity];
      // Exit zero only means the status command ran. Require server verification
      // for the selected identity; another usable account cannot satisfy this check.
      const ready =
        status?.ok !== false && identity?.available === true && identity?.verified === true;
      let code = 'LARK_AUTH_UNVERIFIED';
      if (ready) {
        code = 'LARK_CHECK_OK';
      } else if (!data?.appId) {
        code = 'LARK_APP_MISSING';
      } else if (['missing', 'not_configured'].includes(identity?.status)) {
        code = settings.identity === 'user' ? 'LARK_LOGIN_REQUIRED' : 'LARK_APP_MISSING';
      }
      if (action === 'save') {
        if (!ready) {
          return json(res, { ready: false, code });
        }
        const current = await loadConfig();
        signal.throwIfAborted();
        await saveConfig({ ...current, lark: settings });
      }
      return json(res, {
        ...(action === 'save' ? { saved: true } : {}),
        ready,
        code,
        version: versionMatch[0],
        identity: settings.identity,
        appId: typeof data?.appId === 'string' ? data.appId : '',
      });
    } catch (error) {
      const code = /^LARK_[A-Z_]+$/.test(error.message) ? error.message : 'LARK_CHECK_FAILED';
      return json(
        res,
        {
          ready: false,
          code,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status || 200,
      );
    } finally {
      res.removeListener('close', abort);
      slot?.release();
    }
  };
  return {
    routes: [
      'check',
      'configure',
      'app-check',
      'save',
      'target-get',
      'target-list',
      'target-options',
      'target-check',
      'target-save',
      'target-default-save',
      'target-remove',
      'file-sync',
    ].map((action) => ({
      kind: 'exact',
      path: '/req-hub/lark/' + action,
      handler(req, res) {
        const task = check(req, res, action);
        tasks.add(task);
        return task.finally(() => tasks.delete(task));
      },
    })),
    /** Push one saved workspace document (scheduled sync products). */
    async pushFile({ workspaceId, path, signal } = {}) {
      const task = runWithSlot(
        ({ config, settings, signal: owned }) =>
          syncLarkFile({
            registry,
            config,
            settings,
            workspaceId,
            path,
            execute: run,
            signal: owned,
          }),
        signal,
      );
      tasks.add(task);
      return task.finally(() => tasks.delete(task));
    },
    /** Push compiled Markdown products that are not stored under docsDir. */
    async pushDocuments({ workspaceId, documents, signal } = {}) {
      const task = runWithSlot(
        ({ config, settings, signal: owned }) =>
          pushLarkDocuments({
            registry,
            config,
            settings,
            workspaceId,
            documents,
            execute: run,
            signal: owned,
          }),
        signal,
      );
      tasks.add(task);
      return task.finally(() => tasks.delete(task));
    },
    /** Publish an immutable, exact-byte document version under the saved binding. */
    async pushReplica({ workspaceId, path, bytes, version, expectedBinding, signal }) {
      const task = runWithSlot(async ({ config, settings, signal: owned }) => {
        const binding = createHash('sha256')
          .update(JSON.stringify([config.lark, config.larkTargets?.[workspaceId]]))
          .digest('hex');
        if (binding !== expectedBinding || config.documents?.larkSyncEnabled !== true) {
          throw new Error('LARK_TARGET_CONFLICT');
        }
        const execute = async (...args) => {
          const latest = await loadConfig();
          const currentBinding = createHash('sha256')
            .update(JSON.stringify([latest.lark, latest.larkTargets?.[workspaceId]]))
            .digest('hex');
          owned.throwIfAborted();
          if (currentBinding !== expectedBinding || latest.documents?.larkSyncEnabled !== true) {
            throw new Error('LARK_TARGET_CONFLICT');
          }
          const workspace = registry.list().find((item) => item.id === workspaceId);
          if (
            !workspace ||
            (await realpath(workspace.path)) !== latest.larkTargets?.[workspaceId]?.workspaceRoot
          ) {
            throw new Error('LARK_WORKSPACE_INVALID');
          }
          return run(...args);
        };
        const publisher = await createLarkDocumentPublisher({
          registry,
          config,
          settings,
          workspaceId,
          execute,
          signal: owned,
        });
        return publisher.publishReplica({ path, bytes, version });
      }, signal);
      tasks.add(task);
      return task.finally(() => tasks.delete(task));
    },
    async dispose() {
      controller.abort();
      await Promise.allSettled([...tasks]);
    },
  };
}
