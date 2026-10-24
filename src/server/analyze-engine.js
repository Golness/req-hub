/**
 * Requirement analysis engine.
 * Analyzes requirement documents and generates .meta.json metadata.
 * All LLM calls are delegated to DSH Subagent.
 * @module analyze-engine
 */

import { join } from 'node:path';
import { loadConfig } from './config.js';
import { readRequirementDocs, writeMetaJson } from './doc-reader.js';
import { validateMeta } from './meta.js';
import { executeTask } from './task-executor.js';
import { parseAIResponse } from './ai-engine.js';
import { log } from './logger.js';

/**
 * @typedef {Object} AnalyzeOptions
 * @property {Object} ctx - DSH context
 * @property {Object} llm - LLM service
 * @property {Object} config - Configuration object
 * @property {Object} parentAgent - Parent agent (DSH session)
 * @property {string} reqPath - Full path to requirement directory
 * @property {string} requirementId - Requirement ID
 * @property {string} cwd - Working directory
 * @property {Object} [scopedSkills] - Optional scoped skills service
 */

/**
 * @typedef {Object} AnalyzeResult
 * @property {boolean} success - Whether analysis succeeded
 * @property {Object} [meta] - Validated meta data (on success)
 * @property {string} [error] - Error message (on failure)
 * @property {string} [elapsed] - Elapsed time in seconds
 */

/**
 * Analyze a single requirement document and generate .meta.json.
 * Reads documents, delegates to Subagent for analysis, validates and saves result.
 * @param {AnalyzeOptions} options - Analysis options
 * @returns {Promise<AnalyzeResult>} Analysis result
 */
export async function analyzeRequirement(options) {
  const { ctx, llm, config, parentAgent, reqPath, requirementId, cwd, scopedSkills, signal } = options;
  const startTime = Date.now();

  try {
    // 1. 读取文档
    const docsContent = await readRequirementDocs(reqPath);
    if (!docsContent) {
      return { success: false, error: '无支持的文档文件' };
    }

    // 2. 委托 Subagent 分析
    const variables = {
      requirementId,
      docsContent,
    };

    const result = await executeTask(ctx, llm, config, {
      promptKey: 'analyze',
      variables,
      parentAgent,
      cwd,
      scopedSkills,
      signal,
      description: `分析需求文档: ${requirementId}`,
    });

    if (result.isError) {
      throw new Error(result.diagnostic || '分析失败');
    }

    // 3. 解析和验证
    const parsed = parseAIResponse(result.output);
    const validated = validateMeta(parsed);

    // 4. 检查结果有效性
    if (!parsed || typeof parsed !== 'object' || (!parsed.summary && !parsed.features?.length && parsed.type === 'unknown')) {
      return { success: false, error: '分析结果无效：未能提取有效的需求信息' };
    }

    // 5. 写入 .meta.json（注意：writeMetaJson 需要文件路径）
    const metaFilePath = join(reqPath, '.meta.json');
    signal?.throwIfAborted();
    await writeMetaJson(metaFilePath, validated);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.analysis.info(`分析完成: ${requirementId} (${elapsed}s)`);

    return { success: true, meta: validated, elapsed };
  } catch (e) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.analysis.error(`分析失败: ${requirementId} - ${e.message}`);
    return { success: false, error: e.message, elapsed };
  }
}
