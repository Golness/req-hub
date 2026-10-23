import { readDocumentVersion, publishDocument, atomicWrite } from '../sync-document-validator.js';
/**
 * Document sync routes module.
 * Handles document synchronization HTTP endpoints.
 * All LLM calls are delegated to DSH Subagent.
 * @module routes/sync-routes
 */

import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { findRequirementDir } from '../doc-reader.js';
import { findBranchByRequirement, beginCommitSync } from '../sync-engine.js';
import { defaultSyncBaseBranch, listSyncCommits } from '../sync-branches.js';
import { buildSyncTimeline } from '../sync-timeline.js';
import { compareSyncSnapshots } from '../sync-snapshots.js';
import { PhasedSyncEngine } from '../phased-sync-engine.js';
import { listRelatedSessions } from '../session-selector.js';
import { extractSessionTurns, extractMultipleSessionTurns, calculateTurnsTokens } from '../session-utils.js';
import { json, readBody } from '../utils.js';
import { log } from '../logger.js';
import {
  loadState,
  getActiveSync,
  completeSync,
  updateSyncProgress,
  getSyncHistory,
  getSyncById,
  setAbortController,
  deleteAbortController,
  abortSync,
} from '../sync-state.js';
import { buildTree } from '../tree.js';
import { rebuildIndex } from '../index-manager.js';
import { analyzeRequirement } from '../analyze-engine.js';
import { charsToTokens, formatTokens } from '../token-utils.js';

/**
 * Create document sync routes.
 * @param {Object} registry - Workspace registry service
 * @param {Object} llm - LLM service
 * @param {Object} sessions - Sessions service
 * @param {Object} agents - Agents service
 * @param {Object} ctx - DSH context
 * @returns {Array<Object>} Array of route definitions
 */
export function createSyncRoutes(registry, llm, sessions, agents, ctx) {
  // 从 ctx 获取 sessionQuery 服务
  const sessionQuery = ctx?.sessionQuery;

  return [
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
          const sessionsList = await listRelatedSessions(sessions, workspace.path, { limit, query, sessionQuery, registry });
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
        const debug = url.searchParams.get('debug') === 'true';

        if (!sessionId) {
          json(res, { error: 'missing sessionId' }, 400);
          return;
        }

        try {
          // 调试模式：返回原始事件数据
          if (debug) {
            const logSnapshot = await sessionQuery.readSession(sessionId);
            const events = logSnapshot.events;
            const userMsgs = events.filter(e => e.type === 'user/message');
            json(res, {
              eventCount: events.length,
              eventTypes: [...new Set(events.map(e => e.type))],
              userMessageCount: userMsgs.length,
              firstUserMessage: userMsgs[0] || null,
              secondUserMessage: userMsgs[1] || null,
            });
            return;
          }

          // 使用统一的提取方法
          const turns = await extractSessionTurns(sessionQuery, sessionId);
          const totalTokens = calculateTurnsTokens(turns);

          json(res, {
            success: true,
            turns,
            turnCount: turns.length,
            totalTokens,
          });
        } catch (e) {
          log.sync.error(`获取会话轮次失败: ${e.message}`);
          json(res, { success: false, error: e.message }, 500);
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

        req.on('end', async () => {
          let syncTask;
          let syncId;
          let workspaceId;
          let requirementId;
          try {
            const input = JSON.parse(body);
            const { docType, sessionIds = [], runAnalysis = false, runIndex = false } = input;
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

            const config = await loadConfig();
            const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
            const reqDir = await findRequirementDir(docsRoot, requirementId);
            if (!reqDir) { json(res, { error: '需求目录未找到' }, 404); return; }
            if (!llm) { json(res, { error: 'LLM 不可用' }, 503); return; }
            const docTypeName = docType === 'requirement' ? '需求文档' : '技术方案';

            const hasSessions = sessionIds.length > 0;
            const fields = {
              workspaceId,
              requirementId,
              docType,
              docTypeName,
              sessionIds,
              baseBranch: input.baseBranch?.trim() || await defaultSyncBaseBranch(workspace.path),
              commitHashes: input.commitHashes,
              branchTip: input.branchTip,
              baseCommit: input.baseCommit,
              includeWorkingChanges: input.includeWorkingChanges !== false,
              startedAt: Date.now(),
              status: 'running', // running | completed | failed
              steps: [
                { phase: 'init', label: '同步检查', status: 'pending', text: '', files: [], chunks: null },
                { phase: 'code_analysis', label: '代码差异分析', status: 'pending', text: '', files: [], chunks: null },
                ...(hasSessions ? [
                  { phase: 'discussion_analysis', label: '讨论差异分析', status: 'pending', text: '', files: [], chunks: null },
                ] : []),
                { phase: 'merge', label: '隔离文档局部编辑', status: 'pending', text: '', files: [], chunks: null },
                { phase: 'validate', label: '补丁与字节校验', status: 'pending', text: '', files: [], chunks: null },
                { phase: 'publish', label: '一致性发布', status: 'pending', text: '', files: [], chunks: null },
                ...(runAnalysis ? [{ phase: 'analysis', label: '构建分析', status: 'pending', text: '', files: [], chunks: null }] : []),
                ...(runIndex ? [{ phase: 'index', label: '构建索引', status: 'pending', text: '', files: [], chunks: null }] : []),
              ],
              generatedFiles: [],
              runAnalysis,
              runIndex,
            };

            const prepared = await beginCommitSync(workspace.path, reqDir, fields);
            if (prepared.active || prepared.skipped) { json(res, prepared); return; }
            syncTask = prepared.sync;
            syncId = syncTask.id;
            const abortController = new AbortController();
            setAbortController(workspaceId, requirementId, abortController, syncId);
            const { branchName, commits, codeDiff, uncommittedChanges, sourceSnapshots } = prepared;

            // Set up SSE
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });

            const sendEvent = (data) => {
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            // Helper to update step and persist
            const updateStep = async (phase, updates) => {
              const step = syncTask.steps.find(s => s.phase === phase);
              if (step) {
                Object.assign(step, updates);
              }
              await updateSyncProgress(syncId, { steps: syncTask.steps, generatedFiles: syncTask.generatedFiles }, workspaceId, requirementId);
              sendEvent({ type: 'step', phase, ...updates });
            };

            const addFile = async (phase, fileName) => {
              if (syncTask.generatedFiles.some(file => file.phase === phase && file.fileName === fileName)) return;
              const step = syncTask.steps.find(s => s.phase === phase);
              if (step) {
                step.files.push(fileName);
              }
              syncTask.generatedFiles.push({ phase, fileName });
              await updateSyncProgress(syncId, { steps: syncTask.steps, generatedFiles: syncTask.generatedFiles }, workspaceId, requirementId);
              sendEvent({ type: 'file', phase, fileName });
            };

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
            initText += `，代码变更约 ${formatTokens(charsToTokens(codeDiff.length))} tokens`;
            if (isNewDoc) initText += '，新建文档';

            // ─── Step 2: Session Extract ──────────────────────────
            let sessionTurns = [];
            if (sessionIds.length > 0) {
              await updateStep('init', { status: 'running', text: `提取 ${sessionIds.length} 个会话内容...` });

              try {
                // 使用统一的提取方法，分析时不截断摘要（maxSummaryChars: -1）
                const result = await extractMultipleSessionTurns(sessionQuery, sessionIds, {
                  maxSummaryChars: -1 // 不截断
                });
                sessionTurns = result.turns;

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
            const syncDirName = syncTask.snapshotDir;
            const syncBaseDir = join(reqDir, 'sync-logs');
            const syncDir = join(syncBaseDir, syncDirName);
            const { mkdir } = await import('node:fs/promises');
            await mkdir(syncBaseDir, { recursive: true });
            await mkdir(syncDir, { recursive: true });
            await writeFile(join(syncDir, 'input-code.diff'), codeDiff, 'utf8');
            await addFile('init', `sync-logs/${syncDirName}/input-code.diff`);

            // 获取父 Agent（用于 subagent 委托）
            const parentAgent = agents?.get(sessionId);
            if (!parentAgent) {
              await updateStep('init', { status: 'failed', text: '会话不存在或已结束，请在活跃的 DSH 会话中调用此功能' });
              syncTask.status = 'failed';
              await completeSync(syncId, workspaceId, requirementId);
              deleteAbortController(workspaceId, requirementId);
              sendEvent({ type: 'error', error: '会话不存在或已结束，请在活跃的 DSH 会话中调用此功能' });
              res.end();
              return;
            }

            if (abortController.signal.aborted) throw new Error('同步已终止');

            const engine = new PhasedSyncEngine({
              llm,
              config,
              cwd: workspace.path,
              ctx,
              parentAgent,
              signal: abortController.signal,
            });

            await updateStep('init', { status: 'running', text: '检查代码与会话的完整 prompt，按 150K 输入预算分块...' });
            const preparedChunks = await engine.prepareSyncChunks({
              docType, currentDoc, originalVersion, commits, codeDiff, sourceSnapshots, sessionTurns,
              syncContext: { taskId: syncId, branchName, targetSha: syncTask.commitHash, baseSha: syncTask.baselineCommit, attempt: syncTask.snapshotDir },
              hasUncommitted: uncommittedChanges.hasChanges, syncDir,
            });
            await updateStep('code_analysis', {
              chunks: preparedChunks.code.map(c => ({ index: c.index, tokens: c.tokens, files: c.details.map(d => ({ file: d.file, tokens: d.tokens })) })),
            });
            if (hasSessions) await updateStep('discussion_analysis', {
              chunks: preparedChunks.discussion.map(c => ({ index: c.index, tokens: c.tokens, turns: c.details })),
            });
            await updateStep('init', {
              status: 'completed',
              text: initText + `，代码 ${preparedChunks.code.length} 块、会话 ${preparedChunks.discussion.length} 块，输入预算检查通过`,
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
                // Map engine progress to our step system
                const { phase, status, content } = progress;
                if (status === 'output_file') {
                  await addFile(phase, `sync-logs/${syncDirName}/${progress.fileName}`);
                  return;
                }
                if (status === 'skipped') {
                  await updateStep(phase, { status: 'skipped', text: progress.reason || '无内容需要处理' });
                  return;
                }

                if (phase === 'validate') {
                  await updateStep(phase, { status: status === 'started' ? 'running' : status, text: progress.error || (status === 'completed' ? '精确回放与范围校验通过' : '校验候选文档与标准补丁...') });
                  return;
                }
                // 处理块级 subagent 身份事件
                if (status === 'chunk_subagent') {
                  const chunkStatusMap = syncTask.chunkStatusMap || (syncTask.chunkStatusMap = {});
                  if (!chunkStatusMap[phase]) chunkStatusMap[phase] = {};
                  if (!chunkStatusMap[phase][progress.chunkIndex]) chunkStatusMap[phase][progress.chunkIndex] = {};
                  chunkStatusMap[phase][progress.chunkIndex].sessionId = progress.sessionId;
                  chunkStatusMap[phase][progress.chunkIndex].status = 'running';

                  // 同步更新 step.chunks，确保前端能立即渲染
                  const step = syncTask.steps.find(s => s.phase === phase);
                  if (step && step.chunks && step.chunks[progress.chunkIndex]) {
                    step.chunks[progress.chunkIndex] = {
                      ...step.chunks[progress.chunkIndex],
                      sessionId: progress.sessionId,
                      status: 'running',
                    };
                  }

                  sendEvent({ type: 'chunk_status', phase, chunkIndex: progress.chunkIndex, status: 'running', sessionId: progress.sessionId });
                  return;
                }

                // 处理块级状态更新事件
                if (status === 'chunk_completed' || status === 'chunk_failed' || status === 'chunk_aborted') {
                  const chunkStatus = status === 'chunk_completed' ? 'completed' : status === 'chunk_failed' ? 'failed' : 'aborted';
                  const chunkStatusMap = syncTask.chunkStatusMap || (syncTask.chunkStatusMap = {});
                  if (!chunkStatusMap[phase]) chunkStatusMap[phase] = {};
                  if (!chunkStatusMap[phase][progress.chunk - 1]) chunkStatusMap[phase][progress.chunk - 1] = {};
                  chunkStatusMap[phase][progress.chunk - 1].status = chunkStatus;
                  if (status === 'chunk_failed') chunkStatusMap[phase][progress.chunk - 1].error = progress.error;

                  // 同步更新 step.chunks
                  const step = syncTask.steps.find(s => s.phase === phase);
                  if (step && step.chunks && step.chunks[progress.chunk - 1]) {
                    step.chunks[progress.chunk - 1] = {
                      ...step.chunks[progress.chunk - 1],
                      status: chunkStatus,
                      error: progress.error,
                    };
                  }

                  sendEvent({ type: 'chunk_status', phase, chunkIndex: progress.chunk - 1, status: chunkStatus, error: progress.error });
                  return;
                }

                // 处理排队等待事件
                if (status === 'waiting_for_slot') {
                  const chunkStatusMap = syncTask.chunkStatusMap || (syncTask.chunkStatusMap = {});
                  if (!chunkStatusMap[phase]) chunkStatusMap[phase] = {};
                  if (!chunkStatusMap[phase][progress.chunk - 1]) chunkStatusMap[phase][progress.chunk - 1] = {};
                  chunkStatusMap[phase][progress.chunk - 1].status = 'queued';

                  // 同步更新 step.chunks
                  const step = syncTask.steps.find(s => s.phase === phase);
                  if (step && step.chunks && step.chunks[progress.chunk - 1]) {
                    step.chunks[progress.chunk - 1] = {
                      ...step.chunks[progress.chunk - 1],
                      status: 'queued',
                    };
                  }

                  sendEvent({ type: 'chunk_status', phase, chunkIndex: progress.chunk - 1, status: 'queued' });
                  return;
                }

                // Track subagent sessionId for abort interrupt
                if (progress.sessionId) {
                  syncTask.currentSubagentSessionId = progress.sessionId;
                }

                // 处理 liveness 事件 — 转发到前端
                if (status === 'liveness') {
                  sendEvent({
                    type: 'liveness',
                    phase,
                    livenessStage: progress.livenessStage,
                    sessionId: progress.sessionId,
                    lastActivityDesc: progress.lastActivityDesc,
                    staleCount: progress.staleCount,
                    stalenessDuration: progress.stalenessDuration,
                  });
                  return;
                }

                // 处理 code_analysis 阶段
                if (phase === 'code_analysis') {
                  if (status === 'started') {
                    await updateStep('code_analysis', {
                      status: 'running',
                      text: `AI 分析代码差异点... (约 ${formatTokens(progress.codeTokens)} tokens，${progress.codeFiles} 个文件)`,
                    });
                  } else if (status === 'chunked') {
                    // 分块信息
                    await updateStep('code_analysis', {
                      text: `代码分块完成，共 ${progress.totalChunks} 块`,
                      chunks: progress.chunks,
                      totalTokens: progress.totalTokens,
                    });
                  } else if (status === 'processing_chunk') {
                    await updateStep('code_analysis', {
                      text: progress.message || '分析差异点中...',
                      chunkInfo: progress.chunkInfo,
                    });
                  } else if (status === 'merging_chunks') {
                    await updateStep('code_analysis', { text: '合并差异点...' });
                  } else if (status === 'completed') {
                    await updateStep('code_analysis', { status: 'completed', text: '代码差异分析完成' });
                    // 合并 subagent 已直接写入 code-diffs.md，无需再次保存
                    await addFile('code_analysis', `sync-logs/${syncDirName}/code-diffs.md`);
                  } else if (status === 'failed') {
                    await updateStep('code_analysis', { status: 'failed', text: '代码差异分析失败' });
                  }
                }
                // 处理 discussion_analysis 阶段
                else if (phase === 'discussion_analysis') {
                  if (status === 'started') {
                    await updateStep('discussion_analysis', { status: 'running', text: 'AI 分析讨论差异点...' });
                  } else if (status === 'chunked') {
                    // 分块信息
                    await updateStep('discussion_analysis', {
                      text: `讨论分块完成，共 ${progress.totalChunks} 块`,
                      chunks: progress.chunks,
                      totalTokens: progress.totalTokens,
                    });
                  } else if (status === 'processing_chunk') {
                    await updateStep('discussion_analysis', {
                      text: progress.message || '分析差异点中...',
                      chunkInfo: progress.chunkInfo,
                    });
                  } else if (status === 'merging_chunks') {
                    await updateStep('discussion_analysis', { text: '合并差异点...' });
                  } else if (status === 'completed') {
                    await updateStep('discussion_analysis', { status: 'completed', text: '讨论差异分析完成' });
                    // 合并 subagent 已直接写入 discussion-diffs.md，无需再次保存
                    await addFile('discussion_analysis', `sync-logs/${syncDirName}/discussion-diffs.md`);
                  } else if (status === 'failed') {
                    await updateStep('discussion_analysis', { status: 'failed', text: '讨论差异分析失败' });
                  }
                } else if (phase === 'merge') {
                  if (status === 'started') {
                    await updateStep('merge', { status: 'running', text: 'AI 合并变更到文档...' });
                  } else if (status === 'completed') {
                    await updateStep('merge', { status: 'completed', text: '文档合并完成' });
                  } else if (status === 'failed') {
                    await updateStep('merge', { status: 'failed', text: '文档合并失败' });
                  }
                }
              }
            });

            if (result.aborted || abortController.signal.aborted) {
              deleteAbortController(workspaceId, requirementId);
              sendEvent({ type: 'error', error: '同步已终止' });
              res.end();
              return;
            }
            if (result.errors?.length || typeof result.mergedDoc !== 'string') {
              throw new Error(result.errors?.map(item => item.error).join('；') || '未生成有效文档快照');
            }
            if (result.patchFile) await addFile('merge', `sync-logs/${syncDirName}/${result.patchFile}`);
            if (result.appliedDiffFile) await addFile('merge', `sync-logs/${syncDirName}/${result.appliedDiffFile}`);
            if (result.schemaVersion !== 2 || !result.validation || !Buffer.isBuffer(result.candidateBytes)) throw new Error('SYNC_V2_RESULT_REQUIRED');
            Object.assign(syncTask, { originalHash: result.validation.originalHash, candidateHash: result.validation.candidateHash, publishState: 'prepared' });
            await updateSyncProgress(syncId, { originalHash: syncTask.originalHash, candidateHash: syncTask.candidateHash, publishState: 'prepared' }, workspaceId, requirementId);
            await updateStep('publish', { status: 'running', text: '检查文档版本并发布...' });
            await publishDocument({ docPath, syncDir, fileName: docFileName, original: originalVersion,
              candidateBytes: result.candidateBytes, validation: result.validation, signal: abortController.signal });
            syncTask.publishState = 'document_written';
            await updateStep('publish', { status: 'completed', text: '正式文档与成功快照一致' });
            await addFile('merge', `sync-logs/${syncDirName}/${docFileName}`);

            // 持久化 chunk 状态到 steps（用于页面刷新恢复）
            if (syncTask.chunkStatusMap) {
              for (const [phaseKey, chunks] of Object.entries(syncTask.chunkStatusMap)) {
                const step = syncTask.steps.find(s => s.phase === phaseKey);
                if (step && step.chunks) {
                  step.chunks = step.chunks.map((c, i) => ({
                    ...c,
                    ...(chunks[i] || {}),
                  }));
                }
              }
              await updateSyncProgress(syncId, { steps: syncTask.steps }, workspaceId, requirementId);
            }

            // The core document transaction is committed before optional analysis/index work.
            syncTask.status = 'completed';
            syncTask.stats = result.stats;
            syncTask.publishState = 'state_committed';
            await updateSyncProgress(syncId, { status: 'completed', stats: result.stats, publishState: 'state_committed' }, workspaceId, requirementId);
            await completeSync(syncId, workspaceId, requirementId);
            deleteAbortController(workspaceId, requirementId);

            try {
              const journalPath = join(syncDir, 'publish-journal.json');
              const journal = JSON.parse(await readFile(journalPath, 'utf8'));
              await atomicWrite(journalPath, JSON.stringify({ ...journal, stage: 'state_committed' }, null, 2));
            } catch (error) { log.sync.warn('发布日志收尾失败，可在重启时核验: ' + error.message); }

            // ─── Step 6: Build Analysis (optional) ─────────────────
            if (runAnalysis) {
              try {
                await updateStep('analysis', { status: 'running', text: 'AI 分析需求文档...' });

                const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
                const tree = await buildTree(docsRoot);

                // Find the requirement in tree
                let reqInfo = null;
                for (const dev of tree.developers) {
                  for (const req of dev.requirements) {
                    if (req.id === requirementId) {
                      reqInfo = { id: req.id, developer: dev.name, path: req.path };
                      break;
                    }
                  }
                  if (reqInfo) break;
                }

                if (!reqInfo) {
                  await updateStep('analysis', { status: 'failed', text: '未找到需求目录' });
                } else {
                  const parentAgent = agents?.get(sessionId);
                  if (!parentAgent) {
                    await updateStep('analysis', { status: 'failed', text: '会话不存在或已结束' });
                  } else {
                    const reqPath = join(docsRoot, reqInfo.path);
                    const result = await analyzeRequirement({
                      ctx,
                      llm,
                      config,
                      parentAgent,
                      reqPath,
                      requirementId,
                      cwd: workspace.path,
                    });

                    if (result.success) {
                      await addFile('analysis', '.meta.json');
                      await updateStep('analysis', { status: 'completed', text: `分析完成：${result.meta?.summary || '已生成'}` });
                    } else {
                      await updateStep('analysis', { status: 'failed', text: result.error || '分析失败' });
                    }
                  }
                }
              } catch (e) {
                log.analysis.error(`构建分析失败: ${e.message}`);
                await updateStep('analysis', { status: 'failed', text: `分析失败: ${e.message}` });
              }
            }

            // ─── Step 8: Build Index (optional) ─────────────────
            if (runIndex) {
              try {
                await updateStep('index', { status: 'running', text: '重建搜索索引...' });

                const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
                const tree = await buildTree(docsRoot);
                const index = await rebuildIndex(docsRoot, tree);

                await updateStep('index', {
                  status: 'completed',
                  text: `索引重建完成：${index.requirements.length} 需求，${Object.keys(index.featureIndex).length} 功能点`
                });
              } catch (e) {
                log.index.error(`构建索引失败: ${e.message}`);
                await updateStep('index', { status: 'failed', text: `索引失败: ${e.message}` });
              }
            }

            log.sync.info(`${docTypeName}分阶段同步完成`);

            sendEvent({
              type: 'done',
              syncId,
              docType,
              stats: result.stats,
              files: syncTask.generatedFiles,
            });

            res.end();
          } catch (e) {
            log.sync.error(`分阶段同步失败: ${e.message}`);

            // 标记任务失败并清理状态
            if (syncTask) {
              if (syncTask.status !== 'aborted' && syncTask.publishState !== 'state_committed') syncTask.status = 'failed';
              syncTask.error = e.message;
              const checking = syncTask.steps.find(step => step.phase === 'init' && step.status === 'running');
              if (checking) {
                Object.assign(checking, { status: 'failed', text: e.message });
                if (res.headersSent) res.write(`data: ${JSON.stringify({ type: 'step', phase: 'init', status: 'failed', text: e.message })}\n\n`);
              }
              try { await completeSync(syncId, workspaceId, requirementId); } catch (persistError) { log.sync.error(persistError.message); }
            }

            // Clean up abort controller
            if (syncTask) deleteAbortController(workspaceId, requirementId);

            if (res.headersSent) {
              try {
                res.write(`data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`);
              } catch { /* ignore */ }
            } else {
              const status = /^(?:COMMIT_LIST_CHANGED|INPUT_CHANGED):/.test(e.message) ? 409
                : /^(?:COMMIT_OUT_OF_RANGE|COMMIT_SELECTION_INVALID|BASE_BRANCH_)/.test(e.message) ? 400 : 500;
              json(res, { error: e.message }, status);
            }
            try { res.end(); } catch { /* ignore */ }
          }
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
          const { workspaceId, requirementId, syncId } = JSON.parse(raw);

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
          const reqDir = await findRequirementDir(docsRoot, requirementId);

          if (reqDir) {
            // 加载状态
            await loadState(workspaceId, requirementId, reqDir);
          }

          const activeSync = await getActiveSync(workspaceId, requirementId);
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
          json(res, { history, timeline: buildSyncTimeline(history) });
        } catch (e) {
          log.sync.error(`获取同步历史失败: ${e.message}`);
          json(res, { history: [] });
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
        const fileName = url.searchParams.get('fileName');

        if (!workspaceId || !requirementId || !fileName) {
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

          const filePath = join(reqDir, fileName);
          const content = await readFile(filePath, 'utf8');
          json(res, { content, fileName });
        } catch (e) {
          log.sync.error(`Failed to read sync file: ${e.message}`);
          json(res, { error: e.message }, 500);
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
}



































