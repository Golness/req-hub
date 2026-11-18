import { ConversationFiles } from './conversation-files.js';
import { resolveScope } from './knowledge-v2/scope.js';
import { safeDocumentPath } from './safe-path.js';
import { msg } from './messages.js';
import { createOperations, installOperationTool } from './operations.js';
import { authenticatedRoute, createLifecycle } from './plugin-boundaries.js';
import { createConfigRepository, loadConfig, Config } from './config.js';
import { join } from 'node:path';
import { installSubagentScheduler } from './concurrency/SubagentScheduler.js';
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
import { createLarkCliRoutes } from './lark-cli.js';
import { DocumentReplicas } from './document-replicas.js';
import { createDocumentRoutes } from './routes/document-routes.js';
import { createTreeRoutes } from './routes/tree-routes.js';
import { createCreationRoutes } from './routes/creation-routes.js';
import { createSyncRoutes } from './routes/sync-routes.js';
import { DailyReports, requirementGroup } from './daily-reports.js';
import { createDailyBriefGenerator } from './daily-brief.js';
import { createDailyReportRoutes } from './routes/daily-report-routes.js';
import { TaskReports } from './task-reports.js';
import { SyncDailyScheduler } from './sync-daily-scheduler.js';
import { createWritingRoutes } from './routes/writing-routes.js';
import { createEnhancementRoutes } from './routes/enhancement-routes.js';
import { createKnowledgeApplication } from './knowledge-v2/application.js';
import { createKnowledgeV2Routes } from './routes/knowledge-v2-routes.js';
import { log, getLogs, clearLogs, getLogLevels, getLogTags } from './logger.js';
import { json } from './utils.js';
import { setSkillsService } from './prompts.js';
import { setContentLanguage } from './content-templates.js';

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
  'agentDefaultModel',
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
 * @returns {Promise<Function>} Disposer after initialization; failures await rollback.
 */
export async function apply(ctx, config = {}) {
  // ctx.get is Cordis' optional-service lookup; profile launchers provide this
  // before activating bundles. Shell environment variables are only a fallback.
  const profile = ctx.get?.('profileContext');
  const repository = createConfigRepository(config, {
    filePath: profile?.dir ? join(profile.dir, 'req-hub', 'config.json') : undefined,
  });
  return repository.run(async () => {
    const lifecycle = createLifecycle();
    lifecycle.own(() => repository.close());
    const cleanup = () => lifecycle.close();
    ctx.effect(() => cleanup, 'req-hub: lifecycle');
    try {
      setContentLanguage(config?.general?.contentLanguage);
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
      const subagentScheduler = installSubagentScheduler(subagents);
      lifecycle.own(
        () => subagentScheduler.close(),
        () => subagentScheduler.beginClose(),
      );

      log.startup.info('LOG_PLUGIN_STARTED');
      log.startup.debug('LOG_AVAILABLE_SERVICES', {
        hasSessions: !!sessions,
        hasSkills: !!skills,
        hasLlm: !!llm,
        hasAgents: !!agents,
        hasAgentPresets: !!agentPresets,
        hasSessionQuery: !!sessionQuery,
        hasSubagents: !!subagents,
        hasSessionProjections: !!sessionProjections,
      });

      const lark = createLarkCliRoutes(workspaceRegistry);
      lifecycle.own(() => lark.dispose());
      const dailyReports = new DailyReports({ registry: workspaceRegistry });
      lifecycle.own(
        () => dailyReports.close(),
        () => dailyReports.beginClose(),
      );
      const documents = new DocumentReplicas({ registry: workspaceRegistry, lark });
      const conversationFiles = new ConversationFiles({ registry: workspaceRegistry });
      lifecycle.own(
        () => conversationFiles.close(),
        () => conversationFiles.beginClose(),
      );
      dailyReports.onBrief = (workspaceId, path) =>
        documents.committed(workspaceId, path, 'daily-brief');
      lifecycle.own(
        () => documents.close(),
        () => documents.beginClose(),
      );
      await documents.start();
      const reports = new TaskReports(workspaceRegistry);
      lifecycle.own(() => reports.close());
      const knowledgeV2 = createKnowledgeApplication({
        ctx,
        registry: workspaceRegistry,
        profileDir: profile?.dir,
        lark,
        onSyncError: (error) => log.startup.warn('KNOWLEDGE_SYNC_FAILED: ' + error.message),
      });
      lifecycle.own(
        () => knowledgeV2.close(),
        () => knowledgeV2.beginClose(),
      );
      dailyReports.generateBrief = createDailyBriefGenerator(ctx, knowledgeV2.installation);
      lifecycle.own(() => dailyReports.execution);
      dailyReports.knowledgeFile = async (file) => {
        const workspace = workspaceRegistry.list().find((item) => item.id === file.workspaceId);
        const config = await loadConfig();
        const scope = await resolveScope({
          root: knowledgeV2.root,
          workspace,
          docsDir: config.docsDir,
        });
        if (scope.scopeId !== file.knowledgeScopeId) {
          throw Object.assign(new Error('DAILY_SOURCE_UNAVAILABLE'), {
            code: 'DAILY_SOURCE_UNAVAILABLE',
          });
        }
        const root = await safeDocumentPath(scope.dir, 'releases/' + file.release + '/wiki');
        return { root, path: file.pageId + '.md' };
      };
      knowledgeV2.onPublished = (store, result) => {
        if (!result.generationId) {
          return;
        }
        for (const page of result.artifacts || []) {
          const groups = new Set(page.sourcePaths.map(requirementGroup));
          void dailyReports
            .published(
              store.scope.workspaceId,
              { pageId: page.pageId, hash: page.hash, knowledgeScopeId: store.scope.scopeId },
              groups.size === 1 ? [...groups][0] : '',
              result.generationId,
            )
            .catch((error) => {
              if (!dailyReports.controller.signal.aborted) {
                dailyReports.scanErrors.set(
                  store.scope.workspaceId,
                  error.code || 'DAILY_CAPTURE_FAILED',
                );
              }
            });
        }
      };
      knowledgeV2.reports = reports;
      knowledgeV2.onJobChange = (job) => reports.knowledgeJob(job);
      const enhancements = createEnhancementRoutes(knowledgeV2.context, ctx);
      lifecycle.own(
        () => enhancements.dispose(),
        () => enhancements.service.beginClose(),
      );
      const writing = createWritingRoutes(
        workspaceRegistry,
        llm,
        agents,
        ctx,
        knowledgeV2.context,
        {
          documents,
          dailyReports,
        },
      );
      lifecycle.own(
        () => writing.dispose(),
        () => writing.beginClose(),
      );
      const creation = createCreationRoutes(workspaceRegistry);
      lifecycle.own(() => creation.dispose());
      const syncTools = installSyncTools(ctx);
      if (syncTools) {
        lifecycle.own(() => syncTools.dispose());
      }

      const syncRoutes = createSyncRoutes(workspaceRegistry, llm, sessions, agents, ctx, {
        knowledgeV2,
        documents,
        dailyReports,
        conversationFiles,
      });
      lifecycle.own(
        () => syncRoutes.dispose(),
        () => syncRoutes.beginClose(),
      );
      const scheduledSync = new SyncDailyScheduler({
        registry: workspaceRegistry,
        knowledge: knowledgeV2,
        reports,
        routes: syncRoutes,
        lark,
      });

      lifecycle.own(
        () => scheduledSync.close(),
        () => scheduledSync.beginClose(),
      );

      // Optional timer support must not make document management depend on a new service.
      if (ctx.inject) {
        const timerScope = ctx.inject(['timer'], (timerCtx) => {
          scheduledSync.useTimeout((callback, delay) => timerCtx.timeout(callback, delay));
          return () => scheduledSync.useTimeout();
        });
        lifecycle.own(() => timerScope.dispose());
      }

      const routes = [
        ...createKnowledgeV2Routes(knowledgeV2),
        ...enhancements.routes,

        ...createConfigRoutes(workspaceRegistry, llm, ctx, {
          onSaved: async (config, previous) => {
            const pending = [];
            if (
              JSON.stringify(config.documents) !== JSON.stringify(previous.documents) ||
              config.docsDir !== previous.docsDir
            ) {
              pending.push(documents.refresh());
            }
            setContentLanguage(config.general?.contentLanguage);
            const zoneChanged = config.general?.timeZone !== previous.general?.timeZone;
            if (
              zoneChanged ||
              config.docsDir !== previous.docsDir ||
              JSON.stringify(config.dailyReports) !== JSON.stringify(previous.dailyReports)
            ) {
              pending.push(dailyReports.refresh());
            }
            const keys = ['dailyUpdateEnabled', 'dailyUpdateTime', 'dailyOffsetDays'];
            if (
              config.defaultUsername !== previous.defaultUsername ||
              zoneChanged ||
              keys.some((key) => config.sync?.[key] !== previous.sync?.[key])
            ) {
              pending.push(scheduledSync.refresh());
            }
            const knowledgeKeys = [
              'autoManage',
              'autoManageDelayMs',
              'dailyUpdateEnabled',
              'dailyImportConversations',
              'dailyUpdateTime',
            ];
            if (
              zoneChanged ||
              knowledgeKeys.some((key) => config.knowledgeV2?.[key] !== previous.knowledgeV2?.[key])
            ) {
              pending.push(knowledgeV2.sync.refresh());
            }
            const results = await Promise.allSettled(pending);
            const failures = results.filter((result) => result.status === 'rejected');
            if (failures.length) {
              throw new AggregateError(
                failures.map((result) => result.reason),
                'ReqHub configuration application failed',
              );
            }
          },
        }),
        ...lark.routes,
        ...createDocumentRoutes(workspaceRegistry, documents),
        ...reports.routes(),
        ...createDailyReportRoutes(workspaceRegistry, dailyReports),

        ...createTreeRoutes(workspaceRegistry, {
          knowledgeService: knowledgeV2,
          documents,
          dailyReports,
        }),
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
            log.startup.info('LOG_CLEARED');
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
                json(res, {
                  error: msg('SESSION_NOT_FOUND_BY_TITLE', { v0: titleQuery }),
                  sessions: [],
                });
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
                  label: desc.label || 'STATUS_NO_TAG',
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
              json(res, { skills: [], error: 'ERR_SKILLS_SERVICE_UNAVAILABLE' });
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
              log.startup.error(msg('ERR_FETCH_SKILLS_FAILED', { v0: e.message }), {
                stack: e.stack,
              });
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
              json(res, { error: 'ERR_SKILLS_SERVICE_UNAVAILABLE' }, 500);
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
              log.startup.error(msg('ERR_FETCH_SKILL_CONTENT_FAILED', { v0: e.message }));
              json(res, { error: e.message }, 500);
            } finally {
              await scopeLease?.[Symbol.asyncDispose]();
            }
          },
        },
      ];

      const operations = createOperations(routes);
      lifecycle.admit(
        installOperationTool(ctx, operations, (callback) => {
          if (lifecycle.closed) {
            throw new Error('REQ_HUB_CLOSED');
          }
          return lifecycle.run(() => repository.run(callback));
        }),
      );
      for (const route of operations.routes) {
        const handler = route.handler;
        lifecycle.admit(
          webServer.register(
            authenticatedRoute(ctx.connection, {
              ...route,
              handler: (req, res) => {
                if (lifecycle.closed) {
                  return json(res, { error: 'REQ_HUB_CLOSED' }, 503);
                }
                return lifecycle.run(() => repository.run(() => handler(req, res)));
              },
            }),
          ),
        );
      }
      const startup = knowledgeV2.sync.start().catch((error) => {
        log.startup.warn('KNOWLEDGE_SYNC_START_FAILED: ' + error.message);
      });
      lifecycle.own(() => startup);
      const dailyStartup = dailyReports.refresh().catch((error) => {
        log.startup.warn('DAILY_START_FAILED: ' + error.message);
      });
      lifecycle.own(() => dailyStartup);
      void scheduledSync.refresh().catch((error) => {
        log.startup.warn('SYNC_SCHEDULE_REFRESH_FAILED: ' + error.message);
      });
      log.startup.info(msg('LOG_ROUTES_REGISTERED', { v0: routes.length }));
      return cleanup;
    } catch (cause) {
      try {
        await cleanup();
      } catch (error) {
        throw new AggregateError([cause, error], 'ReqHub initialization and rollback failed');
      }
      throw cause;
    }
  });
}
