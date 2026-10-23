import { installSyncTools } from './sync-controlled-tools.js';
/**
 * ReqHub — Requirement document management plugin for DeepSeek Harness.
 *
 * Provides requirement document organization, AI-powered analysis,
 * code-to-doc synchronization, and semantic search capabilities.
 *
 * @module req-hub
 */

import { createConfigRoutes } from './routes/config-routes.js';
import { createTreeRoutes } from './routes/tree-routes.js';
import { createAnalyzeRoutes } from './routes/analyze-routes.js';
import { createSearchRoutes } from './routes/search-routes.js';
import { createSyncRoutes } from './routes/sync-routes.js';
import { createTemplateRoutes } from './routes/template-routes.js';
import { createKnowledgeRoutes } from './routes/knowledge-routes.js';
import { log, getLogs, clearLogs, getLogLevels, getLogTags } from './logger.js';
import { json } from './utils.js';
import { setSkillsService } from './prompts.js';

/**
 * Plugin identity — required by DSH Cordis Loader.
 * @type {string}
 */
export const name = 'req-hub';

/**
 * Declared service dependencies — Cordis resolves load order from this list.
 * @type {string[]}
 */
export const inject = ['workspaceRegistry', 'webServer', 'llm', 'sessions', 'skills', 'agents', 'agentPresets', 'sessionQuery', 'subagents', 'sessionProjections', 'tools'];

/**
 * Plugin configuration schema.
 *
 * NOTE: A full schemastery/zod Config export is omitted because @deepseek-ai/schemastery
 * is not yet available as a standalone package. When it becomes available, replace this
 * with a proper z.object({...}) schema to enable DSH Settings UI integration.
 *
 * Configuration is managed via config.json loaded by the config module.
 * @see {@link module:config.loadConfig}
 */

/**
 * Apply plugin effects to the DSH context.
 *
 * Registers all HTTP routes on `ctx.webServer` and wires up the skills service.
 * Returns a disposer that unregisters all routes on teardown / HMR reload.
 *
 * @param {Object} ctx - Cordis service context
 * @param {Object} ctx.workspaceRegistry - Workspace registry service
 * @param {Object} ctx.webServer - Web server service
 * @param {Object} ctx.llm - LLM service
 * @param {Object} ctx.sessions - Sessions service
 * @param {Object} ctx.skills - Skills service
 * @param {Object} ctx.agents - Agents service
 * @param {Object} ctx.agentPresets - Agent presets service
 * @param {Object} ctx.sessionQuery - Session query service
 * @param {Object} ctx.subagents - Subagents service
 * @param {Object} ctx.sessionProjections - Session projections service
 * @returns {Function} Disposer function that cleans up all registered routes
 */
export function apply(ctx) {
  const { workspaceRegistry, webServer, llm, sessions, skills, agents, agentPresets, sessionQuery, subagents, sessionProjections } = ctx;

  // 设置 skills 服务到 prompts 模块
  setSkillsService(skills);

  log.startup.info('ReqHub 插件启动 (模块化架构 - Subagent 统一委托)');
  log.startup.debug('可用服务', { 
    hasSessions: !!sessions,
    hasSkills: !!skills,
    hasLlm: !!llm,
    hasAgents: !!agents,
    hasAgentPresets: !!agentPresets,
    hasSessionQuery: !!sessionQuery,
    hasSubagents: !!subagents,
    hasSessionProjections: !!sessionProjections
  });

  const disposers = [];
  const knowledge = createKnowledgeRoutes(workspaceRegistry);
  disposers.push(() => { void knowledge.dispose(); });
  const syncTools = installSyncTools(ctx);
  if (syncTools) disposers.push(() => syncTools.dispose());

  // 创建所有路由
  const routes = [
    ...knowledge.routes,
    // 配置相关
    ...createConfigRoutes(workspaceRegistry, llm),
    
    // 文档树相关
    ...createTreeRoutes(workspaceRegistry),
    
    // AI 分析相关（传入 ctx 用于 subagent）
    ...createAnalyzeRoutes(workspaceRegistry, llm, sessions, agents, agentPresets, sessionQuery, ctx),
    
    // 搜索相关（传入 agents 和 ctx 用于 subagent）
    ...createSearchRoutes(workspaceRegistry, llm, agents, ctx),
    
    // 文档同步相关（传入 agents 和 ctx 用于 subagent）
    ...createSyncRoutes(workspaceRegistry, llm, sessions, agents, ctx),
    
    // 模板生成相关（传入 agents 和 ctx 用于 subagent）
    ...createTemplateRoutes(workspaceRegistry, llm, agents, ctx),
    
    // 日志相关
    {
      kind: 'exact',
      path: '/req-hub/logs',
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }
        json(res, { logs: getLogs() });
      }
    },
    {
      kind: 'exact',
      path: '/req-hub/logs/clear',
      handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        clearLogs();
        log.startup.info('日志已清空');
        json(res, { success: true });
      }
    },
    // 日志元数据接口
    {
      kind: 'exact',
      path: '/req-hub/logs/meta',
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }
        json(res, {
          levels: getLogLevels(),
          tags: getLogTags()
        });
      }
    },
    // 诊断：查找会话及其 subagent 活跃度
    {
      kind: 'exact',
      path: '/req-hub/diagnose-subagent',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const titleQuery = url.searchParams.get('title') || '';

        if (!titleQuery) {
          json(res, { error: 'missing title parameter' }, 400);
          return;
        }

        if (!sessionQuery || !subagents || !agents) {
          json(res, { error: 'DSH services not available' }, 500);
          return;
        }

        try {
          // 1. 搜索匹配的会话
          const searchResult = await sessionQuery.searchSessions({ query: titleQuery });
          const hits = searchResult?.items || [];

          // 找到标题匹配的会话
          const matchedSessions = [];
          for (const hit of hits) {
            let title = '';
            try {
              const titleObs = await sessionQuery.readTitle(hit.header.id);
              title = titleObs?.title || '';
            } catch { /* ignore */ }

            if (title.includes(titleQuery)) {
              matchedSessions.push({
                id: hit.header.id,
                title,
                cwd: hit.header.cwd || '',
                createdAt: hit.header.createdAt,
              });
            }
          }

          if (matchedSessions.length === 0) {
            json(res, { error: `没有找到标题包含 "${titleQuery}" 的会话`, sessions: [] });
            return;
          }

          // 取最近的一个会话
          matchedSessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          const targetSession = matchedSessions[0];

          // 2. 获取该会话的 subagent 列表
          let descendants = [];
          try {
            descendants = await subagents.listDescendants(targetSession.id);
          } catch (e) {
            descendants = [];
          }

          // 3. 获取每个 subagent 的详细信息
          const subagentDetails = [];
          for (const desc of descendants) {
            if (desc.kind !== 'child') continue;

            // 获取 subagent 的最新事件
            let lastEventTime = null;
            let lastEventType = null;
            let hasActiveTurn = false;
            let eventCount = 0;

            try {
              const observation = await sessionQuery.observeSession(desc.id);
              const events = observation?.events || [];
              eventCount = events.length;

              if (events.length > 0) {
                // 检查是否有未完成的 turn
                let foundStart = false;
                for (let i = events.length - 1; i >= 0; i--) {
                  const e = events[i];
                  if (e.type === 'turn/end' && foundStart) {
                    foundStart = false;
                  } else if (e.type === 'turn/start') {
                    foundStart = true;
                    break;
                  }
                }
                hasActiveTurn = foundStart;

                // 找最新事件
                const latest = events[events.length - 1];
                lastEventTime = latest.time || null;
                lastEventType = latest.type || null;
              }
            } catch { /* ignore */ }

            // 判断是否活跃
            const agent = agents.get(desc.id);
            const agentStatus = agent?.status || 'unknown';
            const isActive = hasActiveTurn || agentStatus === 'running';

            subagentDetails.push({
              id: desc.id,
              label: desc.label || '(无标签)',
              status: desc.status || 'unknown',
              agentStatus,
              isActive,
              hasActiveTurn,
              lastEventTime,
              lastEventType,
              eventCount,
              depth: desc.depth,
            });
          }

          // 按深度排序，取最新的（最深的）
          subagentDetails.sort((a, b) => (b.depth || 0) - (a.depth || 0));

          json(res, {
            targetSession,
            totalSubagents: subagentDetails.length,
            subagents: subagentDetails,
            latestSubagent: subagentDetails[0] || null,
          });
        } catch (e) {
          json(res, { error: e.message }, 500);
        }
      }
    },
    // Skills 列表接口
    {
      kind: 'exact',
      path: '/req-hub/skills',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const sessionId = url.searchParams.get('sessionId');

        if (!skills) {
          json(res, { skills: [], error: 'skills 服务不可用' });
          return;
        }

        try {
          // 获取 cwd（用于工作区相关的技能）
          let cwd = undefined;
          if (workspaceId) {
            const workspaces = workspaceRegistry.list();
            const workspace = workspaces.find(w => w.id === workspaceId);
            if (workspace) {
              cwd = workspace.path;
            }
          }

          // 默认使用全局 skills 服务
          let skillRegistry = skills;
          let scope = undefined;
          
          // 如果有 sessionId，参考 SessionSkillCatalog 的逻辑获取技能
          if (sessionId && sessionQuery && agents && agentPresets) {
            try {
              // 1. 获取会话信息
              const observation = await sessionQuery.observeSession(sessionId);
              if (observation?.projections) {
                // 从会话获取 cwd
                if (!cwd) {
                  cwd = observation.header.cwd;
                }
                
                // 从会话获取 agentPreset
                const agentPreset = observation.projections.values.agentPreset ?? undefined;
                
                // 2. 尝试从活跃 agent 获取 scoped skills
                const live = agents.get(sessionId);
                let scoped = live ? agentPresets.serviceFor(live, 'skills') : undefined;
                
                // 3. 如果没有活跃 agent，尝试从 preset 获取 scope
                if (!scoped && agentPreset) {
                  try {
                    const lease = await agentPresets.acquireScope(agentPreset);
                    if (lease) {
                      scope = lease.key;
                      // 注意：lease 需要在使用后释放，但我们这里直接返回结果，
                      // 所以在异步操作完成后会自动释放
                    }
                  } catch (e) {
                    // preset 不可用，回退到全局
                  }
                } else if (scoped) {
                  skillRegistry = scoped;
                  scope = live;
                }
              }
            } catch (e) {
              log.startup.warn(`Failed to get session skills: ${e.message}`);
            }
          }
          
          log.startup.debug(`Fetching skills list`, { cwd, sessionId, scoped: skillRegistry !== skills });
          
          const skillsList = await skillRegistry.list(cwd ? { cwd, scope } : { scope });
          
          // 过滤出 user-invocable 的技能
          const userSkills = skillsList.filter(s => s.invocation.userInvocable);
          
          log.startup.debug(`Skills list result`, { 
            count: userSkills.length
          });
          
          json(res, { 
            skills: userSkills.map(s => ({
              name: s.name,
              description: s.description,
              whenToUse: s.whenToUse,
              source: s.source,
              modelInvocable: s.invocation.modelInvocable,
              userInvocable: s.invocation.userInvocable
            })),
            debug: {
              cwd,
              workspaceId,
              sessionId,
              scoped: skillRegistry !== skills
            }
          });
        } catch (e) {
          log.startup.error(`获取 skills 失败: ${e.message}`, { stack: e.stack });
          json(res, { skills: [], error: e.message }, 500);
        }
      }
    },
    // Skill 内容接口
    {
      kind: 'exact',
      path: '/req-hub/skill-content',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const skillName = url.searchParams.get('name');
        const workspaceId = url.searchParams.get('workspaceId');
        const sessionId = url.searchParams.get('sessionId');

        if (!skillName) {
          json(res, { error: 'missing skill name' }, 400);
          return;
        }

        if (!skills) {
          json(res, { error: 'skills 服务不可用' }, 500);
          return;
        }

        try {
          // 获取 cwd
          let cwd = undefined;
          if (workspaceId) {
            const workspaces = workspaceRegistry.list();
            const workspace = workspaces.find(w => w.id === workspaceId);
            if (workspace) {
              cwd = workspace.path;
            }
          }

          // 默认使用全局 skills 服务
          let skillRegistry = skills;
          let scope = undefined;
          
          // 如果有 sessionId，使用与 skills 列表相同的逻辑
          if (sessionId && sessionQuery && agents && agentPresets) {
            try {
              const observation = await sessionQuery.observeSession(sessionId);
              if (observation?.projections) {
                if (!cwd) {
                  cwd = observation.header.cwd;
                }
                
                const agentPreset = observation.projections.values.agentPreset ?? undefined;
                
                const live = agents.get(sessionId);
                let scoped = live ? agentPresets.serviceFor(live, 'skills') : undefined;
                
                if (!scoped && agentPreset) {
                  try {
                    const lease = await agentPresets.acquireScope(agentPreset);
                    if (lease) {
                      scope = lease.key;
                    }
                  } catch (e) {
                    // preset 不可用，回退到全局
                  }
                } else if (scoped) {
                  skillRegistry = scoped;
                  scope = live;
                }
              }
            } catch (e) {
              log.startup.warn(`Failed to get session skills: ${e.message}`);
            }
          }

          const skill = await skillRegistry.get(skillName, cwd ? { cwd, scope } : { scope });
          if (!skill) {
            json(res, { error: `skill "${skillName}" not found` }, 404);
            return;
          }

          json(res, { 
            name: skill.name,
            description: skill.description,
            content: skill.content,
            provider: skill.provider
          });
        } catch (e) {
          log.startup.error(`获取 skill 内容失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    }
  ];

  // 注册所有路由
  for (const route of routes) {
    try {
      const dispose = webServer.register(route);
      disposers.push(dispose);
    } catch (err) {
      if (!String(err.message).includes('duplicate')) {
        log.startup.error(`路由注册失败: ${err.message}`);
      }
    }
  }

  log.startup.info(`已注册 ${routes.length} 个路由`);

  // 返回清理函数
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
    log.startup.info('ReqHub 插件卸载');
  };
}
