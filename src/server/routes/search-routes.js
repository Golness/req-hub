/**
 * Search routes module.
 * Handles search-related HTTP endpoints.
 * All LLM calls are delegated to DSH Subagent.
 * @module routes/search-routes
 */

import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { buildTree } from '../tree.js';
import { loadIndex } from '../index-manager.js';
import { executeTask } from '../task-executor.js';
import { parseAIResponse } from '../ai-engine.js';
import { json, readBody } from '../utils.js';
import { log } from '../logger.js';

/**
 * Create search routes.
 * @param {Object} registry - Workspace registry service
 * @param {Object} llm - LLM service
 * @param {Object} agents - Agents service
 * @param {Object} ctx - DSH context
 * @returns {Array<Object>} Array of route definitions
 */
export function createSearchRoutes(registry, llm, agents, ctx) {
  return [
    // GET /search - 精确搜索
    {
      kind: 'exact',
      path: '/req-hub/search',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
        const type = url.searchParams.get('type') || 'all';

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

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);
        const index = await loadIndex(docsRoot);

        if (!index) {
          json(res, { results: [], total: 0, indexBuilt: false });
          return;
        }

        const results = [];
        const queryLower = query.toLowerCase();

        for (const req of index.requirements) {
          let matched = false;
          const matchedFields = [];
          const matchedFeatures = [];
          const matchedTags = [];

          if (type === 'all' || type === 'feature') {
            for (const feature of req.features || []) {
              if (feature.toLowerCase().includes(queryLower)) {
                matched = true;
                matchedFeatures.push(feature);
              }
            }
          }

          if (type === 'all' || type === 'field') {
            for (const field of req.fields || []) {
              if (field.toLowerCase().includes(queryLower)) {
                matched = true;
                matchedFields.push(field);
              }
            }
          }

          if (type === 'all' || type === 'tag') {
            for (const tag of req.tags || []) {
              if (tag.toLowerCase().includes(queryLower)) {
                matched = true;
                matchedTags.push(tag);
              }
            }
          }

          if (matched) {
            results.push({
              id: req.id,
              developer: req.developer,
              date: req.date,
              title: req.title,
              matchedFeatures,
              matchedFields,
              matchedTags
            });
          }
        }

        json(res, { results, total: results.length, indexBuilt: true });
      }
    },

    // POST /ai-search - AI 语义搜索
    {
      kind: 'exact',
      path: '/req-hub/ai-search',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const body = await readBody(req);
          const { workspaceId, query, sessionId } = JSON.parse(body);

          if (!workspaceId || !query) {
            json(res, { error: 'missing workspaceId or query' }, 400);
            return;
          }

          if (!sessionId) {
            json(res, { error: 'missing sessionId - AI 搜索需要在 DSH 会话中调用' }, 400);
            return;
          }

          // 获取父 Agent
          const parentAgent = agents?.get(sessionId);
          if (!parentAgent) {
            json(res, { error: '会话不存在或已结束，请在活跃的 DSH 会话中调用此功能' }, 400);
            return;
          }

          const workspaces = registry.list();
          const workspace = workspaces.find(w => w.id === workspaceId);

          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir);
          const index = await loadIndex(docsRoot);

          if (!index) {
            json(res, { error: 'index not built' }, 400);
            return;
          }

          // Set up SSE
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const sendEvent = (data) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          };

          sendEvent({ type: 'status', text: '🧠 AI 正在分析...' });

          // 构建模板变量
          const requirementsSummary = index.requirements.map(r => 
            `- ${r.id}: ${r.title} (${r.developer})`
          ).join('\n');

          const variables = {
            query,
            requirementsSummary,
          };

          sendEvent({ type: 'stream_start' });

          try {
            // 使用 TaskExecutor 执行
            const result = await executeTask(ctx, llm, config, {
              promptKey: 'search',
              variables,
              parentAgent,
              cwd: workspace.path,
              description: 'AI 语义搜索',
            });

            if (result.isError) {
              sendEvent({ type: 'error', error: result.diagnostic || 'AI 分析失败' });
              res.end();
              return;
            }

            sendEvent({ type: 'stream_delta', text: result.output });
            sendEvent({ type: 'stream_end' });

            const aiResult = parseAIResponse(result.output);
            if (!aiResult || !aiResult.results) {
              sendEvent({ type: 'error', error: 'AI 返回格式错误' });
              res.end();
              return;
            }

            // Build full results
            const results = aiResult.results.map(r => {
              const req = index.requirements.find(req => req.id === r.id);
              return {
                id: r.id,
                developer: req?.developer,
                date: req?.date,
                title: req?.title,
                relevance: r.relevance,
                reason: r.reason
              };
            }).filter(r => r.id);

            sendEvent({ 
              type: 'done', 
              results, 
              total: results.length,
              elapsed: result.elapsed
            });
            res.end();
          } catch (e) {
            sendEvent({ type: 'error', error: e.message });
            res.end();
          }
        } catch (e) {
          log.search.error(`AI 搜索失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    }
  ];
}
