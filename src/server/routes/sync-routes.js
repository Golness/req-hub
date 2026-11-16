import { createSyncExecution } from '../application/sync-execution.js';
import { msg } from '../messages.js';
import { listDesignReferences } from '../sync-design-reference.js';
import { safeDocumentPath } from '../safe-path.js';
import { syncSupervisor } from '../sync-supervisor.js';
import { retainSyncStorage } from '../sync-storage.js';
import { planSyncTaskCleanup } from '../sync-task-cleanup.js';
/**
 * Document sync routes module.
 * Handles document synchronization HTTP endpoints.
 * All LLM calls are delegated to DSH Subagent.
 * @module routes/sync-routes
 */

import { resolve, relative } from 'node:path';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { findRequirementDir } from '../doc-reader.js';
import { findBranchByRequirement } from '../sync-engine.js';
import { defaultSyncBaseBranch, listSyncCommits, listSyncBranches } from '../sync-branches.js';
import { buildSyncTimeline } from '../sync-timeline.js';
import { compareSyncSnapshots } from '../sync-snapshots.js';
import clock from '../../shared/time.cjs';
import { CodexSessionService } from '../codex-sessions/service.js';
import { createCodexSessionRoutes } from './codex-session-routes.js';
import { ConversationStore, conversationDatabasePath } from '../conversations/store.js';
import { ConversationService } from '../conversations/service.js';
import { dshSource } from '../conversations/dsh-source.js';
import { createConversationRoutes } from './conversation-routes.js';
import { removeRetiredCodexStore } from '../conversations/retired-storage.js';
import { homedir } from 'node:os';
import { json, readBody, parseBranchName } from '../utils.js';
import { log } from '../logger.js';
import {
  loadState as loadSyncState,
  getSyncScope,
  getActiveSync,
  getSyncHistory,
  getSyncById,
  abortSync,
  recoverSyncTask,
  getCachedActiveSyncs,
  removeSyncTask,
  getCachedRequirementPath,
} from '../sync-state.js';

/**
 * Create document sync routes.
 * @param {Object} registry - Workspace registry service
 * @param {Object} llm - LLM service
 * @param {Object} sessions - Sessions service
 * @param {Object} agents - Agents service
 * @param {Object} ctx - DSH context
 * @returns {Array<Object>} Array of route definitions
 */
export function createSyncRoutes(registry, llm, sessions, agents, ctx, options = {}) {
  const storageLease = retainSyncStorage(options.syncStorageRoot);
  const storage = storageLease.store;
  const referenceDirectory = async (workspaceId, requirementId) => {
    const workspace = registry.list().find((item) => item.id === workspaceId);
    if (!workspace || typeof requirementId !== 'string' || !requirementId) {
      throw Object.assign(new Error('SYNC_REFERENCE_INVALID'), { status: 404 });
    }
    const config = await loadConfig();
    const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
    if (docsRoot !== resolve(workspace.path)) {
      await safeDocumentPath(workspace.path, config.docsDir || 'docs');
    }
    const directory = await findRequirementDir(docsRoot, requirementId);
    if (!directory) {
      throw Object.assign(new Error('SYNC_REQUIREMENT_NOT_FOUND'), { status: 404 });
    }
    return safeDocumentPath(docsRoot, relative(docsRoot, directory));
  };
  const releaseDeleted = async (workspaceKey) => {
    for (const task of storage.deleted(workspaceKey)) {
      await library.store.unpin(
        JSON.stringify([task.workspaceId, task.requirementId, task.snapshotDir]),
        await library.policy(),
      );
      storage.cleanup(task);
    }
  };
  const loadState = async (workspaceId, requirementId, reqDir) => {
    const workspace = registry.list().find((item) => item.id === workspaceId);
    if (!workspace) {
      throw new Error('SYNC_WORKSPACE_NOT_FOUND');
    }
    const config = await loadConfig();
    await library.store.unpinRetiredSync(workspaceId);
    const state = await loadSyncState(workspaceId, requirementId, reqDir, {
      workspace,
      docsRoot: resolve(workspace.path, config.docsDir || 'docs'),
      store: storage,
    });
    const scope = getSyncScope(workspaceId, requirementId);
    for (const removed of storage.prune(scope.workspaceKey, config.sync)) {
      await library.store.unpin(
        JSON.stringify([removed.workspaceId, removed.requirementId, removed.snapshotDir]),
        await library.policy(),
      );
    }
    await releaseDeleted(scope.workspaceKey);
    storage.collect(scope.workspaceKey);
    return state;
  };

  const sessionQuery = ctx?.sessionQuery;
  const profile = ctx?.get?.('profileContext');
  const library = new ConversationService({
    store: new ConversationStore(
      options.conversationDatabasePath || conversationDatabasePath(profile?.home),
    ),
    owner: profile?.dir || process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || 'default',
    policy: async () => (await loadConfig()).conversations || {},
  });
  const dsh = dshSource({ registry, sessionQuery, sessions, instance: library.owner });
  const codex = options.codexService || new CodexSessionService({ ...options.codex, library });
  const adapters = [dsh, codex.adapter].filter(Boolean);
  if (options.knowledgeV2) {
    options.knowledgeV2.conversations = { library, adapters };
  }
  let retirement;
  const retire = () =>
    (retirement ||= (async () => {
      await removeRetiredCodexStore(
        profile?.home || process.env.DSH_HOME || join(homedir(), '.dsh'),
      );
      const config = await loadConfig();
      for (const workspace of registry.list()) {
        const docs = resolve(workspace.path, config.docsDir || 'docs');
        await safeDocumentPath(workspace.path, relative(workspace.path, docs), {
          allowMissing: true,
        });
        const visit = async (directory) => {
          let entries;
          try {
            entries = await readdir(directory, { withFileTypes: true });
          } catch (error) {
            if (error.code === 'ENOENT') {
              return;
            }
            throw error;
          }
          if (entries.some((entry) => entry.name === 'sync-logs')) {
            storage.retire(
              storage.bind(
                workspace,
                relative(docs, directory).replaceAll('\\', '/'),
                directory,
                docs,
              ),
            );
          }
          for (const entry of entries) {
            if (entry.name !== 'sync-logs' && entry.isDirectory() && !entry.isSymbolicLink()) {
              await visit(join(directory, entry.name));
            }
          }
        };
        await visit(docs);
        await library.store.unpinRetiredSync(workspace.id);
      }
    })().catch((error) => {
      retirement = undefined;
      throw error;
    }));
  const dshSnapshot = async (workspaceId, id) => {
    if (!(await library.list(workspaceId, dsh)).workspace) {
      await library.refresh(workspaceId, workspaceId, dsh);
    }
    return library.snapshot(workspaceId, id, dsh);
  };

  const pendingSyncs = new Set();
  const controllers = new Map();
  const pendingRequests = new Set();
  let closed = false;
  const ownerScope = {};
  const reconcileOrphans = async () => {
    for (const task of getCachedActiveSyncs()) {
      const owner = syncSupervisor.owner;
      if (
        owner &&
        owner.fields.workspaceId === task.workspaceId &&
        owner.fields.requirementId === task.requirementId &&
        (!owner.task || (owner.task.id === task.id && owner.task.snapshotDir === task.snapshotDir))
      ) {
        continue;
      }
      await recoverSyncTask(task, 'SYNC_OWNER_MISSING');
      syncSupervisor.remember(task);
    }
  };
  const watchdog = setInterval(() => {
    storage.heartbeat();
    void syncSupervisor
      .check()
      .catch((error) =>
        log.sync.error(msg('LOG_TASK_SUPERVISOR_RECOVER_FAILED', { v0: error.message })),
      );
  }, 15000);
  watchdog.unref?.();
  const syncApplication = createSyncExecution({
    registry,
    llm,
    sessions,
    ctx,
    options,
    storage,
    library,
    codex,
    dsh,
    loadState,
    referenceDirectory,
    ownerScope,
    isClosed: () => closed,
    controllers,
    pendingSyncs,
    retire,
  });
  const routes = [
    ...createCodexSessionRoutes(registry, codex),
    ...createConversationRoutes(registry, library, adapters),
    {
      kind: 'exact',
      path: '/req-hub/sync-delete',
      async handler(req, res) {
        if (req.method !== 'POST') {
          return json(res, { error: 'method not allowed' }, 405);
        }
        try {
          const input = JSON.parse(await readBody(req));
          if (!input.syncId && !input.notificationId) {
            return json(res, { error: 'missing task identity' }, 400);
          }
          const pending = syncSupervisor.snapshot().active;
          if (
            input.notificationId &&
            pending?.notificationId === input.notificationId &&
            pending.workspaceId === input.workspaceId &&
            pending.requirementId === input.requirementId &&
            !pending.id
          ) {
            syncSupervisor.remove(pending);
            return json(res, { success: true });
          }
          const workspace = registry.list().find((item) => item.id === input.workspaceId);
          const cachedPath = getCachedRequirementPath(input.workspaceId, input.requirementId);
          if ((!workspace && !cachedPath) || !input.requirementId) {
            return json(res, { error: 'workspace or requirement not found' }, 404);
          }
          const config = await loadConfig();
          const reqDir =
            cachedPath ||
            (await findRequirementDir(
              resolve(workspace.path, config.docsDir || 'docs'),
              input.requirementId,
            ));
          if (!reqDir) {
            return json(res, { error: 'requirement not found' }, 404);
          }
          await loadState(input.workspaceId, input.requirementId, reqDir);
          let task = input.syncId
            ? await getSyncById(input.syncId, input.workspaceId, input.requirementId)
            : null;
          if (
            !task &&
            input.syncId &&
            pending?.id === input.syncId &&
            pending.workspaceId === input.workspaceId &&
            pending.requirementId === input.requirementId
          ) {
            task = pending;
          }
          if (!task && input.notificationId) {
            const active = syncSupervisor.snapshot().active;
            if (
              active?.notificationId === input.notificationId &&
              active.workspaceId === input.workspaceId &&
              active.requirementId === input.requirementId
            ) {
              syncSupervisor.remove(active);
              return json(res, { success: true });
            }
          }
          if (!task) {
            syncSupervisor.remove({
              id: input.syncId,
              snapshotDir: input.snapshotDir,
              workspaceId: input.workspaceId,
              requirementId: input.requirementId,
              notificationId: input.notificationId,
            });
            return json(res, { success: true });
          }
          if (input.snapshotDir !== task.snapshotDir) {
            return json(res, { error: 'SYNC_TASK_SWITCHED_REFRESH_STATUS' }, 409);
          }
          const deleted = await removeSyncTask(task, { wholeTask: input.scope === 'task' });
          for (const execution of deleted) {
            const cleanup = await planSyncTaskCleanup(reqDir, execution);
            const owner = syncSupervisor.owner;
            if (owner?.task?.id === execution.id) {
              owner.cleanup = cleanup;
            }
            syncSupervisor.remove(execution);
            await library.store.unpin(
              JSON.stringify([
                execution.workspaceId,
                execution.requirementId,
                execution.snapshotDir,
              ]),
              await library.policy(),
            );
            await cleanup();
          }
          json(res, { success: true });
        } catch (error) {
          log.sync.error(msg('LOG_DELETE_SYNC_TASK_FAILED', { v0: error.message }));
          json(res, { error: error.message }, error.statusCode || 500);
        }
      },
    },
    {
      kind: 'exact',
      path: '/req-hub/sync-overview',
      async handler(req, res) {
        if (req.method !== 'GET') {
          return json(res, { error: 'method not allowed' }, 405);
        }
        try {
          await syncSupervisor.check();
          await reconcileOrphans();
          json(res, syncSupervisor.snapshot());
        } catch (error) {
          json(res, { error: error.message }, 500);
        }
      },
    },
    {
      kind: 'exact',
      path: '/req-hub/sync-design-references',
      async handler(req, res) {
        if (req.method !== 'GET') {
          return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
        }
        const input = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        const directory = await referenceDirectory(input.workspaceId, input.requirementId);
        const files = await listDesignReferences(directory, input.query || '');
        return json(res, { files });
      },
    },
    {
      kind: 'exact',
      path: '/req-hub/quick-sync-status',
      async handler(req, res) {
        if (req.method !== 'GET') {
          return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
        }
        const input = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        const workspace = registry.list().find((item) => item.id === input.workspaceId);
        if (!workspace || !input.requirementId || !input.id) {
          return json(res, { error: 'SYNC_WORKSPACE_NOT_FOUND' }, 404);
        }
        const config = await loadConfig();
        const reqDir = await findRequirementDir(
          resolve(workspace.path, config.docsDir || 'docs'),
          input.requirementId,
        );
        if (!reqDir) {
          return json(res, { error: 'SYNC_REQUIREMENT_NOT_FOUND' }, 404);
        }
        await loadState(workspace.id, input.requirementId, reqDir);
        await syncSupervisor.check();
        await reconcileOrphans();
        const snapshot = syncSupervisor.snapshot();
        const belongs = (item) =>
          item?.id === input.id &&
          item.workspaceId === workspace.id &&
          item.requirementId === input.requirementId;
        const tasks = [
          await getActiveSync(workspace.id, input.requirementId),
          ...(await getSyncHistory(workspace.id, input.requirementId)),
        ].filter((task) => task?.quickSyncId === input.id);
        let quickSync = [snapshot.quickSync, syncSupervisor.latestQuickSync].find(belongs);
        if (!quickSync && tasks.length) {
          const latest = tasks.find((task) => task.docType === 'design') || tasks[0];
          const finished = latest.docType === 'design' && latest.status === 'completed';
          let status = 'failed';
          if (finished) {
            status = 'completed';
          } else if (latest.status === 'aborted') {
            status = 'aborted';
          }
          quickSync = {
            id: input.id,
            workspaceId: workspace.id,
            requirementId: input.requirementId,
            stage: latest.docType,
            status,
            error: finished ? undefined : latest.error || 'SYNC_SEQUENCE_INTERRUPTED',
            documents: tasks.map(({ id, docType, status, snapshotDir }) => ({
              id,
              docType,
              status,
              snapshotDir,
            })),
          };
        }
        if (!quickSync) {
          return json(res, { error: 'SYNC_SEQUENCE_NOT_FOUND' }, 404);
        }
        const current = [snapshot.active, snapshot.latest].find(
          (task) =>
            task?.quickSyncId === input.id &&
            task.workspaceId === workspace.id &&
            task.requirementId === input.requirementId,
        );
        return json(res, { quickSync, sync: current || tasks[0] || null });
      },
    },
    {
      kind: 'exact',
      path: '/req-hub/sync-storage',
      async handler(req, res) {
        if (!['GET', 'POST'].includes(req.method)) {
          return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
        }
        const input =
          req.method === 'POST'
            ? JSON.parse(await readBody(req))
            : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        const workspace = registry.list().find((item) => item.id === input.workspaceId);
        if (!workspace) {
          return json(res, { error: 'SYNC_WORKSPACE_NOT_FOUND' }, 404);
        }
        const config = await loadConfig();
        const scope = storage.bindWorkspace(workspace);
        let collected;
        if (req.method === 'POST') {
          const removed = storage.prune(scope.workspaceKey, config.sync);
          for (const task of removed) {
            await library.store.unpin(
              JSON.stringify([task.workspaceId, task.requirementId, task.snapshotDir]),
              await library.policy(),
            );
          }
          await releaseDeleted(scope.workspaceKey);
          collected = storage.collect(scope.workspaceKey);
        }
        return json(res, { success: true, usage: storage.usage(scope.workspaceKey), collected });
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/git-branch',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');

        if (!workspaceId) {
          json(res, { error: 'missing workspaceId' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find((w) => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        try {
          const { exec } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execAsync = promisify(exec);

          const { stdout } = await execAsync('git branch --show-current', { cwd: workspace.path });
          const branch = stdout.trim();

          json(res, { branch: branch || null });
        } catch (e) {
          json(res, { branch: null });
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/sync-branches',
      async handler(req, res) {
        if (req.method !== 'GET') {
          return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
        }
        const url = new URL(req.url, 'http://localhost');
        const workspace = registry
          .list()
          .find((item) => item.id === url.searchParams.get('workspaceId'));
        if (!workspace) {
          return json(res, { error: 'SYNC_WORKSPACE_NOT_FOUND' }, 404);
        }
        try {
          const query = (url.searchParams.get('query') || '').trim().toLowerCase();
          const branches = (await listSyncBranches(workspace.path)).filter(
            (name) => parseBranchName(name)?.developer && name.toLowerCase().includes(query),
          );
          const result = { branches };
          if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 2 * 1024 * 1024) {
            return json(res, { error: 'SYNC_BRANCH_LIST_TOO_LARGE' }, 413);
          }
          return json(res, result);
        } catch (error) {
          return json(
            res,
            {
              error:
                error.message === 'SYNC_WORKSPACE_REPOSITORY_MISMATCH'
                  ? error.message
                  : 'SYNC_BRANCH_LIST_FAILED',
            },
            400,
          );
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/sync-branch-info',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const requirementId = url.searchParams.get('requirementId');

        if (!workspaceId || !requirementId) {
          json(res, { error: 'missing workspaceId or requirementId' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find((w) => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        try {
          // Find target branch for this requirement
          const baseBranch = await defaultSyncBaseBranch(workspace.path);
          let targetBranch = null;
          let targetBranchError = null;
          try {
            targetBranch = await findBranchByRequirement(
              workspace.path,
              requirementId,
              undefined,
              url.searchParams.get('targetBranch') ?? undefined,
            );
          } catch (error) {
            targetBranchError = error.message;
          }

          json(res, {
            targetBranch,
            baseBranch,
            baseBranchHint: baseBranch ? null : 'SYNC_DEFAULT_BRANCH_NOT_FOUND',
            targetBranchError,
            currentBranch: targetBranch || 'STATUS_NOT_FOUND',
          });
        } catch (e) {
          json(res, { error: e.message });
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/sync-commits',
      async handler(req, res) {
        if (req.method !== 'GET') {
          return json(res, { error: 'method not allowed' }, 405);
        }
        const url = new URL(req.url, 'http://localhost');
        const workspace = registry.list().find((w) => w.id === url.searchParams.get('workspaceId'));
        if (!workspace) {
          return json(res, { error: 'workspace not found' }, 404);
        }
        const requirementId = url.searchParams.get('requirementId');
        if (!requirementId) {
          return json(res, { error: 'missing requirementId' }, 400);
        }
        try {
          const targetBranch = await findBranchByRequirement(
            workspace.path,
            requirementId,
            undefined,
            url.searchParams.get('targetBranch') ?? undefined,
          );
          const baseBranch =
            url.searchParams.get('baseBranch')?.trim() ||
            (await defaultSyncBaseBranch(workspace.path));
          if (!baseBranch) {
            return json(res, { error: 'SYNC_DEFAULT_BRANCH_NOT_FOUND' }, 400);
          }
          return json(res, await listSyncCommits(workspace.path, targetBranch, baseBranch));
        } catch (error) {
          return json(res, { error: error.message }, 400);
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/sessions',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const query = url.searchParams.get('query') || '';
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);

        if (!workspaceId) {
          json(res, { error: 'missing workspaceId' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find((w) => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        try {
          if (!(await library.list(workspaceId, dsh)).workspace) {
            await library.refresh(workspaceId, workspaceId, dsh);
          }
          const sessionsList = (await library.list(workspaceId, dsh)).sessions
            .filter((item) => !query || item.title.toLowerCase().includes(query.toLowerCase()))
            .slice(0, Math.max(0, Math.min(limit || 20, 200)));
          json(res, { sessions: sessionsList });
        } catch (e) {
          log.sync.error(msg('LOG_GET_SESSION_LIST_FAILED', { v0: e.message }));
          json(res, { error: e.message }, 500);
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/session-info',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const sessionId = url.searchParams.get('sessionId');

        if (!sessionId) {
          json(res, { error: 'missing sessionId' }, 400);
          return;
        }

        try {
          // Prefer sessionQuery because it includes persisted sessions.
          if (sessionQuery) {
            try {
              const titleObservation = await sessionQuery.readTitleSnapshot(sessionId);
              if (titleObservation && titleObservation.session) {
                const header = titleObservation.session;
                json(res, {
                  session: {
                    id: header.id,
                    title: titleObservation.title?.title || 'STATUS_UNTITLED',
                    cwd: header.cwd || '',
                    createdAt: header.createdAt,
                    parentSession: header.parentSession || null,
                  },
                });
                return;
              }
            } catch (e) {
              // Fall back to the live session service when the persisted query fails.
              log.sync.debug(msg('LOG_SESSION_QUERY_GET_SESSION_FAILED', { v0: e.message }));
            }
          }

          if (!sessions) {
            log.sync.error('SESSION_SERVICES_UNAVAILABLE');
            json(res, { error: 'SESSION_SERVICE_UNAVAILABLE' }, 500);
            return;
          }

          const session = sessions.get(sessionId);
          if (!session) {
            log.sync.error(msg('ERR_SESSION_NOT_FOUND_OR_CLOSED_DETAIL', { v0: sessionId }));
            json(res, { error: 'ERR_SESSION_NOT_FOUND_OR_CLOSED', sessionId }, 404);
            return;
          }

          const header = session.header;
          log.sync.debug('LOG_ACTIVE_SESSION_FOUND', { sessionId, cwd: header.cwd });

          json(res, {
            session: {
              id: header.id,
              title: 'STATUS_CURRENT_SESSION',
              cwd: header.cwd || '',
              createdAt: header.createdAt,
              parentSession: header.parentSession || null,
            },
          });
        } catch (e) {
          log.sync.error(msg('LOG_GET_SESSION_DETAIL_FAILED', { v0: e.message }));
          json(res, { error: e.message }, 500);
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/current-session',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          if (sessionQuery) {
            try {
              const allRecords = await sessionQuery.listSessions();

              if (!allRecords || allRecords.length === 0) {
                json(res, { session: null, debug: { message: 'SESSION_NONE_FOUND' } });
                return;
              }

              // Exclude child sessions when choosing the current root session.
              const mainRecords = allRecords
                .filter((r) => !r.header.parentSession)
                .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0));

              if (mainRecords.length === 0) {
                json(res, { session: null, debug: { message: 'SESSION_NO_MAIN_FOUND' } });
                return;
              }

              const latest = mainRecords[0];
              const header = latest.header;

              let title = 'STATUS_UNTITLED';
              try {
                const titleSnapshot = await sessionQuery.readTitle(header.id);
                title = titleSnapshot?.title || 'STATUS_UNTITLED';
              } catch (e) {
                // Keep the fallback title when the optional title snapshot cannot be read.
              }

              json(res, {
                session: {
                  id: header.id,
                  title,
                  cwd: header.cwd || '',
                  createdAt: header.createdAt,
                  parentSession: header.parentSession || null,
                  isLive: latest.live,
                },
              });
              return;
            } catch (e) {
              log.sync.debug(msg('LOG_SESSION_QUERY_GET_CURRENT_FAILED', { v0: e.message }));
            }
          }

          if (!sessions) {
            json(res, { error: 'SESSION_SERVICES_UNAVAILABLE' }, 500);
            return;
          }

          const allSessions = sessions.list();

          if (!allSessions || allSessions.length === 0) {
            json(res, { session: null, debug: { message: 'SESSION_NO_ACTIVE_FOUND' } });
            return;
          }

          const mainSessions = allSessions
            .filter((s) => !s.header.parentSession)
            .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0));

          if (mainSessions.length === 0) {
            json(res, {
              session: null,
              debug: {
                message: 'SESSION_NO_MAIN_FOUND',
                totalSessions: allSessions.length,
              },
            });
            return;
          }

          const latestSession = mainSessions[0];
          const header = latestSession.header;

          json(res, {
            session: {
              id: header.id,
              title: 'STATUS_CURRENT_SESSION',
              cwd: header.cwd || '',
              createdAt: header.createdAt,
              parentSession: header.parentSession || null,
            },
          });
        } catch (e) {
          log.sync.error(msg('LOG_GET_CURRENT_SESSION_FAILED', { v0: e.message }));
          json(res, { error: e.message }, 500);
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/session-turns',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const sessionId = url.searchParams.get('sessionId');

        if (!sessionId) {
          json(res, { error: 'missing sessionId' }, 400);
          return;
        }

        try {
          const workspaceId = url.searchParams.get('workspaceId');
          if (!registry.list().some((item) => item.id === workspaceId)) {
            return json(res, { error: 'WORKSPACE_MISSING' }, 404);
          }
          const snapshot = sessionId.startsWith('codex:')
            ? await codex.snapshot(sessionId, workspaceId)
            : await dshSnapshot(workspaceId, sessionId);
          if (url.searchParams.get('version') !== snapshot.version) {
            return json(res, { success: false, error: 'SESSION_CHANGED' }, 409);
          }
          json(res, { success: true, ...snapshot });
        } catch (e) {
          log.sync.error(msg('LOG_GET_SESSION_TURNS_FAILED', { v0: e.message }));
          json(res, { success: false, error: e.message }, e.statusCode || 500);
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/phased-sync',
      operation: { action: 'phased-sync', methods: ['POST'], execute: syncApplication.execute },
      async handler(req, res) {
        if (req.method !== 'POST') {
          return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
        }
        try {
          const input = JSON.parse(await readBody(req, 10 * 1024 * 1024));
          const result = await syncApplication.execute(
            input,
            {
              agent: req.operationExec?.agent || agents?.get(req.headers['x-session-id']),
              signal: req.operationExec?.signal,
            },
            (event) => {
              if (res.destroyed || res.writableEnded) {
                return;
              }
              if (!res.headersSent) {
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  Connection: 'keep-alive',
                });
              }
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            },
          );
          if (!res.headersSent) {
            return json(res, result.value, result.status);
          }
          res.end();
        } catch (error) {
          if (!res.headersSent) {
            return json(res, { error: error.message }, error.status || 500);
          }
          res.end();
        }
      },
    },

    // POST /sync-abort - Abort a running sync task
    {
      kind: 'exact',
      path: '/req-hub/sync-abort',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const raw = await readBody(req);
          const { workspaceId, requirementId, syncId, snapshotDir } = JSON.parse(raw);
          const preparingOwner = syncSupervisor.owner;
          if (
            preparingOwner?.fields.workspaceId === workspaceId &&
            preparingOwner.fields.requirementId === requirementId &&
            [
              preparingOwner.notificationId,
              preparingOwner.fields.requestId,
              preparingOwner.task?.id,
            ]
              .filter(Boolean)
              .includes(syncId) &&
            (!snapshotDir || preparingOwner.task?.snapshotDir === snapshotDir)
          ) {
            preparingOwner.controller.abort(new Error('SYNC_USER_CANCELLED'));
            if (preparingOwner.task) {
              await abortSync(preparingOwner.task.id, workspaceId, requirementId);
            }
            return json(res, { success: true, status: 'cancelling' });
          }
          if (snapshotDir) {
            const task = await getSyncById(syncId, workspaceId, requirementId);
            if (!task || task.snapshotDir !== snapshotDir) {
              return json(res, { success: false, error: 'SYNC_TASK_SWITCHED_REFRESH_STATUS' }, 409);
            }
          }

          if (!workspaceId || !requirementId || !syncId) {
            json(res, { error: 'missing workspaceId, requirementId or syncId' }, 400);
            return;
          }

          // Get parentAgent for interrupt authority
          // DSH requires { kind: 'ancestor', agent: parentAgent } for interrupt()
          const sessionId = req.headers['x-session-id'];
          const parentAgent = sessionId ? agents?.get(sessionId) : null;

          // Pass ctx and parentAgent for interrupting subagent
          const owner = syncSupervisor.owner;
          if (
            owner?.quickSync &&
            owner.fields.workspaceId === workspaceId &&
            owner.fields.requirementId === requirementId &&
            owner.quickSync.documents.some(
              (task) => task.id === syncId && (!snapshotDir || task.snapshotDir === snapshotDir),
            )
          ) {
            owner.controller.abort();
            const activeId = owner.task?.id;
            if (activeId) {
              await abortSync(activeId, workspaceId, requirementId, ctx, parentAgent);
            }
            return json(res, { success: true, status: 'cancelling' });
          }
          const result = await abortSync(syncId, workspaceId, requirementId, ctx, parentAgent);
          json(res, result, result.success ? 200 : 400);
        } catch (e) {
          log.sync.error(msg('SYNC_ABORT_TASK_FAILED', { v0: e.message }));
          json(res, { success: false, error: e.message }, 500);
        }
      },
    },

    // GET /sync-active - Get active sync task
    {
      kind: 'exact',
      path: '/req-hub/sync-active',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const requirementId = url.searchParams.get('requirementId');

        if (!workspaceId || !requirementId) {
          json(res, { error: 'missing workspaceId or requirementId' }, 400);
          return;
        }

        try {
          const workspace = registry.list().find((w) => w.id === workspaceId);
          if (!workspace) {
            json(res, { active: false, sync: null });
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
          await safeDocumentPath(workspace.path, relative(workspace.path, docsRoot));
          const reqDir = await findRequirementDir(docsRoot, requirementId);

          if (reqDir) {
            await loadState(workspaceId, requirementId, reqDir);
          }

          await syncSupervisor.check();
          await reconcileOrphans();
          const overview = syncSupervisor.snapshot().active;
          const activeSync =
            (await getActiveSync(workspaceId, requirementId)) ||
            (overview?.workspaceId === workspaceId && overview.requirementId === requirementId
              ? overview
              : null);
          json(res, { active: !!activeSync, sync: activeSync });
        } catch (e) {
          log.sync.error(msg('SYNC_GET_ACTIVE_FAILED', { v0: e.message }));
          json(res, { active: false, sync: null });
        }
      },
    },

    // GET /sync-history - Get sync history list
    {
      kind: 'exact',
      path: '/req-hub/sync-history',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const requirementId = url.searchParams.get('requirementId');

        if (!workspaceId || !requirementId) {
          json(res, { error: 'missing workspaceId or requirementId' }, 400);
          return;
        }

        try {
          // Find workspace and requirement directory to load state from disk
          const workspace = registry.list().find((w) => w.id === workspaceId);
          if (workspace) {
            const config = await loadConfig();
            const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
            const reqDir = await findRequirementDir(docsRoot, requirementId);

            if (reqDir) {
              // Load state from disk before querying history
              await loadState(workspaceId, requirementId, reqDir);
            }
          }

          const history = await getSyncHistory(workspaceId, requirementId);
          const overview = syncSupervisor.snapshot().active;
          const activeSync =
            (await getActiveSync(workspaceId, requirementId)) ||
            (overview?.workspaceId === workspaceId && overview.requirementId === requirementId
              ? overview
              : null);
          json(res, { history, activeSync, timeline: buildSyncTimeline(history) });
        } catch (e) {
          log.sync.error(msg('SYNC_GET_HISTORY_FAILED', { v0: e.message }));
          json(res, { error: e.message }, e.statusCode || 500);
        }
      },
    },

    // GET /sync-history/:id - Get specific sync detail
    {
      kind: 'exact',
      path: '/req-hub/sync-detail',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const syncId = url.searchParams.get('id');
        const workspaceId = url.searchParams.get('workspaceId');
        const requirementId = url.searchParams.get('requirementId');

        if (!syncId || !workspaceId || !requirementId) {
          json(res, { error: 'missing sync id, workspaceId, or requirementId' }, 400);
          return;
        }

        const workspace = registry.list().find((item) => item.id === workspaceId);
        if (!workspace) {
          return json(res, { error: 'SYNC_WORKSPACE_NOT_FOUND' }, 404);
        }
        const config = await loadConfig();
        const reqDir = await findRequirementDir(
          resolve(workspace.path, config.docsDir || 'docs'),
          requirementId,
        );
        if (!reqDir) {
          return json(res, { error: 'SYNC_REQUIREMENT_NOT_FOUND' }, 404);
        }
        await loadState(workspaceId, requirementId, reqDir);
        const sync = await getSyncById(syncId, workspaceId, requirementId);

        if (!sync) {
          json(res, { error: 'sync not found' }, 404);
          return;
        }

        json(res, { sync });
      },
    },

    // GET /sync-file - Read a generated file
    {
      kind: 'exact',
      path: '/req-hub/sync-file',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const requirementId = url.searchParams.get('requirementId');
        const artifactId = url.searchParams.get('artifactId');
        const attemptId = url.searchParams.get('attemptId');

        if (!workspaceId || !requirementId || !artifactId || !attemptId) {
          json(res, { error: 'missing parameters' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find((w) => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        try {
          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
          const reqDir = await findRequirementDir(docsRoot, requirementId);

          if (!reqDir) {
            json(res, { error: 'requirement directory not found' }, 404);
            return;
          }

          await safeDocumentPath(workspace.path, relative(workspace.path, docsRoot));
          await safeDocumentPath(docsRoot, relative(docsRoot, reqDir));
          await loadState(workspaceId, requirementId, reqDir);
          const task = await getSyncById(attemptId, workspaceId, requirementId);
          if (!task) {
            return json(res, { error: 'SYNC_ATTEMPT_NOT_FOUND' }, 404);
          }
          json(res, storage.readArtifact(task, artifactId));
        } catch (e) {
          log.sync.error(`Failed to read sync file: ${e.message}`);
          json(res, { error: e.message }, e.statusCode || e.status || 500);
        }
      },
    },

    // GET /sync-version-diff - Get document content for two sync versions for diff comparison
    {
      kind: 'exact',
      path: '/req-hub/sync-version-diff',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const requirementId = url.searchParams.get('requirementId');
        const syncId1 = url.searchParams.get('syncId1');
        const syncId2 = url.searchParams.get('syncId2');

        if (!workspaceId || !requirementId || !syncId1 || !syncId2) {
          json(res, { error: 'missing parameters' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find((w) => w.id === workspaceId);
        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        try {
          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
          const reqDir = await findRequirementDir(docsRoot, requirementId);
          if (!reqDir) {
            json(res, { error: 'requirement directory not found' }, 404);
            return;
          }

          await loadState(workspaceId, requirementId, reqDir);
          const history = await getSyncHistory(workspaceId, requirementId);
          json(
            res,
            await compareSyncSnapshots(
              reqDir,
              history,
              syncId1,
              syncId2,
              clock.configTimeZone(config),
            ),
          );
        } catch (e) {
          log.sync.error(msg('SYNC_VERSION_COMPARE_FAILED', { v0: e.message }));
          json(
            res,
            { error: e.code === 'ENOENT' ? 'SYNC_SUCCESS_SNAPSHOT_MISSING' : e.message },
            e.statusCode || (e.code === 'ENOENT' ? 404 : 500),
          );
        }
      },
    },
  ];
  let disposal;
  const phasedRoute = routes.find((route) => route.path === '/req-hub/phased-sync');
  routes.push({
    kind: 'exact',
    path: '/req-hub/sync-retry',
    handler: phasedRoute.handler,
    operation: { ...phasedRoute.operation, action: 'sync-retry' },
  });
  routes.application = syncApplication;
  routes.beginClose = () => {
    closed = true;
    const owner = syncSupervisor.owner?.scope === ownerScope ? syncSupervisor.owner : null;
    owner?.controller.abort();
    for (const controller of controllers.keys()) {
      controller.abort();
    }
  };
  routes.dispose = () =>
    (disposal ||= (async () => {
      routes.beginClose();
      clearInterval(watchdog);
      const owner = syncSupervisor.owner?.scope === ownerScope ? syncSupervisor.owner : null;
      owner?.controller.abort();
      for (const [controller, task] of controllers) {
        controller.abort();
        await abortSync(task.id, task.workspaceId, task.requirementId);
      }
      const grace = setTimeout(() => {
        if (owner) {
          void syncSupervisor
            .expire(owner, 'SYNC_SHUTDOWN_TIMEOUT')
            .catch((error) => log.sync.error(error.message));
        }
      }, syncSupervisor.limits.cancelling);
      const stoppingLibrary = library.close();
      try {
        await Promise.allSettled([...pendingSyncs, ...pendingRequests, stoppingLibrary]);
      } finally {
        clearTimeout(grace);
        if (!options.codexService) {
          await codex.close();
        }
        await library.store.close();
        storageLease.release();
      }
    })());
  for (const route of routes) {
    const handler = route.handler;
    route.handler = (req, res) => {
      if (closed) {
        return json(res, { error: 'SESSION_SERVICE_CLOSED' }, 503);
      }
      const pending = (async () => {
        try {
          await retire();
          if (closed) {
            return json(res, { error: 'SESSION_SERVICE_CLOSED' }, 503);
          }
          return await handler(req, res);
        } catch (error) {
          if (route.path === '/req-hub/sync-storage') {
            log.sync.error('SYNC_STORAGE_REQUEST_FAILED: ' + error.message);
          }
          json(res, { error: error.message }, error.statusCode || error.status || 500);
        }
      })();
      pendingRequests.add(pending);
      return pending.finally(() => pendingRequests.delete(pending));
    };
  }
  return routes;
}
