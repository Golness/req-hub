import { createOperations, installOperationTool } from './operations.js';
import { authenticatedRoute, disposeAll } from './plugin-boundaries.js';
import { configureStorage, Config } from './config.js';
import { join } from 'node:path';
export { Config };
import { installSyncTools } from './sync-controlled-tools.js';
/**
 * ReqHub — Requirement document management plugin for DeepSeek Harness.
 *
 * Provides requirement document organization, knowledge-assisted writing,
 * code-to-doc synchronization, and semantic search capabilities.
 *
 * @module req-hub
 */

import { createConfigRoutes } from './routes/config-routes.js';
import { createTreeRoutes } from './routes/tree-routes.js';
import { createCreationRoutes } from './routes/creation-routes.js';
import { createSyncRoutes } from './routes/sync-routes.js';
import { createWritingRoutes } from './routes/writing-routes.js';
import { createEnhancementRoutes } from './routes/enhancement-routes.js';
import { createKnowledgeRoutes } from './routes/knowledge-routes.js';
import { createWikiRoutes } from './routes/wiki-routes.js';
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
export const inject = [
  'workspaceRegistry',
  'connection',
  'webServer',
  'llm',
  'sessions',
  'skills',
  'agents',
  'agentPresets',
  'sessionQuery',
  'subagents',
  'sessionProjections',
  'tools',
];

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
export function apply(ctx, config = {}) {
  // ctx.get is Cordis' optional-service lookup; profile launchers provide this
  // before activating bundles. Shell environment variables are only a fallback.
  const profile = ctx.get?.('profileContext');
  const releaseConfig = configureStorage(config, {
    filePath: profile?.dir ? join(profile.dir, 'req-hub', 'config.json') : undefined,
  });
  const {
    workspaceRegistry,
    webServer,
    llm,
    sessions,
    skills,
    agents,
    agentPresets,
    sessionQuery,
    subagents,
    sessionProjections,
  } = ctx;

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
    hasSessionProjections: !!sessionProjections,
  });

  const disposers = [releaseConfig];
  const knowledge = createKnowledgeRoutes(workspaceRegistry);
  const wiki = createWikiRoutes(knowledge.service, ctx);
  wiki.service.database();
  knowledge.service.wiki = wiki.service;
  wiki.service.track(
    wiki.service.resume().catch((error) => {
      log.startup.warn('WIKI_RESUME_FAILED: ' + error.message);
    }),
  );
  disposers.push(
    ctx.on('agent/created', () =>
      wiki.service.track(
        wiki.service.resume().catch((error) => {
          log.startup.warn('WIKI_RESUME_FAILED: ' + error.message);
        }),
      ),
    ),
  );
  disposers.push(() => wiki.dispose());
  const enhancements = createEnhancementRoutes(knowledge.service, ctx);
  disposers.push(() => enhancements.dispose());
  const writing = createWritingRoutes(workspaceRegistry, llm, agents, ctx, knowledge.service);
  const creation = createCreationRoutes(workspaceRegistry);
  disposers.push(() => creation.dispose());
  disposers.push(() => writing.dispose());
  disposers.push(() => knowledge.dispose());
  const syncTools = installSyncTools(ctx);
  if (syncTools) {
    disposers.push(() => syncTools.dispose());
  }

  const syncRoutes = createSyncRoutes(workspaceRegistry, llm, sessions, agents, ctx, {
    knowledgeService: knowledge.service,
  });

  const routes = [
    ...wiki.routes,
    ...enhancements.routes,
    ...knowledge.routes,

    ...createConfigRoutes(workspaceRegistry, llm),

    ...createTreeRoutes(workspaceRegistry, { knowledgeService: knowledge.service }),
    ...creation.routes,

    ...syncRoutes,

    ...writing.routes,

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
      },
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
      },
    },

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
          tags: getLogTags(),
        });
      },
    },

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
          const searchResult = await sessionQuery.searchSessions({ query: titleQuery });
          const hits = searchResult?.items || [];

          const matchedSessions = [];
          for (const hit of hits) {
            let title = '';
            try {
              const titleObs = await sessionQuery.readTitle(hit.header.id);
              title = titleObs?.title || '';
            } catch (error) {
              // An unreadable title cannot match this optional diagnostic query.
            }

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

          matchedSessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          const targetSession = matchedSessions[0];

          let descendants = [];
          try {
            descendants = await subagents.listDescendants(targetSession.id);
          } catch (e) {
            descendants = [];
          }

          const subagentDetails = [];
          for (const desc of descendants) {
            if (desc.kind !== 'child') {
              continue;
            }

            let lastEventTime = null;
            let lastEventType = null;
            let hasActiveTurn = false;
            let eventCount = 0;

            try {
              const observation = await sessionQuery.observeSession(desc.id);
              const events = observation?.events || [];
              eventCount = events.length;

              if (events.length > 0) {
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

                const latest = events[events.length - 1];
                lastEventTime = latest.time || null;
                lastEventType = latest.type || null;
              }
            } catch (error) {
              // Keep diagnostic fields unset when the session events cannot be read.
            }

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
      },
    },

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

        let scopeLease;
        try {
          let cwd = undefined;
          if (workspaceId) {
            const workspaces = workspaceRegistry.list();
            const workspace = workspaces.find((w) => w.id === workspaceId);
            if (workspace) {
              cwd = workspace.path;
            }
          }

          let skillRegistry = skills;
          let scope = undefined;

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
                    const lease = (scopeLease = await agentPresets.acquireScope(agentPreset));
                    if (lease) {
                      scope = lease.key;
                      // Release the acquired preset scope in the surrounding finally block.
                    }
                  } catch (e) {
                    // Use the global skill catalog when a preset scope is unavailable.
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

          log.startup.debug(`Fetching skills list`, {
            cwd,
            sessionId,
            scoped: skillRegistry !== skills,
          });

          const skillsList = await skillRegistry.list(cwd ? { cwd, scope } : { scope });

          const userSkills = skillsList.filter((s) => s.invocation.userInvocable);

          log.startup.debug(`Skills list result`, {
            count: userSkills.length,
          });

          json(res, {
            skills: userSkills.map((s) => ({
              name: s.name,
              description: s.description,
              whenToUse: s.whenToUse,
              source: s.source,
              modelInvocable: s.invocation.modelInvocable,
              userInvocable: s.invocation.userInvocable,
            })),
            debug: {
              cwd,
              workspaceId,
              sessionId,
              scoped: skillRegistry !== skills,
            },
          });
        } catch (e) {
          log.startup.error(`获取 skills 失败: ${e.message}`, { stack: e.stack });
          json(res, { skills: [], error: e.message }, 500);
        } finally {
          await scopeLease?.[Symbol.asyncDispose]();
        }
      },
    },

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

        let scopeLease;
        try {
          let cwd = undefined;
          if (workspaceId) {
            const workspaces = workspaceRegistry.list();
            const workspace = workspaces.find((w) => w.id === workspaceId);
            if (workspace) {
              cwd = workspace.path;
            }
          }

          let skillRegistry = skills;
          let scope = undefined;

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
                    const lease = (scopeLease = await agentPresets.acquireScope(agentPreset));
                    if (lease) {
                      scope = lease.key;
                    }
                  } catch (e) {
                    // Use the global skill catalog when a preset scope is unavailable.
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
            provider: skill.provider,
          });
        } catch (e) {
          log.startup.error(`获取 skill 内容失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        } finally {
          await scopeLease?.[Symbol.asyncDispose]();
        }
      },
    },
  ];

  const operations = createOperations(routes);
  disposers.push(installOperationTool(ctx, operations));

  let closing;
  const cleanup = () =>
    (closing ||= disposeAll([
      () => syncRoutes.dispose(),
      ...disposers.slice(1),
      releaseConfig,
    ]).then(() => {
      log.startup.info('ReqHub 插件卸载');
    }));
  // Cordis owns effects; returning a function from apply alone is insufficient.
  ctx.effect(() => cleanup, 'req-hub: lifecycle');
  for (const route of operations.routes) {
    disposers.push(webServer.register(authenticatedRoute(ctx.connection, route)));
  }
  log.startup.info(`已注册 ${routes.length} 个路由`);
  return cleanup;
}
