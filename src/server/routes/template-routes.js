/**
 * Template generation routes module.
 * Handles document template generation HTTP endpoints.
 * All LLM calls are delegated to DSH Subagent.
 * @module routes/template-routes
 */

import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { buildTree, findRequirementPath } from '../tree.js';
import { getPrompt } from '../prompts.js';
import { executeTask } from '../task-executor.js';
import { json, readBody } from '../utils.js';
import { log } from '../logger.js';

/** @type {string} Default requirement document template */
const REQUIREMENT_TEMPLATE = `# 需求文档

## 功能描述
[描述需求的功能和特性]

## 技术方案
[描述技术实现方案]

## 数据库变更
[描述数据库表结构和字段变更]

## 接口变更
[描述 API 接口的变更]

## 测试要点
[描述需要测试的关键点]
`;

/** @type {string} Default technical design template */
const DESIGN_TEMPLATE = `# 技术方案

## 背景
[描述技术方案的背景]

## 目标
[描述技术方案要达成的目标]

## 方案设计
[详细描述技术实现方案]

## 数据库设计
[描述数据库表结构设计]

## 接口设计
[描述 API 接口设计]

## 风险评估
[描述可能的风险和应对措施]
`;

/** @type {string} Default code review template */
const CR_TEMPLATE = `# CR 记录

## 变更概述
[描述本次变更的主要内容]

## 变更详情
[详细描述变更的内容]

## 影响范围
[描述变更影响的范围]

## 测试情况
[描述测试的情况和结果]

## 注意事项
[描述需要特别注意的事项]
`;

/** @type {Object<string, string>} Template map by document type */
const TEMPLATES = {
  requirement: REQUIREMENT_TEMPLATE,
  design: DESIGN_TEMPLATE,
  cr: CR_TEMPLATE
};

/**
 * Create template generation routes.
 * @param {Object} registry - Workspace registry service
 * @param {Object} llm - LLM service
 * @param {Object} agents - Agents service
 * @param {Object} ctx - DSH context
 * @returns {Array<Object>} Array of route definitions
 */
export function createTemplateRoutes(registry, llm, agents, ctx) {
  return [
    // GET /templates - 获取模板列表
    {
      kind: 'exact',
      path: '/req-hub/templates',
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        json(res, {
          requirement: {
            label: '需求文档',
            icon: '📋',
            fileName: 'requirement.md',
            content: REQUIREMENT_TEMPLATE
          },
          design: {
            label: '技术方案',
            icon: '📐',
            fileName: 'design.md',
            content: DESIGN_TEMPLATE
          },
          cr: {
            label: 'CR 记录',
            icon: '🔍',
            fileName: 'cr-notes.md',
            content: CR_TEMPLATE
          }
        });
      }
    },

    // POST /generate-template - 生成模板文件
    {
      kind: 'exact',
      path: '/req-hub/generate-template',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const body = await readBody(req);
          const { workspaceId, requirementId, docType, useAI, sessionId } = JSON.parse(body);

          if (!workspaceId || !requirementId || !docType) {
            json(res, { error: 'missing required fields' }, 400);
            return;
          }

          if (!TEMPLATES[docType]) {
            json(res, { error: `unknown docType: ${docType}` }, 400);
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
          const tree = await buildTree(docsRoot);
          const found = findRequirementPath(docsRoot, tree, requirementId);

          if (!found) {
            json(res, { error: 'requirement not found' }, 404);
            return;
          }

          let content;
          if (useAI) {
            // AI 生成需要 sessionId 来获取父 Agent
            if (!sessionId) {
              json(res, { error: 'AI 生成需要 sessionId - 请在 DSH 会话中调用此功能' }, 400);
              return;
            }

            const parentAgent = agents?.get(sessionId);
            if (!parentAgent) {
              json(res, { error: '会话不存在或已结束，请在活跃的 DSH 会话中调用此功能' }, 400);
              return;
            }

            try {
              log.template.info(`AI 生成 ${docType} 模板...`);
              
              const docTypeName = docType === 'requirement' ? '需求文档' : docType === 'design' ? '技术方案' : 'CR记录';
              
              // 使用模板变量
              const variables = {
                docTypeName,
                requirementId,
                path: found.path,
              };
              
              // 使用 TaskExecutor 执行
              const result = await executeTask(ctx, llm, config, {
                promptKey: 'template',
                variables,
                parentAgent,
                cwd: workspace.path,
                description: `生成${docTypeName}模板`,
              });

              if (result.isError) {
                throw new Error(result.diagnostic || 'AI 生成失败');
              }

              content = result.output;
              log.template.info(`AI 生成 ${docType} 模板完成`);
            } catch (err) {
              log.template.warn(`AI 生成失败，降级为静态模板: ${err.message}`);
              content = TEMPLATES[docType];
            }
          } else {
            content = TEMPLATES[docType];
          }

          const fileName = docType === 'cr' ? 'cr-notes.md' : `${docType}.md`;
          const filePath = join(found.path, fileName);

          await writeFile(filePath, content, 'utf8');
          log.template.info(`生成${docType}文档模板: ${fileName}`);

          json(res, {
            success: true,
            path: filePath,
            fileName,
            content
          });
        } catch (e) {
          log.template.error(`生成模板失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    }
  ];
}
