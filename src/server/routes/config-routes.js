import { createConfigApplication } from '../application/config.js';
import { msg } from '../messages.js';
/**
 * Configuration routes module.
 * Handles configuration-related HTTP endpoints.
 * @module routes/config-routes
 */

import { loadConfig } from '../config.js';
import { PROMPT_REGISTRY, getPrompt, getPromptMeta, validatePromptTemplate } from '../prompts.js';
import { json, readBody } from '../utils.js';
import { log } from '../logger.js';

/**
 * Create configuration routes.
 * @param {Object} registry - Workspace registry service
 * @param {Object} llm - LLM service
 * @param {Object} ctx - Host services used to resolve the active skill scope.
 * @param {Object} [options] - Callback after successful saves, with effective and previous values.
 * @returns {Array<Object>} Array of route definitions
 */
export function createConfigRoutes(registry, llm, ctx = {}, options = {}) {
  const application = createConfigApplication(registry, ctx, options);
  return [
    {
      kind: 'exact',
      path: '/req-hub/config',
      operation: {
        action: 'config',
        methods: ['GET', 'POST'],
        execute: (input, caller, _onEvent, method) =>
          method === 'GET' ? application.read(input, caller) : application.save(input, caller),
      },
      async handler(req, res) {
        try {
          const caller = {
            kind: req.operationExec ? 'agent' : 'user',
            agent: req.operationExec?.agent || ctx.agents?.get(req.headers?.['x-session-id']),
            signal: req.operationExec?.signal,
          };
          let result;
          if (req.method === 'GET') {
            result = await application.read(
              { workspaceId: req.headers?.['x-workspace-id'] },
              caller,
            );
            res.setHeader?.('Cache-Control', 'no-store');
          } else if (req.method === 'POST') {
            result = await application.save(JSON.parse(await readBody(req)), caller);
          } else {
            return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
          }
          return json(res, result.value, result.status);
        } catch (error) {
          return json(
            res,
            {
              error: error.code || error.message,
              ...(error.details ? { details: error.details } : {}),
            },
            error.status || 500,
          );
        }
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
            log.config.warn(msg('LOG_GET_MODELS_FAILED', { v0: e.message }));
          }

          json(res, {
            provider: providerName,
            providerId: providerId,
            models: models,
          });
        } catch (e) {
          log.config.error(msg('LOG_GET_LLM_CONFIG_FAILED', { v0: e.message }));
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
          let providerName = 'CONFIG_NOT_CONFIGURED';
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
            model: selectedModel || 'CONFIG_NOT_SELECTED',
            hasCustomPrompt: Object.keys(PROMPT_REGISTRY).some(
              (key) =>
                !!(
                  key.startsWith('phased-') ? ai.syncV2?.prompts?.[key] : ai.prompts?.[key]
                )?.trim(),
            ),
          });
        } catch (e) {
          log.config.error(msg('LOG_GET_AI_CONFIG_FAILED', { v0: e.message }));
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
          log.config.error(msg('LOG_GET_PROMPT_REGISTRY_FAILED', { v0: e.message }));
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
              json(res, { error: 'ERR_MISSING_PROMPT_KEY_OR_TEMPLATE' }, 400);
              return;
            }

            const result = validatePromptTemplate(promptKey, template);
            json(res, result);
          } catch (e) {
            log.config.error(msg('LOG_VALIDATE_PROMPT_FAILED', { v0: e.message }));
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
          json(res, { error: 'ERR_MISSING_KEY_PARAM' }, 400);
          return;
        }

        try {
          const meta = getPromptMeta(promptKey);
          if (!meta) {
            json(res, { error: msg('ERR_PROMPT_KEY_NOT_FOUND', { v0: promptKey }) }, 404);
            return;
          }
          json(res, meta);
        } catch (e) {
          log.config.error(msg('LOG_GET_PROMPT_META_FAILED', { v0: e.message }));
          json(res, { error: e.message }, 500);
        }
      },
    },
  ];
}
