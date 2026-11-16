import { msg } from '../messages.js';
import { freezeKnowledgeContext } from '../knowledge/enhancements/knowledge-context.js';
import { matchesWorkspacePath } from '../conversations/workspace-path.js';
import {
  listDesignReferences,
  freezeDesignReference,
  publishedRequirementReference,
} from '../sync-design-reference.js';
import { safeDocumentPath } from '../safe-path.js';
import taskModel from '../../shared/sync-task.cjs';
import { SyncLifecycle } from '../sync-lifecycle.js';
import { syncSupervisor } from '../sync-supervisor.js';
import { retainSyncStorage } from '../sync-storage.js';
import { planSyncTaskCleanup } from '../sync-task-cleanup.js';
import { installSyncTools } from '../sync-controlled-tools.js';
import { readDocumentVersion, publishDocument, atomicWrite } from '../sync-document-validator.js';
/**
 * Document sync routes module.
 * Handles document synchronization HTTP endpoints.
 * All LLM calls are delegated to DSH Subagent.
 * @module routes/sync-routes
 */

import { resolve, relative } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { findRequirementDir } from '../doc-reader.js';
import { findBranchByRequirement, beginCommitSync } from '../sync-engine.js';
import { defaultSyncBaseBranch, listSyncCommits, listSyncBranches } from '../sync-branches.js';
import { buildSyncTimeline } from '../sync-timeline.js';
import { compareSyncSnapshots } from '../sync-snapshots.js';
import clock from '../../shared/time.cjs';
import { PhasedSyncEngine } from '../phased-sync-engine.js';
import { extractMultipleSessionTurns } from '../session-utils.js';
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
  setAbortController,
  deleteAbortController,
  abortSync,
  recoverSyncTask,
  getAbortController,
  getCachedActiveSyncs,
  removeSyncTask,
  isSyncTaskRemoved,
  getCachedRequirementPath,
} from '../sync-state.js';
import { estimateTextTokens } from '../token-utils.js';
import { syncCancellation } from '../sync-cancellation.js';
import { readRetryArtifact } from '../sync-retry.js';
import { setActiveSync } from '../sync-state.js';

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
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        // Resolve delegation ownership from the authenticated calling session.
        const sessionId = req.headers['x-session-id'];

        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024 * 10) {
            req.destroy();
          }
        });
        let detachRequest;
        const detached = new Promise((resolve) => {
          detachRequest = resolve;
        });

        const requestController = new AbortController();
        const parentSignal = req.operationExec?.signal;
        const cancelParent = () => requestController.abort(parentSignal.reason);
        if (parentSignal?.aborted) {
          cancelParent();
        } else {
          parentSignal?.addEventListener('abort', cancelParent, { once: true });
        }
        const executeSync = () =>
          syncCancellation.run(requestController.signal, async () => {
            let syncTask;
            let syncId;
            let lifecycle;
            let abortController;
            let sendEvent = () => {};
            let workspaceId;
            let requirementId;
            let lease;
            let quickRequirementReference;
            let retrySource;
            let retryFrozen;
            let preparationScope;
            try {
              let input = JSON.parse(body);
              if (input.retrySyncId) {
                const directory = await referenceDirectory(input.workspaceId, input.requirementId);
                await loadState(input.workspaceId, input.requirementId, directory);
                retrySource = await getSyncById(
                  input.retrySyncId,
                  input.workspaceId,
                  input.requirementId,
                );
                if (
                  !retrySource ||
                  !['failed', 'aborted'].includes(retrySource.status) ||
                  retrySource.snapshotDir !== input.snapshotDir ||
                  taskModel.hasPublishedDocument(retrySource)
                ) {
                  throw Object.assign(new Error('SYNC_RETRY_INVALID'), { statusCode: 409 });
                }
                if (
                  input.retryChunkIndex !== undefined &&
                  (!Number.isInteger(input.retryChunkIndex) ||
                    input.retryChunkIndex < 0 ||
                    !input.retryPhase)
                ) {
                  throw Object.assign(new Error('SYNC_RETRY_NODE_INVALID'), { statusCode: 400 });
                }
                if (input.retryPhase) {
                  const step = retrySource.steps?.find((item) => item.phase === input.retryPhase);
                  const unit =
                    input.retryChunkIndex === undefined
                      ? step
                      : step?.chunks?.[input.retryChunkIndex];
                  if (!unit || !['failed', 'aborted'].includes(unit.status)) {
                    throw Object.assign(new Error('SYNC_RETRY_NODE_INVALID'), { statusCode: 409 });
                  }
                }
                retryFrozen = readRetryArtifact(storage, retrySource, 'retry.input');
                input = {
                  ...(retrySource.retryRequest || retrySource),
                  workspaceId: input.workspaceId,
                  requirementId: input.requirementId,
                  requestId: input.requestId,
                  quick: false,
                };
              }
              if (
                input.requestId !== undefined &&
                (typeof input.requestId !== 'string' ||
                  !/^[a-zA-Z0-9-]{1,128}$/.test(input.requestId))
              ) {
                throw Object.assign(new Error('SYNC_REQUEST_INVALID'), { statusCode: 400 });
              }
              const { docType: requestedDocType, sessionIds: requestedSessionIds = [] } = input;
              const docType = input.quick === true ? 'requirement' : requestedDocType;
              const sessionIds = input.quick === true ? [] : requestedSessionIds;
              ({ workspaceId, requirementId } = input);

              if (!workspaceId || !requirementId || !docType) {
                json(res, { error: 'Missing workspaceId, requirementId, or docType' }, 400);
                return;
              }

              const workspaces = registry.list();
              const workspace = workspaces.find((w) => w.id === workspaceId);

              if (!workspace) {
                json(res, { error: 'Workspace not found' }, 404);
                return;
              }

              await syncSupervisor.check();
              lease = syncSupervisor.acquire(
                {
                  requestId: input.requestId,
                  workspaceId,
                  requirementId,
                  docType,
                  docTypeName:
                    docType === 'requirement' ? 'DOC_REQUIREMENT' : 'DOC_TECHNICAL_DESIGN',
                },
                requestController,
              );
              if (!lease) {
                return json(
                  res,
                  {
                    active: true,
                    sync: syncSupervisor.snapshot().active,
                    message: 'SYNC_TASK_ALREADY_RUNNING',
                  },
                  409,
                );
              }
              lease.scope = ownerScope;
              if (input.quick === true) {
                syncSupervisor.beginQuick(lease);
              }
              lease.onRecovered = (reason) => {
                syncSupervisor.finishQuick(lease, lease.deleted ? 'aborted' : 'failed', reason);
                if (syncTask) {
                  deleteAbortController(workspaceId, requirementId, syncId, abortController);
                }
                controllers.delete(abortController);
                if (res.headersSent && !res.writableEnded && !res.destroyed) {
                  try {
                    res.write(
                      `data: ${JSON.stringify(lease.deleted ? { type: 'deleted', syncId, snapshotDir: syncTask?.snapshotDir } : { type: 'error', error: reason, sync: lease.notice || syncTask, quickSync: lease.quickSync })}\n\n`,
                    );
                  } catch (error) {
                    // A disconnected client cannot receive the terminal event; cleanup still proceeds.
                  }
                }
                try {
                  res.end();
                } catch (error) {
                  // Ending an already disconnected response is best effort.
                }
                detachRequest();
              };
              abortController = lease.controller;
              lease.revoke = () => installSyncTools(ctx)?.revoke(abortController.signal);
              const onPreparation = (activity) => syncSupervisor.preparing(lease, activity);
              onPreparation({ stage: 'preparing' });

              let quickBaseBranch;
              if (input.quick === true) {
                await findBranchByRequirement(
                  workspace.path,
                  requirementId,
                  undefined,
                  input.targetBranch ?? '',
                );
                quickBaseBranch = await defaultSyncBaseBranch(workspace.path);
                if (!quickBaseBranch) {
                  throw Object.assign(new Error('SYNC_BASE_BRANCH_MISSING'), { statusCode: 400 });
                }
              }

              const documentTypes = input.quick === true ? ['requirement', 'design'] : [docType];
              for (const docType of documentTypes) {
                syncSupervisor.assert(lease);
                syncTask = undefined;
                syncId = undefined;
                lifecycle = undefined;
                const config = await loadConfig();
                const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
                const reqDir = await findRequirementDir(docsRoot, requirementId);
                if (!reqDir) {
                  throw Object.assign(new Error('SYNC_REQUIREMENT_NOT_FOUND'), { statusCode: 404 });
                }
                preparationScope = { input, workspace, docsRoot, reqDir, docType };
                syncSupervisor.assert(lease);
                if (!llm) {
                  throw Object.assign(new Error('SYNC_LLM_UNAVAILABLE'), { statusCode: 503 });
                }
                if (
                  !Array.isArray(sessionIds) ||
                  sessionIds.some((id) => typeof id !== 'string') ||
                  new Set(sessionIds).size !== sessionIds.length
                ) {
                  return json(res, { error: 'SESSION_SELECTION_INVALID' }, 400);
                }
                onPreparation({ stage: 'sessions' });
                const codexIds = sessionIds.filter((id) => id.startsWith('codex:'));
                if (!retryFrozen && codexIds.length) {
                  const cached = await codex.list(workspaceId);
                  const allowed = new Set(
                    (cached.sessions || [])
                      .filter((entry) => matchesWorkspacePath({ path: entry.cwd }, workspace.path))
                      .map((entry) => entry.id),
                  );
                  if (codexIds.some((id) => !allowed.has(id))) {
                    throw Object.assign(new Error('CODEX_SESSION_WORKSPACE_MISMATCH'), {
                      statusCode: 403,
                    });
                  }
                }
                const codexSnapshots = new Map(
                  (retryFrozen
                    ? []
                    : await codex.snapshots(codexIds, workspaceId, {
                        signal: requestController.signal,
                      })
                  ).map((snapshot) => [snapshot.sessionId, snapshot]),
                );
                const dshIds = sessionIds.filter((id) => !id.startsWith('codex:'));
                syncSupervisor.assert(lease);
                if (
                  !retryFrozen &&
                  dshIds.length &&
                  !(await library.list(workspaceId, dsh)).workspace
                ) {
                  await library.refresh(workspaceId, workspaceId, dsh, undefined, {
                    signal: requestController.signal,
                  });
                }
                const dshSnapshots = new Map(
                  (retryFrozen
                    ? []
                    : await library.snapshots(workspaceId, dshIds, dsh, {
                        signal: requestController.signal,
                      })
                  ).map((snapshot) => [snapshot.sessionId, snapshot]),
                );
                syncSupervisor.assert(lease);
                const sessionInput =
                  retryFrozen?.sessionInput ||
                  (await extractMultipleSessionTurns(sessionQuery, sessionIds, {
                    sessions,
                    readSnapshot: (id) => codexSnapshots.get(id) || dshSnapshots.get(id),
                  }));
                for (const snapshot of sessionInput.snapshots) {
                  if (input.sessionVersions?.[snapshot.sessionId] !== snapshot.version) {
                    return json(res, { error: 'SESSION_CHANGED' }, 409);
                  }
                  if (!snapshot.syncTurnCount) {
                    return json(
                      res,
                      { error: msg('SESSION_EMPTY', { v0: snapshot.sessionId }) },
                      400,
                    );
                  }
                }
                const docTypeName =
                  docType === 'requirement' ? 'DOC_REQUIREMENT' : 'DOC_TECHNICAL_DESIGN';

                let designReference = retryFrozen?.designReference;
                if (docType === 'design' && !designReference) {
                  if (input.quick === true) {
                    if (!quickRequirementReference) {
                      throw new Error('SYNC_REFERENCE_MISSING');
                    }
                    designReference = quickRequirementReference;
                  } else if (
                    input.designReferencePath !== undefined &&
                    input.designReferencePath !== ''
                  ) {
                    const directory = await referenceDirectory(workspaceId, requirementId);
                    designReference = await freezeDesignReference(
                      directory,
                      input.designReferencePath,
                      abortController.signal,
                    );
                  }
                }
                const referenceMetadata = designReference
                  ? { ...designReference, text: undefined }
                  : undefined;

                const hasSessions = sessionIds.length > 0;
                const fields = {
                  workspaceId,
                  workspace,
                  docsRoot,
                  requirementId,
                  docType,
                  docTypeName,
                  ...(referenceMetadata ? { designReference: referenceMetadata } : {}),
                  requirementPath: relative(docsRoot, reqDir).replaceAll('\\', '/'),
                  sessionIds,
                  conversationStorageVersion: 1,
                  ownerProfile: library.owner,
                  sessionSnapshots: sessionInput.snapshots.map(
                    ({ sessionId, conversationId, version, syncTurnCount }) => ({
                      sessionId,
                      conversationId,
                      version,
                      syncTurnCount,
                    }),
                  ),
                  targetBranch: input.targetBranch,
                  baseBranch:
                    quickBaseBranch ||
                    input.baseBranch?.trim() ||
                    (await defaultSyncBaseBranch(workspace.path)),
                  commitHashes: input.commitHashes,
                  branchTip: input.branchTip,
                  baseCommit: input.baseCommit,
                  includeWorkingChanges:
                    input.quick === true ? false : input.includeWorkingChanges !== false,
                  startedAt: Date.now(),
                  ...(lease.quickSync ? { quickSyncId: lease.quickSync.id } : {}),
                  status: 'running', // running | completed | failed
                  steps: taskModel.createSyncSteps({ sessionIds }),
                  generatedFiles: [],
                  retryRequest: { ...input, docType, quick: false },
                  ...(retrySource ? { retryOf: retrySource.id } : {}),
                };

                if (closed) {
                  throw new Error('SYNC_PLUGIN_UNLOADING');
                }
                syncSupervisor.assert(lease);
                await loadState(workspaceId, requirementId, reqDir);
                const orphan = await getActiveSync(workspaceId, requirementId);
                if (orphan) {
                  await recoverSyncTask(orphan, 'SYNC_OWNER_MISSING_ORIGINAL');
                }
                const staleController = getAbortController(workspaceId, requirementId);
                if (staleController) {
                  staleController.controller.abort();
                  deleteAbortController(
                    workspaceId,
                    requirementId,
                    staleController.syncId,
                    staleController.controller,
                  );
                }
                let prepared = await beginCommitSync(workspace.path, reqDir, fields, {
                  signal: abortController.signal,
                  onProgress: onPreparation,
                  frozen: retryFrozen?.prepared,
                });
                syncSupervisor.assert(lease);
                if (prepared.active) {
                  await recoverSyncTask(prepared.sync, 'SYNC_OWNER_MISSING_ORIGINAL');
                  prepared = await beginCommitSync(workspace.path, reqDir, fields, {
                    signal: abortController.signal,
                    onProgress: onPreparation,
                  });
                }
                if (prepared.skipped && lease.quickSync) {
                  lease.quickSync.documents.push({ docType, status: 'skipped' });
                  if (docType === 'requirement') {
                    const directory = await referenceDirectory(workspaceId, requirementId);
                    quickRequirementReference = await freezeDesignReference(
                      directory,
                      'requirement.md',
                      abortController.signal,
                    );
                    syncSupervisor.advanceQuick(lease, 'design');
                    continue;
                  }
                  syncSupervisor.finishQuick(lease, 'completed');
                  if (res.headersSent) {
                    sendEvent({
                      type: 'done',
                      sync: lease.notice,
                      quickSync: lease.quickSync,
                      skipped: true,
                    });
                    res.end();
                  } else {
                    json(res, { ...prepared, quickSync: lease.quickSync });
                  }
                  return;
                }
                if (prepared.active && lease.quickSync) {
                  throw Object.assign(new Error('SYNC_SEQUENCE_CONFLICT'), { statusCode: 409 });
                }
                if (prepared.active || prepared.skipped) {
                  json(res, prepared);
                  return;
                }
                syncTask = prepared.sync;
                await library.store.pin(
                  JSON.stringify([workspaceId, requirementId, syncTask.snapshotDir]),
                  sessionInput.snapshots.filter((snapshot) => snapshot.conversationId),
                );
                syncId = syncTask.id;
                syncSupervisor.attach(lease, syncTask, (reason) =>
                  recoverSyncTask(syncTask, reason),
                );
                controllers.set(abortController, syncTask);
                if (closed) {
                  abortController.abort();
                }
                setAbortController(workspaceId, requirementId, abortController, syncId);
                const { branchName, commits, codeDiff, uncommittedChanges, sourceSnapshots } =
                  prepared;

                // Set up SSE
                if (!res.headersSent) {
                  res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                  });
                }

                sendEvent = (data) => {
                  if (syncSupervisor.owner !== lease) {
                    return;
                  }
                  syncSupervisor.touch(lease);
                  if (res.destroyed || res.writableEnded) {
                    return;
                  }
                  try {
                    res.write(
                      `data: ${JSON.stringify({
                        ...data,
                        ...(lease.quickSync ? { quickSync: lease.quickSync } : {}),
                      })}\n\n`,
                    );
                  } catch (error) {
                    log.sync.debug(
                      msg('SYNC_CONNECTION_LOST_TASK_PERSISTING', { v0: error.message }),
                    );
                  }
                };
                lifecycle = new SyncLifecycle(syncTask, sendEvent);
                const updateStep = (phase, updates) => lifecycle.step(phase, updates);
                const addFile = (phase, fileName, logicalId) =>
                  lifecycle.file(phase, storage.artifact(syncTask, fileName, { logicalId }));

                sendEvent({ type: 'sync_started', syncId, commitHash: syncTask.commitHash });
                await updateStep('init', {
                  status: 'running',
                  text: 'SYNC_READING_FROZEN_COMMITS',
                });

                // Read current document
                const docFileName = docType === 'requirement' ? 'requirement.md' : 'design.md';
                const docPath = join(reqDir, docFileName);

                const originalVersion = retryFrozen?.originalVersion
                  ? {
                      exists: retryFrozen.originalVersion.exists,
                      bytes: Buffer.from(retryFrozen.originalVersion.base64, 'base64'),
                    }
                  : await readDocumentVersion(docPath);
                const currentDoc = originalVersion.bytes.toString('utf8');
                const isNewDoc = !originalVersion.exists;

                const initText = [];
                if (commits && commits.length > 0) {
                  initText.push(msg('SYNC_COMMIT_COUNT', { v0: commits.length }));
                } else {
                  initText.push('SYNC_NO_COMMITS');
                }
                if (uncommittedChanges.hasChanges) {
                  const parts = [];
                  if (uncommittedChanges.staged) {
                    parts.push('STATUS_STAGED');
                  }
                  if (uncommittedChanges.unstaged) {
                    parts.push('STATUS_UNSTAGED');
                  }
                  if (uncommittedChanges.untracked.length > 0) {
                    parts.push(
                      msg('SYNC_NEW_FILE_COUNT', { v0: uncommittedChanges.untracked.length }),
                    );
                  }
                  initText.push(msg('SYNC_UNCOMMITTED_CHANGES', { v0: parts }));
                }
                if (isNewDoc) {
                  initText.push('SYNC_NEW_DOCUMENT');
                }

                // ─── Step 2: Session Extract ──────────────────────────
                const sessionTurns = sessionInput.turns;
                if (sessionIds.length > 0) {
                  await updateStep('init', {
                    status: 'running',
                    text: msg('SYNC_EXTRACT_SESSION_CONTENT', { v0: sessionIds.length }),
                  });

                  try {
                    await updateStep('init', {
                      status: 'running',
                      text: msg('SYNC_TURNS_EXTRACTED_CHECK_BUDGET', { v0: sessionTurns.length }),
                    });
                  } catch (e) {
                    log.sync.warn(msg('SYNC_EXTRACT_SESSION_CONTENT_FAILED', { v0: e.message }));
                    throw msg('SYNC_SESSION_EXTRACTION_FAILED', { v0: e.message });
                  }
                }

                // ─── Step 3-5: Run phased sync engine ────────────────

                const syncDir = storage.attemptRoot(syncTask, true);

                // Scheduled runs delegate through a dedicated background agent.
                // Prefer that owned agent: looking it up in the live session
                // registry would fail for workspaces without an active session.
                const parentAgent = req.operationExec?.agent || agents?.get(sessionId);
                if (!parentAgent) {
                  throw new Error('SESSION_NOT_ACTIVE');
                }

                if (abortController.signal.aborted) {
                  throw new Error('SYNC_TERMINATED');
                }

                const engine = new PhasedSyncEngine({
                  llm,
                  config,
                  cwd: workspace.path,
                  ctx,
                  parentAgent,
                  signal: abortController.signal,
                  storage,
                  task: syncTask,
                  retrySource,
                  onActivity: () => syncSupervisor.touch(lease),
                  assertActive: () => {
                    syncSupervisor.assert(lease);
                    storage.assert(syncTask);
                  },
                });

                await updateStep('init', {
                  status: 'running',
                  text: 'SYNC_CALCULATE_CHUNK_BUDGET',
                });
                const knowledgeContext =
                  retryFrozen?.knowledgeContext ||
                  (await freezeKnowledgeContext(
                    options.knowledgeV2?.context,
                    input.knowledgeScopeIds,
                    input.knowledgeQuery || requirementId,
                    abortController.signal,
                    input.knowledgeReferenceRefs,
                  ));
                syncSupervisor.assert(lease);
                const { sync: preparedTask, ...frozenPrepared } = prepared;
                storage.putEvidence(
                  syncTask,
                  'retry.input',
                  JSON.stringify({
                    prepared: frozenPrepared,
                    sessionInput,
                    designReference,
                    originalVersion: {
                      exists: originalVersion.exists,
                      base64: originalVersion.bytes.toString('base64'),
                    },
                    knowledgeContext,
                  }),
                );
                const preparedChunks = await engine.prepareSyncChunks({
                  docType,
                  currentDoc,
                  originalVersion,
                  commits,
                  codeDiff,
                  sourceSnapshots,
                  sessionTurns,
                  knowledgeContext,
                  designReference,
                  syncContext: {
                    taskId: syncId,
                    branchName,
                    targetSha: syncTask.commitHash,
                    baseSha: syncTask.baselineCommit,
                    attempt: syncTask.snapshotDir,
                  },
                  hasUncommitted: uncommittedChanges.hasChanges,
                  syncDir,
                  onPreparation: (activity) => updateStep('init', { activity }),
                });
                if (knowledgeContext.length) {
                  await lifecycle.metadata({
                    knowledgeRefs: knowledgeContext.map(({ text, ...reference }) => reference),
                  });
                }
                for (const reference of knowledgeContext) {
                  await addFile('init', reference.id + '.json', reference.id);
                }
                if (designReference) {
                  await addFile('init', 'design-reference.json', 'design.reference');
                }
                await addFile('init', 'input-code.diff', 'code.input');
                await addFile('init', 'manifest.json');
                for (const entry of preparedChunks.store.entries.values()) {
                  if (entry.file.startsWith('sessions/')) {
                    await addFile('init', entry.file.replaceAll('/', '-'), entry.id);
                  }
                }
                await updateStep('code_analysis', {
                  chunks: preparedChunks.code.map((c) => ({
                    index: c.index,
                    tokens: c.tokens,
                    inputBudget: c.inputBudget,
                    files: c.details.map((d) => ({ file: d.file, tokens: d.tokens })),
                  })),
                });
                if (hasSessions) {
                  await updateStep('discussion_analysis', {
                    chunks: preparedChunks.discussion.map((c) => ({
                      index: c.index,
                      tokens: c.tokens,
                      inputBudget: c.inputBudget,
                      turns: c.details,
                    })),
                  });
                }
                await updateStep('init', {
                  status: 'completed',
                  text: [
                    ...initText,
                    msg('SYNC_CHUNK_BUDGET_CHECK_PASSED', {
                      v0: preparedChunks.code.length,
                      v1: preparedChunks.discussion.length,
                    }),
                  ],
                  inputBudget: preparedChunks.budget,
                  sourceTokens: estimateTextTokens(codeDiff),
                  hasUncommitted: uncommittedChanges.hasChanges,
                });

                const result = await engine.sync({
                  preparedChunks,
                  originalVersion,
                  sourceSnapshots,
                  docType,
                  currentDoc,
                  commits,
                  codeDiff,
                  sessionTurns,
                  hasUncommitted: uncommittedChanges.hasChanges,
                  reqDir,
                  syncDir,
                  onProgress: async (progress) => {
                    if (progress.status === 'output_file') {
                      return addFile(progress.phase, progress.fileName);
                    }
                    await lifecycle.progress(progress);
                  },
                });

                if (result.aborted || abortController.signal.aborted) {
                  throw new Error('SYNC_TERMINATED');
                }
                if (result.errors?.length || typeof result.mergedDoc !== 'string') {
                  const failure = new Error(
                    result.errors?.map((item) => item.error).join('；') ||
                      'SYNC_NO_VALID_DOC_SNAPSHOT',
                  );
                  failure.phase = result.errors?.[0]?.phase;
                  throw failure;
                }
                if (result.patchFile) {
                  await addFile('merge', result.patchFile);
                }
                if (result.appliedDiffFile) {
                  await addFile('merge', result.appliedDiffFile);
                }
                if (
                  result.schemaVersion !== 2 ||
                  !result.validation ||
                  !Buffer.isBuffer(result.candidateBytes)
                ) {
                  throw new Error('SYNC_V2_RESULT_REQUIRED');
                }
                await lifecycle.metadata({
                  originalHash: result.validation.originalHash,
                  candidateHash: result.validation.candidateHash,
                  publishState: 'prepared',
                });
                await updateStep('publish', {
                  status: 'running',
                  text: 'SYNC_CHECK_VERSION_AND_PUBLISH',
                });
                syncSupervisor.assert(lease);
                await publishDocument({
                  docPath,
                  syncDir: join(syncDir, 'outputs'),
                  fileName: docFileName,
                  original: originalVersion,
                  candidateBytes: result.candidateBytes,
                  validation: result.validation,
                  signal: abortController.signal,
                  assertActive: () => {
                    syncSupervisor.assert(lease);
                    storage.assert(syncTask);
                  },
                });
                await lifecycle.metadata({ publishState: 'document_written' });
                if (options.knowledgeV2?.sync) {
                  try {
                    await options.knowledgeV2.sync.capture(
                      workspaceId,
                      relative(docsRoot, docPath),
                    );
                  } catch (error) {
                    await lifecycle.metadata({
                      knowledge: { status: 'failed', code: 'KB_SYNC_FAILED' },
                    });
                  }
                }
                await updateStep('publish', {
                  status: 'completed',
                  text: 'SYNC_PUBLISHED_DOC_MATCHES_SNAPSHOT',
                });
                await addFile('merge', docFileName);

                await lifecycle.metadata({ stats: result.stats, publishState: 'state_committed' });

                try {
                  const journalPath = storage.file(syncTask, 'publish-journal.json');
                  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
                  await atomicWrite(
                    journalPath,
                    JSON.stringify({ ...journal, stage: 'state_committed' }, null, 2),
                    abortController.signal,
                    () => {
                      syncSupervisor.assert(lease);
                      storage.assert(syncTask);
                    },
                  );
                } catch (error) {
                  log.sync.warn(msg('SYNC_PUBLISH_JOURNAL_FINALIZE_FAILED', { v0: error.message }));
                }

                abortController.signal.throwIfAborted();
                await lifecycle.finish();
                log.sync.info(
                  msg('SYNC_PHASED_SYNC_FINISHED', { v0: docTypeName, v1: syncTask.status }),
                );

                if (lease.quickSync) {
                  lease.quickSync.documents.push({
                    docType,
                    status: syncTask.status,
                    id: syncTask.id,
                    snapshotDir: syncTask.snapshotDir,
                    workspaceId,
                    requirementId,
                  });
                  if (syncTask.status !== 'completed') {
                    throw new Error(syncTask.error || 'SYNC_DOCUMENT_NOT_COMPLETED');
                  }
                  if (docType === 'requirement') {
                    quickRequirementReference = publishedRequirementReference(
                      result.candidateBytes,
                      syncTask.id,
                    );
                    sendEvent({ type: 'document_done', sync: syncTask });
                    deleteAbortController(workspaceId, requirementId, syncId, abortController);
                    controllers.delete(abortController);
                    syncSupervisor.advanceQuick(lease, 'design');
                    continue;
                  }
                  syncSupervisor.finishQuick(lease, 'completed');
                }
                sendEvent({
                  type: 'done',
                  sync: syncTask,
                  status: syncTask.status,
                  syncId,
                  docType,
                  stats: result.stats,
                  files: syncTask.generatedFiles,
                });
                res.end();
              }
            } catch (e) {
              const rejectionStatus = e.statusCode || e.status;
              const inputRejected = rejectionStatus >= 400 && rejectionStatus < 500;
              if (
                !syncTask &&
                lease &&
                preparationScope &&
                !lease.deleted &&
                (!inputRejected || lease.controller.signal.aborted)
              ) {
                try {
                  const { workspace, docsRoot, reqDir, docType, input } = preparationScope;
                  await loadState(workspaceId, requirementId, reqDir);
                  if (!(await getActiveSync(workspaceId, requirementId))) {
                    syncTask = {
                      schemaVersion: 2,
                      workspaceId,
                      requirementId,
                      docType,
                      docTypeName:
                        docType === 'design' ? 'DOC_TECHNICAL_DESIGN' : 'DOC_REQUIREMENT',
                      taskId: 'preparing-' + docType,
                      startedAt: lease.startedAt,
                      status: 'running',
                      steps: taskModel.createSyncSteps({ sessionIds: input.sessionIds }),
                      retryRequest: { ...input, docType, quick: false },
                      generatedFiles: [],
                    };
                    await setActiveSync(syncTask, reqDir);
                    syncId = syncTask.id;
                    lease.task = syncTask;
                  }
                } catch (error) {
                  log.sync.error('SYNC_PREPARATION_STATE_FAILED: ' + error.message);
                }
              }
              log.sync.error(msg('SYNC_PHASED_SYNC_FAILED', { v0: e.message }));
              syncSupervisor.finishQuick(
                lease,
                abortController?.signal.aborted ? 'aborted' : 'failed',
                e.message,
              );

              if (syncTask && !isSyncTaskRemoved(syncTask)) {
                lifecycle ||= new SyncLifecycle(syncTask, sendEvent);
                try {
                  await lifecycle.finish({
                    status: abortController?.signal.aborted ? 'aborted' : 'failed',
                    error: e.message,
                    phase: e.phase,
                  });
                } catch (persistError) {
                  log.sync.error(
                    msg('SYNC_PERSIST_FINAL_STATE_FAILED', { v0: persistError.message }),
                  );
                }
              }

              if (res.headersSent) {
                try {
                  sendEvent({
                    type: 'error',
                    error: e.message,
                    sync: lease?.notice || syncTask,
                    quickSync: lease?.quickSync,
                  });
                } catch (error) {
                  // A disconnected client cannot receive the error event; cleanup still proceeds.
                }
              } else {
                let status;
                if (
                  ['SYNC_BRANCH_INVALID', 'SYNC_WORKSPACE_REPOSITORY_MISMATCH'].includes(e.message)
                ) {
                  status = 400;
                } else if (/^(?:COMMIT_LIST_CHANGED|INPUT_CHANGED):/.test(e.message)) {
                  status = 409;
                } else if (
                  /^(?:COMMIT_OUT_OF_RANGE|COMMIT_SELECTION_INVALID|BASE_BRANCH_)/.test(e.message)
                ) {
                  status = 400;
                } else {
                  status = 500;
                }
                json(
                  res,
                  { error: e.message, ...(syncTask ? { sync: syncTask } : {}) },
                  e.statusCode || e.status || status,
                );
              }
              try {
                res.end();
              } catch (error) {
                // Ending an already disconnected response is best effort.
              }
            } finally {
              parentSignal?.removeEventListener('abort', cancelParent);
              if (syncTask) {
                deleteAbortController(workspaceId, requirementId, syncId, abortController);
              }
              controllers.delete(abortController);
              if (lease) {
                syncSupervisor.finishQuick(
                  lease,
                  abortController?.signal.aborted ? 'aborted' : 'failed',
                  'SYNC_SEQUENCE_INCOMPLETE',
                );
                syncSupervisor.release(lease);
              }
              if (lease?.deleted) {
                await lease
                  .cleanup?.()
                  .catch((error) =>
                    log.sync.debug(msg('SYNC_DELETE_TASK_CLEANUP', { v0: error.message })),
                  );
              }
            }
          });
        req.on('end', () => {
          const execution = Promise.race([executeSync(), detached]);
          pendingSyncs.add(execution);
          void execution
            .finally(() => pendingSyncs.delete(execution))
            .catch((error) => log.sync.error(error.message));
          return execution;
        });
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
  routes.push({ kind: 'exact', path: '/req-hub/sync-retry', handler: phasedRoute.handler });
  routes.dispose = () =>
    (disposal ||= (async () => {
      closed = true;
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
