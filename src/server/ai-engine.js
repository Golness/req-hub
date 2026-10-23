/**
 * AI engine module.
 * Handles LLM invocation and response parsing.
 * @module ai-engine
 */

import { getPrompt, getPromptAsync } from './prompts.js';
import { log } from './logger.js';

/**
 * @typedef {Object} LLMPromptOptions
 * @property {string} [systemPrompt] - Custom system prompt (highest priority)
 * @property {string} [promptKey] - Prompt key for loading from config/skill
 * @property {string} [cwd] - Working directory for skill lookup
 * @property {Object} [scopedSkills] - Scoped skills service (priority over global)
 * @property {Function} [onStream] - Streaming callback function
 */

/**
 * Call LLM for inference.
 * Automatically selects provider and model from DSH configuration.
 * @param {Object} llm - LLM service instance
 * @param {string} prompt - User prompt text
 * @param {Object} config - Configuration object
 * @param {LLMPromptOptions} [options={}] - Prompt options
 * @returns {Promise<string>} LLM response text
 * @throws {Error} If no providers available or LLM call fails
 */
export async function callLLM(llm, prompt, config, options = {}) {
  const { systemPrompt: customSystemPrompt, promptKey, cwd, scopedSkills, onStream } = options;
  const aiConfig = config.ai || {};
  const temperature = aiConfig.temperature ?? 0.3;
  const maxTokens = aiConfig.maxTokens ?? 4000;

  // 记录调用开始（debug 级别）
  log.aiEngine.debug('LLM 调用开始', {
    promptLength: prompt?.length || 0,
    customSystemPrompt: !!customSystemPrompt,
    promptKey,
    cwd,
    temperature,
    maxTokens
  });

  // Get available providers from DSH global config
  let providers;
  try {
    providers = await llm.listProviders();
  } catch (e) {
    log.aiEngine.error(`获取 providers 失败: ${e.message}`);
    providers = [];
  }
  
  if (!Array.isArray(providers) || providers.length === 0) {
    log.aiEngine.error('没有可用的 LLM providers');
    throw new Error('No LLM providers available. Please configure an LLM provider in DSH settings.');
  }

  // Use the first available provider
  const firstProvider = providers[0];
  const providerId = firstProvider.id || firstProvider.name || firstProvider;
  const providerName = firstProvider.name || firstProvider.id || firstProvider;
  
  if (!providerId || typeof providerId !== 'string') {
    log.aiEngine.error(`无效的 provider: ${JSON.stringify(firstProvider)}`);
    throw new Error(`Invalid provider: ${JSON.stringify(firstProvider)}`);
  }
  
  // Get all available models
  let availableModels = [];
  try {
    const models = await llm.listModels(providerId);
    if (Array.isArray(models) && models.length > 0) {
      availableModels = models.map(m => m.id || m.name || m);
    } else {
      throw new Error(`No models available for provider ${providerId}`);
    }
  } catch (e) {
    log.aiEngine.warn(`无法获取模型列表: ${e.message}`);
  }

  // Use selectedModel from config directly, or fallback to first available model
  let model = aiConfig.selectedModel;
  
  if (!model) {
    // No model configured, use first available
    if (availableModels.length > 0) {
      model = availableModels[0];
      log.aiEngine.info(`未配置模型，使用: ${model}`);
    } else {
      const defaultModels = {
        'deepseek': 'deepseek-chat',
        'openai': 'gpt-4',
        'anthropic': 'claude-3-opus-20240229',
        'google': 'gemini-pro',
      };
      model = defaultModels[providerId] || 'default';
      log.aiEngine.warn(`无法获取模型列表，使用默认模型: ${model}`);
    }
  }

  log.aiEngine.info(`使用模型: ${providerName}/${model}`);

  // 获取 system prompt（优先级：customSystemPrompt > promptKey对应的skill/prompt > 默认）
  let systemPrompt;
  let promptTemplate = '';
  let skillUsed = null;
  
  if (customSystemPrompt) {
    // 1. 直接指定的 system prompt
    systemPrompt = customSystemPrompt;
  } else if (promptKey) {
    // 2. 通过 promptKey 获取（支持 skill 绑定）
    const promptResult = await getPromptAsync(config, promptKey, cwd, scopedSkills);
    systemPrompt = promptResult.systemPrompt;
    promptTemplate = promptResult.promptTemplate;
    skillUsed = promptResult.skillUsed;
    
    log.aiEngine.debug(`使用 promptKey: ${promptKey}`, {
      systemPromptLength: systemPrompt?.length || 0,
      promptTemplateLength: promptTemplate?.length || 0,
      skillUsed,
      hasScopedSkills: !!scopedSkills
    });
  } else {
    // 3. 默认 analyze prompt
    systemPrompt = getPrompt(config, 'analyze');
  }

  const userPrompt = prompt;

  // 记录详细入参（debug 级别）
  log.aiEngine.debug('LLM 请求详情', {
    provider: providerId,
    model,
    temperature,
    maxTokens,
    systemPromptLength: systemPrompt?.length || 0,
    userPromptLength: userPrompt?.length || 0,
    systemPromptPreview: systemPrompt?.substring(0, 200) + '...',
    userPromptPreview: userPrompt?.substring(0, 500) + (userPrompt?.length > 500 ? '...' : '')
  });

  // Create the content array explicitly
  const userContent = [];
  userContent.push({ type: 'text', text: userPrompt });

  // Define variables outside try block
  let content = '';
  let finishReason = null;
  const startTime = Date.now();

  try {
    const requestParams = {
      provider: providerId,
      model,
      system: systemPrompt,  // System prompt as separate parameter
      messages: [
        { 
          role: 'user', 
          content: userContent  // Send as array
        },
      ],
      temperature,
      maxTokens,
    };

    log.aiEngine.debug('LLM stream 请求参数', {
      provider: requestParams.provider,
      model: requestParams.model,
      temperature: requestParams.temperature,
      maxTokens: requestParams.maxTokens
    });

    const stream = llm.stream(requestParams);

    let chunkCount = 0;
    for await (const chunk of stream) {
      chunkCount++;
      if (chunk.type === 'text-delta' || chunk.type === 'delta') {
        const text = chunk.text || chunk.delta?.text || '';
        content += text;
        // Call onStream callback if provided (for ai-search progress display)
        if (onStream && chunkCount % 3 === 0) {
          onStream(content, chunkCount);
        }
      } else if (chunk.type === 'finish') {
        finishReason = chunk.reason;
      }
    }
    
    const elapsed = Date.now() - startTime;
    
    // 成功信息（info 级别）
    log.aiEngine.info(`LLM 调用完成: ${chunkCount} chunks, ${content.length} chars, ${elapsed}ms`);
    
    // 详细返回（debug 级别）
    log.aiEngine.debug('LLM 响应详情', {
      chunkCount,
      contentLength: content.length,
      elapsedMs: elapsed,
      finishReason: finishReason?.kind || 'normal',
      contentPreview: content?.substring(0, 500) + (content?.length > 500 ? '...' : '')
    });
    
  } catch (e) {
    const elapsed = Date.now() - startTime;
    // 失败信息（error 级别）
    log.aiEngine.error(`LLM 调用失败: ${e.message}`, {
      elapsedMs: elapsed,
      error: e.message,
      stack: e.stack
    });
    throw e;
  }

  // 5.13: max-tokens truncation warning
  if (finishReason?.kind === 'max-tokens') {
    log.aiEngine.warn('AI 输出被截断，建议增加 maxTokens 配置');
  }
  if (finishReason?.kind === 'error') {
    log.aiEngine.error(`LLM 返回错误: ${finishReason.failure?.message || 'unknown error'}`);
    throw new Error(`LLM error: ${finishReason.failure?.message || 'unknown error'}`);
  }

  return content;
}

/**
 * Parse AI response text as JSON.
 * Attempts multiple parsing strategies:
 * 1. Direct JSON.parse
 * 2. Extract from ```json code block
 * 3. Find any JSON object in text
 * @param {string} text - AI response text
 * @returns {Object|null} Parsed object or null if all strategies fail
 */
export function parseAIResponse(text) {
  // Level 1: direct parse
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Level 2: extract from ```json code block
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch { /* continue */ }
  }

  // Level 3: try to find any JSON object in the text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch { /* continue */ }
  }

  // Level 4: return defaults
  log.aiEngine.warn('AI 输出无法解析为 JSON，使用默认值');
  return null;
}
