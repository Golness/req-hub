/**
 * Configuration routes module.
 * Handles configuration-related HTTP endpoints.
 * @module routes/config-routes
 */

import { loadConfig, saveConfig, autoDefaultConfig } from '../config.js';
import {
  PROMPT_REGISTRY,
  getPrompt,
  getAllPromptMetas,
  getPromptMeta,
  validatePromptTemplate,
  defaultSkillBindings,
} from '../prompts.js';
import { json, readBody } from '../utils.js';
import { log } from '../logger.js';

/**
 * Create configuration routes.
 * @param {Object} registry - Workspace registry service
 * @param {Object} llm - LLM service
 * @param {Object} ctx - Host services used to resolve the active skill scope.
 * @returns {Array<Object>} Array of route definitions
 */
export function createConfigRoutes(registry, llm, ctx = {}) {
  return [
    // GET and POST share one registration because the router matches paths before methods.
    {
      kind: 'exact',
      path: '/req-hub/config',
      async handler(req, res) {
        if (req.method === 'GET') {
          try {
            let config = await loadConfig();
            config = await autoDefaultConfig(config, registry);
            const sessionId = req.headers?.['x-session-id'];
            const parent = typeof sessionId === 'string' ? ctx.agents?.get(sessionId) : undefined;
            const scopedSkills = parent
              ? ctx.agentPresets?.serviceFor?.(parent, 'skills') || ctx.skills
              : ctx.skills;
            const workspaceId = req.headers?.['x-workspace-id'] || config.workspaceId;
            config = await defaultSkillBindings(config, scopedSkills, {
              cwd:
                parent?.session?.header?.cwd ||
                registry.list().find((item) => item.id === workspaceId)?.path,
              scope: parent,
            });

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              Pragma: 'no-cache',
            });
            res.end(JSON.stringify(config));
          } catch (e) {
            log.config.error(`GET /config 失败: ${e.message}`);
            json(res, { error: e.message }, 500);
          }
          return;
        }

        if (req.method === 'POST') {
          try {
            const body = await readBody(req);
            const newConfig = JSON.parse(body);
            const existing = await loadConfig();

            // Deep merge for ai object
            const merged = {
              ...existing,
              ...newConfig,
              ai: {
                ...existing.ai,
                ...newConfig.ai,
                prompts: {
                  ...existing.ai?.prompts,
                  ...newConfig.ai?.prompts,
                },
              },
            };

            await saveConfig(merged);
            log.config.info('配置已更新');
            json(res, merged);
          } catch (e) {
            log.config.error(`POST /config 失败: ${e.message}`);
            json(res, { error: e.message }, 500);
          }
          return;
        }

        res.writeHead(405);
        res.end();
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/llm-config',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const providers = await llm.listProviders();
          if (!Array.isArray(providers) || providers.length === 0) {
            json(res, { error: 'No LLM providers configured' }, 500);
            return;
          }

          const firstProvider = providers[0];
          const providerId = firstProvider.id || firstProvider.name || firstProvider;
          const providerName = firstProvider.name || firstProvider.id || firstProvider;

          let models = [];
          try {
            const modelList = await llm.listModels(providerId);
            if (Array.isArray(modelList)) {
              models = modelList.map((m) => m.id || m.name || m);
            }
          } catch (e) {
            log.config.warn(`获取模型列表失败: ${e.message}`);
          }

          json(res, {
            provider: providerName,
            providerId: providerId,
            models: models,
          });
        } catch (e) {
          log.config.error(`获取 LLM 配置失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/ai-config',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const config = await loadConfig();
          const ai = config.ai || {};

          // Get real provider/model info from DSH global config
          let providerName = '(未配置)';
          let selectedModel = ai.selectedModel || null;

          if (llm) {
            try {
              const providers = await llm.listProviders();
              if (Array.isArray(providers) && providers.length > 0) {
                const firstProvider = providers[0];
                providerName = firstProvider.name || firstProvider.id || firstProvider;
              }
            } catch (error) {
              // Provider metadata is optional; leave the provider name unset when inspection fails.
            }
          }

          json(res, {
            enabled: ai.enabled !== false,
            provider: providerName,
            model: selectedModel || '(未选择)',
            hasCustomPrompt: Object.keys(PROMPT_REGISTRY).some(
              (key) =>
                !!(
                  key.startsWith('phased-') ? ai.syncV2?.prompts?.[key] : ai.prompts?.[key]
                )?.trim(),
            ),
          });
        } catch (e) {
          log.config.error(`GET /ai-config 失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/prompt-registry',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const config = await loadConfig();
          const result = {};

          for (const [key, meta] of Object.entries(PROMPT_REGISTRY)) {
            result[key] = {
              label: meta.label,
              description: meta.description,
              category: meta.category || 'default',
              variables: meta.variables || [],
              outputFormat: meta.outputFormat || 'text',
              requirements: meta.requirements || [],
              default: meta.default,
              current: getPrompt(config, key),
              contractVersion: meta.contractVersion || 1,
              generatesFileContent: !!meta.generatesFileContent,
              isCustom: !!(meta.contractVersion === 2 ? config.ai?.syncV2 : config.ai)?.prompts?.[
                key
              ]?.trim(),
            };
          }

          json(res, result);
        } catch (e) {
          log.config.error(`获取 Prompt 注册表失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/prompt-validate',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const { promptKey, template } = JSON.parse(body);

            if (!promptKey || !template) {
              json(res, { error: '缺少 promptKey 或 template' }, 400);
              return;
            }

            const result = validatePromptTemplate(promptKey, template);
            json(res, result);
          } catch (e) {
            log.config.error(`验证 prompt 失败: ${e.message}`);
            json(res, { error: e.message }, 500);
          }
        });
      },
    },

    {
      kind: 'exact',
      path: '/req-hub/prompt-meta',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const promptKey = url.searchParams.get('key');

        if (!promptKey) {
          json(res, { error: '缺少 key 参数' }, 400);
          return;
        }

        try {
          const meta = getPromptMeta(promptKey);
          if (!meta) {
            json(res, { error: `未找到 promptKey: ${promptKey}` }, 404);
            return;
          }
          json(res, meta);
        } catch (e) {
          log.config.error(`获取 prompt 元信息失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      },
    },
  ];
}
