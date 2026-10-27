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
import { defaultSyncBaseBranch, listSyncCommits } from '../sync-branches.js';
import { buildSyncTimeline } from '../sync-timeline.js';
import { compareSyncSnapshots } from '../sync-snapshots.js';
import { PhasedSyncEngine } from '../phased-sync-engine.js';
import { extractMultipleSessionTurns } from '../session-utils.js';
import { CodexSessionService } from '../codex-sessions/service.js';
import { createCodexSessionRoutes } from './codex-session-routes.js';
import { ConversationStore, conversationDatabasePath } from '../conversations/store.js';
import { ConversationService } from '../conversations/service.js';
import { dshSource } from '../conversations/dsh-source.js';
import { createConversationRoutes } from './conversation-routes.js';
import { createConversationKnowledgeRoutes } from './conversation-knowledge-routes.js';
import { removeRetiredCodexStore } from '../conversations/retired-storage.js';
import { homedir } from 'node:os';
import { json, readBody } from '../utils.js';
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
  const storageLease = retainSyncStorage(options.syncStorageRoot), storage = storageLease.store;
  const releaseDeleted = async workspaceKey => {
    for (const task of storage.deleted(workspaceKey)) {
      await library.store.unpin(JSON.stringify([task.workspaceId, task.requirementId, task.snapshotDir]), await library.policy());
      storage.cleanup(task);
    }
  };
  const loadState = async (workspaceId, requirementId, reqDir) => {
    const workspace = registry.list().find(item => item.id === workspaceId);
    if (!workspace) throw new Error('SYNC_WORKSPACE_NOT_FOUND');
    const config = await loadConfig();
    await library.store.unpinRetiredSync(workspaceId);
    const state = await loadSyncState(workspaceId, requirementId, reqDir, { workspace, docsRoot: resolve(workspace.path, config.docsDir || 'docs'), store: storage });
    const scope = getSyncScope(workspaceId, requirementId);
    for (const removed of storage.prune(scope.workspaceKey, config.sync)) await library.store.unpin(JSON.stringify([removed.workspaceId, removed.requirementId, removed.snapshotDir]), await library.policy());
    await releaseDeleted(scope.workspaceKey);
    storage.collect(scope.workspaceKey);
    return state;
  };
  // 从 ctx 获取 sessionQuery 服务
  const sessionQuery = ctx?.sessionQuery;
  const profile = ctx?.get?.('profileContext');
  const library = new ConversationService({ store: new ConversationStore(options.conversationDatabasePath || conversationDatabasePath(profile?.home)), owner: profile?.dir || process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || 'default', policy: async () => (await loadConfig()).conversations || {} });
  const dsh = dshSource({ registry, sessionQuery, sessions, instance: library.owner });
  const codex = options.codexService || new CodexSessionService({ ...options.codex, library });
  const adapters = [dsh, codex.adapter].filter(Boolean);
  let retirement;
  const retire = () => retirement ||= (async () => {
    await removeRetiredCodexStore(profile?.home || process.env.DSH_HOME || join(homedir(), '.dsh'));
    const config = await loadConfig();
    for (const workspace of registry.list()) {
      const docs = resolve(workspace.path, config.docsDir || 'docs');
      await safeDocumentPath(workspace.path, relative(workspace.path, docs), { allowMissing: true });
      const visit = async directory => {
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (entries.some(entry => entry.name === 'sync-logs')) {
          storage.retire(storage.bind(workspace, relative(docs, directory).replaceAll('\\', '/'), directory, docs));
        }
        for (const entry of entries) if (entry.name !== 'sync-logs' && entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(directory, entry.name));
      };
      await visit(docs);
      await library.store.unpinRetiredSync(workspace.id);
    }
  })().catch(error => { retirement = undefined; throw error; });
  const dshSnapshot = async (workspaceId, id) => {
    if (!(await library.list(workspaceId, dsh)).workspace) await library.refresh(workspaceId, workspaceId, dsh);
    return library.snapshot(workspaceId, id, dsh);
  };

  const pendingSyncs = new Set(), controllers = new Map(), pendingRequests = new Set();
  let closed = false;
  const ownerScope = {};
  const reconcileOrphans = async () => {
    for (const task of getCachedActiveSyncs()) {
      const owner = syncSupervisor.owner;
      if (owner && owner.fields.workspaceId === task.workspaceId && owner.fields.requirementId === task.requirementId
        && (!owner.task || owner.task.id === task.id && owner.task.snapshotDir === task.snapshotDir)) continue;
      await recoverSyncTask(task, 'SYNC_OWNER_MISSING: 同步任务已无执行者，已回收残留状态');
      syncSupervisor.remember(task);
    }
  };
  const watchdog = setInterval(() => { storage.heartbeat(); void syncSupervisor.check().catch(error => log.sync.error('任务监管恢复失败：' + error.message)); }, 15000);
  watchdog.unref?.();
  const routes = [
    ...createCodexSessionRoutes(registry, codex),
    ...createConversationRoutes(registry, library, adapters),
    ...createConversationKnowledgeRoutes(registry, library, adapters, options.knowledgeService),
    {
      kind: 'exact', path: '/req-hub/sync-delete',
      async handler(req, res) {
        if (req.method !== 'POST') return json(res, { error: 'method not allowed' }, 405);
        try {
          const input = JSON.parse(await readBody(req));
          if (!input.syncId && !input.notificationId) return json(res, { error: 'missing task identity' }, 400);
          const pending = syncSupervisor.snapshot().active;
          if (input.notificationId && pending?.notificationId === input.notificationId && pending.workspaceId === input.workspaceId && pending.requirementId === input.requirementId && !pending.id) {
            syncSupervisor.remove(pending); return json(res, { success: true });
          }
          const workspace = registry.list().find(item => item.id === input.workspaceId);
          const cachedPath = getCachedRequirementPath(input.workspaceId, input.requirementId);
          if ((!workspace && !cachedPath) || !input.requirementId) return json(res, { error: 'workspace or requirement not found' }, 404);
          const config = await loadConfig(), reqDir = cachedPath || await findRequirementDir(resolve(workspace.path, config.docsDir || 'docs'), input.requirementId);
          if (!reqDir) return json(res, { error: 'requirement not found' }, 404);
          await loadState(input.workspaceId, input.requirementId, reqDir);
          let task = input.syncId ? await getSyncById(input.syncId, input.workspaceId, input.requirementId) : null;
          if (!task && input.syncId && pending?.id === input.syncId && pending.workspaceId === input.workspaceId && pending.requirementId === input.requirementId) task = pending;
          if (!task && input.notificationId) {
            const active = syncSupervisor.snapshot().active;
            if (active?.notificationId === input.notificationId && active.workspaceId === input.workspaceId && active.requirementId === input.requirementId) {
              syncSupervisor.remove(active); return json(res, { success: true });
            }
          }
          if (!task) {
            syncSupervisor.remove({ id: input.syncId, snapshotDir: input.snapshotDir, workspaceId: input.workspaceId, requirementId: input.requirementId, notificationId: input.notificationId });
            return json(res, { success: true });
          }
          if (input.snapshotDir !== task.snapshotDir) return json(res, { error: '同步任务已切换，请刷新状态' }, 409);
          const deleted = await removeSyncTask(task, { wholeTask: input.scope === 'task' });
          for (const execution of deleted) {
            const cleanup = await planSyncTaskCleanup(reqDir, execution);
            const owner = syncSupervisor.owner;
            if (owner?.task?.id === execution.id) owner.cleanup = cleanup;
            syncSupervisor.remove(execution);
            await library.store.unpin(JSON.stringify([execution.workspaceId, execution.requirementId, execution.snapshotDir]), await library.policy());
            await cleanup();
          }
          json(res, { success: true });
        } catch (error) { log.sync.error('删除同步任务失败：' + error.message); json(res, { error: error.message }, error.statusCode || 500); }
      },
    },
    {
      kind: 'exact', path: '/req-hub/sync-overview',
      async handler(req, res) {
        if (req.method !== 'GET') return json(res, { error: 'method not allowed' }, 405);
        try { await syncSupervisor.check(); await reconcileOrphans(); json(res, syncSupervisor.snapshot()); }
        catch (error) { json(res, { error: error.message }, 500); }
      },
    },
    {
      kind: 'exact', path: '/req-hub/sync-storage',
      async handler(req, res) {
        if (!['GET', 'POST'].includes(req.method)) return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
        const input = req.method === 'POST' ? JSON.parse(await readBody(req)) : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
        const workspace = registry.list().find(item => item.id === input.workspaceId);
        if (!workspace) return json(res, { error: 'SYNC_WORKSPACE_NOT_FOUND' }, 404);
        const config = await loadConfig();
        const scope = storage.bindWorkspace(workspace);
        let collected;
        if (req.method === 'POST') {
          const removed = storage.prune(scope.workspaceKey, config.sync);
          for (const task of removed) await library.store.unpin(JSON.stringify([task.workspaceId, task.requirementId, task.snapshotDir]), await library.policy());
          await releaseDeleted(scope.workspaceKey);
          collected = storage.collect(scope.workspaceKey);
        }
        return json(res, { success: true, usage: storage.usage(scope.workspaceKey), collected });
      },
    },
    // GET /git-branch - 获取 Git 分支信息
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
        const workspace = workspaces.find(w => w.id === workspaceId);

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
      }
    },

    // GET /sync-branch-info - 获取同步分支信息（目标分支和基准分支）
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
        const workspace = workspaces.find(w => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        try {
          // Find target branch for this requirement
          const baseBranch = await defaultSyncBaseBranch(workspace.path);
          let targetBranch = null, targetBranchError = null;
          try { targetBranch = await findBranchByRequirement(workspace.path, requirementId); }
          catch (error) { targetBranchError = error.message; }

          json(res, {
            targetBranch,
            baseBranch,
            baseBranchHint: baseBranch ? null : '未找到 main 或 master 分支，请手动填写基准分支。',
            targetBranchError,
            currentBranch: targetBranch || '未找到'
          });
        } catch (e) {
          json(res, { error: e.message });
        }
      }
    },

    {
      kind: 'exact', path: '/req-hub/sync-commits',
      async handler(req, res) {
        if (req.method !== 'GET') return json(res, { error: 'method not allowed' }, 405);
        const url = new URL(req.url, 'http://localhost');
        const workspace = registry.list().find(w => w.id === url.searchParams.get('workspaceId'));
        if (!workspace) return json(res, { error: 'workspace not found' }, 404);
        const requirementId = url.searchParams.get('requirementId');
        if (!requirementId) return json(res, { error: 'missing requirementId' }, 400);
        try {
          const targetBranch = await findBranchByRequirement(workspace.path, requirementId);
          const baseBranch = url.searchParams.get('baseBranch')?.trim() || await defaultSyncBaseBranch(workspace.path);
          if (!baseBranch) return json(res, { error: '未找到 main 或 master 分支，请手动填写基准分支。' }, 400);
          return json(res, await listSyncCommits(workspace.path, targetBranch, baseBranch));
        } catch (error) { return json(res, { error: error.message }, 400); }
      }
    },

    // GET /sessions - 获取相关 DSH 会话列表
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
        const workspace = workspaces.find(w => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        try {
          if (!(await library.list(workspaceId, dsh)).workspace) await library.refresh(workspaceId, workspaceId, dsh);
          const sessionsList = (await library.list(workspaceId, dsh)).sessions.filter(item => !query || item.title.toLowerCase().includes(query.toLowerCase())).slice(0, Math.max(0, Math.min(limit || 20, 200)));
          json(res, { sessions: sessionsList });
        } catch (e) {
          log.sync.error(`获取会话列表失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    },

    // GET /session-info - 获取指定会话的详细信息
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
          // 优先使用 sessionQuery 服务（支持持久化会话）
          if (sessionQuery) {
            try {
              const titleObservation = await sessionQuery.readTitleSnapshot(sessionId);
              if (titleObservation && titleObservation.session) {
                const header = titleObservation.session;
                json(res, {
                  session: {
                    id: header.id,
                    title: titleObservation.title?.title || '(无标题)',
                    cwd: header.cwd || '',
                    createdAt: header.createdAt,
                    parentSession: header.parentSession || null,
                  }
                });
                return;
              }
            } catch (e) {
              // sessionQuery 失败，尝试 sessions 服务
              log.sync.debug(`sessionQuery 获取会话失败: ${e.message}，尝试 sessions 服务`);
            }
          }

          // 使用 sessions 服务获取活跃会话
          if (!sessions) {
            log.sync.error('sessions 和 sessionQuery 服务都不可用');
            json(res, { error: '会话服务不可用' }, 500);
            return;
          }

          // 尝试获取活跃会话
          const session = sessions.get(sessionId);
          if (!session) {
            log.sync.error(`会话不存在或已关闭: ${sessionId}`);
            json(res, { error: '会话不存在或已关闭', sessionId }, 404);
            return;
          }

          const header = session.header;
          log.sync.debug(`获取到活跃会话`, { sessionId, cwd: header.cwd });

          // 返回会话信息
          json(res, {
            session: {
              id: header.id,
              title: '(当前会话)', // 活跃会话没有标题存储
              cwd: header.cwd || '',
              createdAt: header.createdAt,
              parentSession: header.parentSession || null,
            }
          });
        } catch (e) {
          log.sync.error(`获取会话详情失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    },

    // GET /current-session - 获取当前会话信息（最近的会话）
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
          // 优先使用 sessionQuery 服务
          if (sessionQuery) {
            try {
              const allRecords = await sessionQuery.listSessions();

              if (!allRecords || allRecords.length === 0) {
                json(res, { session: null, debug: { message: '没有找到任何会话' } });
                return;
              }

              // 过滤主会话（没有 parentSession）
              const mainRecords = allRecords
                .filter(r => !r.header.parentSession)
                .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0));

              if (mainRecords.length === 0) {
                json(res, { session: null, debug: { message: '没有找到主会话' } });
                return;
              }

              const latest = mainRecords[0];
              const header = latest.header;

              // 获取标题
              let title = '(无标题)';
              try {
                const titleSnapshot = await sessionQuery.readTitle(header.id);
                title = titleSnapshot?.title || '(无标题)';
              } catch (e) {}

              json(res, {
                session: {
                  id: header.id,
                  title,
                  cwd: header.cwd || '',
                  createdAt: header.createdAt,
                  parentSession: header.parentSession || null,
                  isLive: latest.live,
                }
              });
              return;
            } catch (e) {
              log.sync.debug(`sessionQuery 获取当前会话失败: ${e.message}，尝试 sessions 服务`);
            }
          }

          // 后备：使用 sessions 服务
          if (!sessions) {
            json(res, { error: 'sessions 和 sessionQuery 服务都不可用' }, 500);
            return;
          }

          // 获取所有活跃会话
          const allSessions = sessions.list();

          if (!allSessions || allSessions.length === 0) {
            json(res, { session: null, debug: { message: '没有找到任何活跃会话' } });
            return;
          }

          // 过滤出主会话（没有 parentSession）并按创建时间排序
          const mainSessions = allSessions
            .filter(s => !s.header.parentSession)
            .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0));

          if (mainSessions.length === 0) {
            json(res, {
              session: null,
              debug: {
                message: '没有找到主会话',
                totalSessions: allSessions.length
              }
            });
            return;
          }

          // 使用最近的一个主会话
          const latestSession = mainSessions[0];
          const header = latestSession.header;

          json(res, {
            session: {
              id: header.id,
              title: '(当前会话)',
              cwd: header.cwd || '',
              createdAt: header.createdAt,
              parentSession: header.parentSession || null,
            }
          });
        } catch (e) {
          log.sync.error(`获取当前会话失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    },

    // GET /session-turns - 获取会话的轮次内容预览
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
          if (!registry.list().some(item => item.id === workspaceId)) return json(res, { error: 'WORKSPACE_MISSING' }, 404);
          const snapshot = sessionId.startsWith('codex:') ? await codex.snapshot(sessionId, workspaceId) : await dshSnapshot(workspaceId, sessionId);
          if (url.searchParams.get('version') !== snapshot.version) {
            return json(res, { success: false, error: 'SESSION_CHANGED: 会话已变化，请刷新会话列表后重新选择' }, 409);
          }
          json(res, { success: true, ...snapshot });
        } catch (e) {
          log.sync.error(`获取会话轮次失败: ${e.message}`);
          json(res, { success: false, error: e.message }, e.statusCode || 500);
        }
      }
    },

    // POST /phased-sync - 分阶段同步（代码 + 对话）
    {
      kind: 'exact',
      path: '/req-hub/phased-sync',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        // 从请求头获取当前会话 ID（用于获取 parentAgent）
        const sessionId = req.headers['x-session-id'];

        let body = '';
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 1024 * 1024 * 10) {
            req.destroy();
          }
        });
        let detachRequest;
        const detached = new Promise(resolve => { detachRequest = resolve; });

        const executeSync = async () => {
          let syncTask;
          let syncId;
          let lifecycle;
          let abortController;
          let sendEvent = () => {};
          let workspaceId;
          let requirementId;
          let lease;
          try {
            const input = JSON.parse(body);
            const { docType, sessionIds = [] } = input;
            ({ workspaceId, requirementId } = input);

            if (!workspaceId || !requirementId || !docType) {
              json(res, { error: 'Missing workspaceId, requirementId, or docType' }, 400);
              return;
            }

            const workspaces = registry.list();
            const workspace = workspaces.find(w => w.id === workspaceId);

            if (!workspace) {
              json(res, { error: 'Workspace not found' }, 404);
              return;
            }

            await syncSupervisor.check();
            lease = syncSupervisor.acquire({ workspaceId, requirementId, docType, docTypeName: docType === 'requirement' ? '需求文档' : '技术方案' });
            if (!lease) return json(res, { active: true, sync: syncSupervisor.snapshot().active, message: '已有同步任务正在运行，需求文档与技术方案共用一个执行名额' }, 409);
            lease.scope = ownerScope;
            lease.onRecovered = reason => {
              if (syncTask) deleteAbortController(workspaceId, requirementId, syncId, abortController);
              controllers.delete(abortController);
              if (res.headersSent && !res.writableEnded && !res.destroyed) {
                try { res.write(`data: ${JSON.stringify(lease.deleted ? { type: 'deleted', syncId, snapshotDir: syncTask?.snapshotDir } : { type: 'error', error: reason, sync: syncTask })}\n\n`); } catch { /* disconnected client */ }
              }
              try { res.end(); } catch { /* disconnected client */ }
              detachRequest();
            };
            abortController = lease.controller;
            lease.revoke = () => installSyncTools(ctx)?.revoke(abortController.signal);
            const onPreparation = activity => syncSupervisor.preparing(lease, activity);
            onPreparation({ stage: 'preparing' });

            const config = await loadConfig();
            const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
            const reqDir = await findRequirementDir(docsRoot, requirementId);
            if (!reqDir) { json(res, { error: '需求目录未找到' }, 404); return; }
            if (!llm) { json(res, { error: 'LLM 不可用' }, 503); return; }
            if (!Array.isArray(sessionIds) || sessionIds.some(id => typeof id !== 'string') || new Set(sessionIds).size !== sessionIds.length) {
              return json(res, { error: 'SESSION_SELECTION_INVALID: 会话选择无效' }, 400);
            }
            onPreparation({ stage: 'sessions' });
            const codexSnapshots = new Map((await codex.snapshots(sessionIds.filter(id => id.startsWith('codex:')), workspaceId)).map(snapshot => [snapshot.sessionId, snapshot]));
            const dshIds = sessionIds.filter(id => !id.startsWith('codex:'));
            if (dshIds.length && !(await library.list(workspaceId, dsh)).workspace) await library.refresh(workspaceId, workspaceId, dsh);
            const dshSnapshots = new Map((await library.snapshots(workspaceId, dshIds, dsh)).map(snapshot => [snapshot.sessionId, snapshot]));
            const sessionInput = await extractMultipleSessionTurns(sessionQuery, sessionIds, { sessions,
              readSnapshot: id => codexSnapshots.get(id) || dshSnapshots.get(id) });
            for (const snapshot of sessionInput.snapshots) {
              if (input.sessionVersions?.[snapshot.sessionId] !== snapshot.version) {
                return json(res, { error: 'SESSION_CHANGED: 会话已变化，请刷新会话列表后重新选择' }, 409);
              }
              if (!snapshot.syncTurnCount) return json(res, { error: `SESSION_EMPTY: ${snapshot.sessionId} 没有可同步的完整轮次` }, 400);
            }
            const docTypeName = docType === 'requirement' ? '需求文档' : '技术方案';

            const hasSessions = sessionIds.length > 0;
            const fields = {
              workspaceId,
              workspace,
              docsRoot,
              requirementId,
              docType,
              docTypeName,
              requirementPath: relative(docsRoot, reqDir).replaceAll('\\', '/'),
              sessionIds,
              conversationStorageVersion: 1,
              ownerProfile: library.owner,
              sessionSnapshots: sessionInput.snapshots.map(({ sessionId, conversationId, version, syncTurnCount }) => ({ sessionId, conversationId, version, syncTurnCount })),
              baseBranch: input.baseBranch?.trim() || await defaultSyncBaseBranch(workspace.path),
              commitHashes: input.commitHashes,
              branchTip: input.branchTip,
              baseCommit: input.baseCommit,
              includeWorkingChanges: input.includeWorkingChanges !== false,
              startedAt: lease.startedAt,
              status: 'running', // running | completed | failed
              steps: taskModel.createSyncSteps({ sessionIds }),
              generatedFiles: [],
            };

            if (closed) throw new Error('插件正在卸载，无法启动同步');
            syncSupervisor.assert(lease);
            await loadState(workspaceId, requirementId, reqDir);
            const orphan = await getActiveSync(workspaceId, requirementId);
            if (orphan) await recoverSyncTask(orphan, 'SYNC_OWNER_MISSING: 原同步任务已无执行者，已回收残留状态');
            const staleController = getAbortController(workspaceId, requirementId);
            if (staleController) {
              staleController.controller.abort();
              deleteAbortController(workspaceId, requirementId, staleController.syncId, staleController.controller);
            }
            let prepared = await beginCommitSync(workspace.path, reqDir, fields, { signal: abortController.signal, onProgress: onPreparation });
            syncSupervisor.assert(lease);
            if (prepared.active) {
              await recoverSyncTask(prepared.sync, 'SYNC_OWNER_MISSING: 原同步任务已无执行者，已回收残留状态');
              prepared = await beginCommitSync(workspace.path, reqDir, fields, { signal: abortController.signal, onProgress: onPreparation });
            }
            if (prepared.active || prepared.skipped) { json(res, prepared); return; }
            syncTask = prepared.sync;
            await library.store.pin(JSON.stringify([workspaceId, requirementId, syncTask.snapshotDir]), sessionInput.snapshots.filter(snapshot => snapshot.conversationId));
            syncId = syncTask.id;
            syncSupervisor.attach(lease, syncTask, reason => recoverSyncTask(syncTask, reason));
            controllers.set(abortController, syncTask);
            if (closed) abortController.abort();
            setAbortController(workspaceId, requirementId, abortController, syncId);
            const { branchName, commits, codeDiff, uncommittedChanges, sourceSnapshots } = prepared;

            // Set up SSE
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });

            sendEvent = data => {
              if (syncSupervisor.owner !== lease) return;
              syncSupervisor.touch(lease);
              if (res.destroyed || res.writableEnded) return;
              try { res.write(`data: ${JSON.stringify(data)}\n\n`); }
              catch (error) { log.sync.debug('同步连接已断开，任务继续持久化执行：' + error.message); }
            };
            lifecycle = new SyncLifecycle(syncTask, sendEvent);
            const updateStep = (phase, updates) => lifecycle.step(phase, updates);
            const addFile = (phase, fileName, logicalId) => lifecycle.file(phase, storage.artifact(syncTask, fileName, { logicalId }));

            sendEvent({ type: 'sync_started', syncId, commitHash: syncTask.commitHash });
            await updateStep('init', { status: 'running', text: '读取已冻结的需求分支提交...' });

            // Read current document
            const docFileName = docType === 'requirement' ? 'requirement.md' : 'design.md';
            const docPath = join(reqDir, docFileName);

            const originalVersion = await readDocumentVersion(docPath);
            const currentDoc = originalVersion.bytes.toString('utf8');
            const isNewDoc = !originalVersion.exists;

            // 构建初始化完成信息
            let initText = '';
            if (commits && commits.length > 0) {
              initText = `${commits.length} 个提交`;
            } else {
              initText = '无提交记录';
            }
            if (uncommittedChanges.hasChanges) {
              const parts = [];
              if (uncommittedChanges.staged) parts.push('已暂存');
              if (uncommittedChanges.unstaged) parts.push('未暂存');
              if (uncommittedChanges.untracked.length > 0) parts.push(`${uncommittedChanges.untracked.length} 个新文件`);
              initText += `，未提交变更: ${parts.join('、')}`;
            }
            if (isNewDoc) initText += '，新建文档';

            // ─── Step 2: Session Extract ──────────────────────────
            const sessionTurns = sessionInput.turns;
            if (sessionIds.length > 0) {
              await updateStep('init', { status: 'running', text: `提取 ${sessionIds.length} 个会话内容...` });

              try {
                await updateStep('init', {
                  status: 'running',
                  text: `${sessionTurns.length} 个轮次已提取，正在检查分块输入预算...`
                });
              } catch (e) {
                log.sync.warn(`提取会话内容失败: ${e.message}`);
                throw new Error(`会话提取失败: ${e.message}`);
              }
            }

            // ─── Step 3-5: Run phased sync engine ────────────────
            // 创建同步目录（提前创建，用于保存中间结果）
            const syncDir = storage.attemptRoot(syncTask, true);

            // 获取父 Agent（用于 subagent 委托）
            const parentAgent = agents?.get(sessionId);
            if (!parentAgent) throw new Error('会话不存在或已结束，请在活跃的 DSH 会话中调用此功能');

            if (abortController.signal.aborted) throw new Error('同步已终止');

            const engine = new PhasedSyncEngine({
              llm,
              config,
              cwd: workspace.path,
              ctx,
              parentAgent,
              signal: abortController.signal,
              storage, task: syncTask,
              onActivity: () => syncSupervisor.touch(lease),
              assertActive: () => { syncSupervisor.assert(lease); storage.assert(syncTask); },
            });

            await updateStep('init', { status: 'running', text: '根据子代理模型容量检查文档与必读证据，计算分块预算...' });
            const preparedChunks = await engine.prepareSyncChunks({
              docType, currentDoc, originalVersion, commits, codeDiff, sourceSnapshots, sessionTurns,
              syncContext: { taskId: syncId, branchName, targetSha: syncTask.commitHash, baseSha: syncTask.baselineCommit, attempt: syncTask.snapshotDir },
              hasUncommitted: uncommittedChanges.hasChanges, syncDir,
              onPreparation: activity => updateStep('init', { activity }),
            });
            await addFile('init', 'input-code.diff', 'code.input');
            await addFile('init', 'manifest.json');
            for (const entry of preparedChunks.store.entries.values()) if (entry.file.startsWith('sessions/')) await addFile('init', entry.file.replaceAll('/', '-'), entry.id);
            await updateStep('code_analysis', {
              chunks: preparedChunks.code.map(c => ({ index: c.index, tokens: c.tokens, inputBudget: c.inputBudget, files: c.details.map(d => ({ file: d.file, tokens: d.tokens })) })),
            });
            if (hasSessions) await updateStep('discussion_analysis', {
              chunks: preparedChunks.discussion.map(c => ({ index: c.index, tokens: c.tokens, inputBudget: c.inputBudget, turns: c.details })),
            });
            await updateStep('init', {
              status: 'completed',
              text: initText + `，代码 ${preparedChunks.code.length} 块、会话 ${preparedChunks.discussion.length} 块，输入预算检查通过`,
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
              onProgress: async progress => {
                if (progress.status === 'output_file') return addFile(progress.phase, progress.fileName);
                await lifecycle.progress(progress);
              }
            });

            if (result.aborted || abortController.signal.aborted) throw new Error('同步已终止');
            if (result.errors?.length || typeof result.mergedDoc !== 'string') {
              const failure = new Error(result.errors?.map(item => item.error).join('；') || '未生成有效文档快照');
              failure.phase = result.errors?.[0]?.phase; throw failure;
            }
            if (result.patchFile) await addFile('merge', result.patchFile);
            if (result.appliedDiffFile) await addFile('merge', result.appliedDiffFile);
            if (result.schemaVersion !== 2 || !result.validation || !Buffer.isBuffer(result.candidateBytes)) throw new Error('SYNC_V2_RESULT_REQUIRED');
            await lifecycle.metadata({ originalHash: result.validation.originalHash, candidateHash: result.validation.candidateHash, publishState: 'prepared' });
            await updateStep('publish', { status: 'running', text: '检查文档版本并发布...' });
            syncSupervisor.assert(lease);
            await publishDocument({ docPath, syncDir: join(syncDir, 'outputs'), fileName: docFileName, original: originalVersion,
              candidateBytes: result.candidateBytes, validation: result.validation, signal: abortController.signal, assertActive: () => { syncSupervisor.assert(lease); storage.assert(syncTask); } });
            await lifecycle.metadata({ publishState: 'document_written' });
            await updateStep('publish', { status: 'completed', text: '正式文档与成功快照一致' });
            await addFile('merge', docFileName);

            await lifecycle.metadata({ stats: result.stats, publishState: 'state_committed' });

            try {
              const journalPath = storage.file(syncTask, 'publish-journal.json');
              const journal = JSON.parse(await readFile(journalPath, 'utf8'));
              await atomicWrite(journalPath, JSON.stringify({ ...journal, stage: 'state_committed' }, null, 2), abortController.signal, () => { syncSupervisor.assert(lease); storage.assert(syncTask); });
            } catch (error) { log.sync.warn('发布日志收尾失败，可在重启时核验: ' + error.message); }

            abortController.signal.throwIfAborted();
            await lifecycle.finish();
            log.sync.info(`${docTypeName}分阶段同步结束：${syncTask.status}`);

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
          } catch (e) {
            log.sync.error(`分阶段同步失败: ${e.message}`);

            if (syncTask && !isSyncTaskRemoved(syncTask)) {
              lifecycle ||= new SyncLifecycle(syncTask, sendEvent);
              try { await lifecycle.finish({ status: abortController?.signal.aborted ? 'aborted' : 'failed', error: e.message, phase: e.phase }); }
              catch (persistError) { log.sync.error('同步终态持久化失败：' + persistError.message); }
            }

            if (res.headersSent) {
              try {
                sendEvent({ type: 'error', error: e.message, sync: syncTask });
              } catch { /* ignore */ }
            } else {
              const status = /^(?:COMMIT_LIST_CHANGED|INPUT_CHANGED):/.test(e.message) ? 409
                : /^(?:COMMIT_OUT_OF_RANGE|COMMIT_SELECTION_INVALID|BASE_BRANCH_)/.test(e.message) ? 400 : 500;
              json(res, { error: e.message }, e.statusCode || status);
            }
            try { res.end(); } catch { /* ignore */ }
          } finally {
            if (syncTask) deleteAbortController(workspaceId, requirementId, syncId, abortController);
            controllers.delete(abortController);
            if (lease) syncSupervisor.release(lease);
            if (lease?.deleted) await lease.cleanup?.().catch(error => log.sync.debug('删除任务收尾清理：' + error.message));
          }
        };
        req.on('end', () => {
          const execution = Promise.race([executeSync(), detached]); pendingSyncs.add(execution);
          void execution.finally(() => pendingSyncs.delete(execution)).catch(error => log.sync.error(error.message));
          return execution;
        });
      }
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
          if (snapshotDir) {
            const task = await getSyncById(syncId, workspaceId, requirementId);
            if (!task || task.snapshotDir !== snapshotDir) return json(res, { success: false, error: '同步任务已切换，请刷新状态' }, 409);
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
          const result = await abortSync(syncId, workspaceId, requirementId, ctx, parentAgent);
          json(res, result, result.success ? 200 : 400);
        } catch (e) {
          log.sync.error(`终止同步任务失败: ${e.message}`);
          json(res, { success: false, error: e.message }, 500);
        }
      }
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
          // 先找到 requirement 路径，然后加载状态
          const workspace = registry.list().find(w => w.id === workspaceId);
          if (!workspace) {
            json(res, { active: false, sync: null });
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
          await safeDocumentPath(workspace.path, relative(workspace.path, docsRoot));
          const reqDir = await findRequirementDir(docsRoot, requirementId);

          if (reqDir) {
            // 加载状态
            await loadState(workspaceId, requirementId, reqDir);
          }

          await syncSupervisor.check(); await reconcileOrphans();
          const overview = syncSupervisor.snapshot().active;
          const activeSync = await getActiveSync(workspaceId, requirementId)
            || (overview?.workspaceId === workspaceId && overview.requirementId === requirementId ? overview : null);
          json(res, { active: !!activeSync, sync: activeSync });
        } catch (e) {
          log.sync.error(`获取活动同步失败: ${e.message}`);
          json(res, { active: false, sync: null });
        }
      }
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
          const workspace = registry.list().find(w => w.id === workspaceId);
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
          const activeSync = await getActiveSync(workspaceId, requirementId)
            || (overview?.workspaceId === workspaceId && overview.requirementId === requirementId ? overview : null);
          json(res, { history, activeSync, timeline: buildSyncTimeline(history) });
        } catch (e) {
          log.sync.error(`获取同步历史失败: ${e.message}`);
          json(res, { error: e.message }, e.statusCode || 500);
        }
      }
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

        const workspace = registry.list().find(item => item.id === workspaceId);
        if (!workspace) return json(res, { error: 'SYNC_WORKSPACE_NOT_FOUND' }, 404);
        const config = await loadConfig();
        const reqDir = await findRequirementDir(resolve(workspace.path, config.docsDir || 'docs'), requirementId);
        if (!reqDir) return json(res, { error: 'SYNC_REQUIREMENT_NOT_FOUND' }, 404);
        await loadState(workspaceId, requirementId, reqDir);
        const sync = await getSyncById(syncId, workspaceId, requirementId);

        if (!sync) {
          json(res, { error: 'sync not found' }, 404);
          return;
        }

        json(res, { sync });
      }
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
        const artifactId = url.searchParams.get('artifactId'), attemptId = url.searchParams.get('attemptId');

        if (!workspaceId || !requirementId || !artifactId || !attemptId) {
          json(res, { error: 'missing parameters' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find(w => w.id === workspaceId);

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
          if (!task) return json(res, { error: 'SYNC_ATTEMPT_NOT_FOUND' }, 404);
          json(res, storage.readArtifact(task, artifactId));
        } catch (e) {
          log.sync.error(`Failed to read sync file: ${e.message}`);
          json(res, { error: e.message }, e.statusCode || e.status || 500);
        }
      }
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
        const workspace = workspaces.find(w => w.id === workspaceId);
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
          json(res, await compareSyncSnapshots(reqDir, history, syncId1, syncId2));
        } catch (e) {
          log.sync.error(`版本对比失败: ${e.message}`);
          json(res, { error: e.code === 'ENOENT' ? '成功版本快照缺失，无法对比' : e.message }, e.statusCode || (e.code === 'ENOENT' ? 404 : 500));
        }
      }
    }
  ];
  let disposal;
  routes.dispose = () => disposal ||= (async () => {
    closed = true;
    clearInterval(watchdog);
    const owner = syncSupervisor.owner?.scope === ownerScope ? syncSupervisor.owner : null;
    owner?.controller.abort();
    for (const [controller, task] of controllers) {
      controller.abort();
      await abortSync(task.id, task.workspaceId, task.requirementId);
    }
    const grace = setTimeout(() => { if (owner) void syncSupervisor.expire(owner, 'SYNC_SHUTDOWN_TIMEOUT: 插件退出时同步未能正常收尾，已回收').catch(error => log.sync.error(error.message)); }, syncSupervisor.limits.cancelling);
    const stoppingLibrary = library.close();
    try { await Promise.allSettled([...pendingSyncs, ...pendingRequests, stoppingLibrary]); } finally { clearTimeout(grace); if (!options.codexService) await codex.close(); await library.store.close(); storageLease.release(); }
  })();
  for (const route of routes) {
    const handler = route.handler;
    route.handler = (req, res) => {
      if (closed) return json(res, { error: 'SESSION_SERVICE_CLOSED' }, 503);
      const pending = (async () => {
        try { await retire(); if (closed) return json(res, { error: 'SESSION_SERVICE_CLOSED' }, 503); return await handler(req, res); }
        catch (error) {
          if (route.path === '/req-hub/sync-storage') log.sync.error('SYNC_STORAGE_REQUEST_FAILED: ' + error.message);
          json(res, { error: error.message }, error.statusCode || error.status || 500);
        }
      })();
      pendingRequests.add(pending);
      return pending.finally(() => pendingRequests.delete(pending));
    };
  }
  return routes;
}



































