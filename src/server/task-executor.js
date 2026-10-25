import { delegationContext, bindOwnedSession } from './delegation-context.js';
/**
 * Task executor module.
 * All LLM tasks are delegated to DSH Subagent for execution.
 *
 * Design principles:
 * 1. All LLM-requiring tasks go through subagent delegation
 * 2. Skills serve as instruction layer, Prompts as data layer
 * 3. Subagents automatically have full DSH tool capabilities
 * @module task-executor
 */

import { parseAIResponse } from './ai-engine.js';
import { getPromptAsync, buildFullPrompt, PROMPT_REGISTRY } from './prompts.js';
import { log } from './logger.js';
import { stat } from 'node:fs/promises';
import { estimateTextTokens, formatTokens, MAX_SYNC_INPUT_TOKENS, estimateSubagentInputTokens } from './token-utils.js';

/**
 * Sleep for a specified duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Task executor error codes.
 * Organized by category: preconditions, skill/prompt, provider, execution, resources.
 * @type {Object<string, string>}
 */
export const TaskExecutorErrorCode = {
  // 一、前置条件
  INVALID_CONTEXT: 'INVALID_CONTEXT',
  MISSING_PARENT_AGENT: 'MISSING_PARENT_AGENT',
  PARENT_AGENT_STOPPED: 'PARENT_AGENT_STOPPED',
  PARENT_AGENT_NOT_RUNNING: 'PARENT_AGENT_NOT_RUNNING',
  PARENT_AGENT_NO_SESSION: 'PARENT_AGENT_NO_SESSION',
  SUBAGENT_UNAVAILABLE: 'SUBAGENT_UNAVAILABLE',
  TASK_CANCELLED: 'TASK_CANCELLED',
  INVALID_PROMPT_KEY: 'INVALID_PROMPT_KEY',
  EMPTY_USER_PROMPT: 'EMPTY_USER_PROMPT',
  INVALID_CWD: 'INVALID_CWD',
  INVALID_AGENT_OPTIONS: 'INVALID_AGENT_OPTIONS',

  // 二、Skill/Prompt
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  SKILL_CONTENT_EMPTY: 'SKILL_CONTENT_EMPTY',
  SKILL_TOO_LARGE: 'SKILL_TOO_LARGE',
  TEMPLATE_VARIABLE_MISSING: 'TEMPLATE_VARIABLE_MISSING',
  TEMPLATE_RENDER_FAILED: 'TEMPLATE_RENDER_FAILED',

  // 三、Provider
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_CAPABILITY_MISSING: 'PROVIDER_CAPABILITY_MISSING',
  MAX_DEPTH_REACHED: 'MAX_DEPTH_REACHED',
  SUBAGENT_POOL_FULL: 'SUBAGENT_POOL_FULL',
  START_TIMEOUT: 'START_TIMEOUT',

  // 四、执行
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
  EXECUTION_STALE: 'EXECUTION_STALE',
  EXECUTION_INTERRUPTED: 'EXECUTION_INTERRUPTED',
  MAX_TOKENS_REACHED: 'MAX_TOKENS_REACHED',
  REFUSAL: 'REFUSAL',

  // 五、资源
  DISPOSE_FAILED: 'DISPOSE_FAILED',
};

/**
 * Task executor configuration constants.
 * @type {Object}
 * @property {string} defaultProvider - Default subagent provider
 * @property {Object} defaultAgentOptions - Default agent options
 * @property {number} defaultTimeout - Default timeout in ms (20 min)
 * @property {number} minTimeout - Minimum timeout in ms (30s)
 * @property {number} maxTimeout - Maximum timeout in ms (20 min)
 * @property {number} maxSkillTokens - Max skill content tokens (≈100k chars)
 * @property {number} maxPromptTokens - Max prompt tokens (≈200k chars)
 * @property {Object} liveness - Liveness detection config
 */
export const TaskExecutorConfig = {
  // 默认 provider
  defaultProvider: 'spawn',
  // 默认 agent options
  defaultAgentOptions: {
    provider: undefined,  // 继承父 agent
    model: undefined,     // 继承父 agent
    maxTokens: 8000,
  },
  // 默认超时（毫秒）
  defaultTimeout: 1200000, // 20 分钟
  // 最小超时
  minTimeout: 30000,
  // 最大超时
  maxTimeout: 1200000, // 20 分钟
  // Skill 最大 token 数
  maxSkillTokens: 25000, // 约 100k 字符
  // Prompt 最大 token 数
  maxPromptTokens: 50000, // 约 200k 字符
  // Liveness 检测配置
  liveness: {
    enabled: true,
    pollIntervalMs: 15000,
    stalenessThresholdMs: 60000,
    warnAfterStaleCount: 2,
    interruptAfterStaleCount: 4,
    autoInterrupt: true,
    gracePeriodMs: 30000,
  },
};

/**
 * Task executor error class.
 * Extends Error with code and optional details for structured error handling.
 */
export class TaskExecutorError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Error code from TaskExecutorErrorCode
   * @param {Object|null} [details=null] - Additional error details
   */
  constructor(message, code, details = null) {
    super(message);
    this.name = 'TaskExecutorError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Task execution result.
 * Contains output, metadata, and status information.
 */
export class TaskResult {
  /**
   * @param {Object} options - Result options
   * @param {boolean} [options.success=true] - Whether task succeeded
   * @param {string} [options.output=''] - Task output text
   * @param {Object|null} [options.structured=null] - Structured output data
   * @param {Array} [options.deliverables=[]] - List of deliverable files
   * @param {string|null} [options.sessionId=null] - Subagent session ID
   * @param {string} [options.stopReason='completed'] - Stop reason
   * @param {string|null} [options.diagnostic=null] - Diagnostic info
   * @param {string|null} [options.skillUsed=null] - Skill name used
   * @param {number} [options.elapsed=0] - Elapsed time in ms
   * @param {string|null} [options.errorCode=null] - Error code if failed
   * @param {Array} [options.warnings=[]] - Warnings generated during execution
   */
  constructor(options) {
    this.success = options.success ?? true;
    this.output = options.output || '';
    this.structured = options.structured || null;
    this.deliverables = options.deliverables || [];
    this.sessionId = options.sessionId || null;
    this.stopReason = options.stopReason || 'completed';
    this.diagnostic = options.diagnostic || null;
    this.skillUsed = options.skillUsed || null;
    this.elapsed = options.elapsed || 0;
    this.errorCode = options.errorCode || null;
    this.warnings = options.warnings || [];
  }

  /**
   * Whether the task resulted in an error.
   * @type {boolean}
   */
  get isError() {
    return !this.success || this.stopReason !== 'completed';
  }

  /**
   * Get simple string representation of output.
   * @returns {string} Output text
   */
  toSimpleString() {
    return this.output;
  }

  /**
   * Get user-friendly error message.
   * @returns {string} Human-readable message
   */
  getUserMessage() {
    if (!this.isError) {
      return '任务执行成功';
    }

    switch (this.stopReason) {
      case 'aborted':
        return '任务被中断';
      case 'max-tokens':
        return '输出达到长度限制，请尝试增加 maxTokens 配置';
      case 'refusal':
        return '模型拒绝执行此任务，请检查任务描述是否合规';
      case 'error':
        return this.diagnostic || '执行过程中发生错误';
      default:
        return this.diagnostic || '任务执行失败';
    }
  }
}

/**
 * @typedef {Object} TaskExecutorOptions
 * @property {Object} ctx - DSH Context (includes subagents service)
 * @property {Object} llm - LLM service (for provider info, not called directly)
 * @property {Object} config - Plugin configuration
 * @property {Object} parentAgent - Parent agent for subagent delegation (required)
 * @property {string} cwd - Working directory
 * @property {AbortSignal} [signal] - Cancellation signal
 * @property {Object} [callbacks] - Progress/error callbacks
 */

/**
 * Task executor class.
 * Manages the full lifecycle of LLM task execution via DSH subagents.
 */
export class TaskExecutor {
  /**
   * Create a new TaskExecutor instance.
   * @param {TaskExecutorOptions} options - Executor options
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.llm = options.llm;
    this.config = options.config || {};
    this.parentAgent = options.parentAgent;
    this.cwd = options.cwd;
    this.signal = options.signal || new AbortController().signal;
    this.scopedSkills = options.scopedSkills;
    this.callbacks = options.callbacks || {};
    this.warnings = [];
  }

  /**
   * Add a warning to the executor's warning list.
   * @param {string} code - Warning code
   * @param {string} message - Warning message
   * @returns {void}
   */
  addWarning(code, message) {
    this.warnings.push({ code, message, timestamp: Date.now() });
    log.taskExecutor.warn(message, { code });
  }

  /**
   * Execute a task via Subagent delegation.
   * @param {Object} options - Execution options
   * @param {string} options.promptKey - Prompt registry key
   * @param {Object} [options.variables={}] - Template variables
   * @param {string} [options.description] - Human-readable task description
   * @param {Object} [options.agentOptions] - Subagent options override
   * @param {number} [options.timeout] - Timeout in ms
   * @returns {Promise<TaskResult>} Task execution result
   */
  async execute(options) {
    const { promptKey, variables = {}, description, agentOptions, timeout } = options;
    const startTime = Date.now();
    this.warnings = [];

    // 回调：任务开始
    this.callbacks.onStart?.({
      promptKey,
      description: description || promptKey,
      timestamp: Date.now()
    });

    // ====== 一、前置条件验证 ======
    const validationErrors = await this.validatePreconditions(options);
    if (validationErrors.length > 0) {
      const firstError = validationErrors[0];
      const result = new TaskResult({
        success: false,
        stopReason: 'error',
        diagnostic: firstError.message,
        errorCode: firstError.code,
        elapsed: Date.now() - startTime,
        warnings: this.warnings,
      });

      this.callbacks.onError?.({ error: firstError, result });
      return result;
    }

    log.taskExecutor.info(`任务执行`, {
      promptKey,
      description: description || promptKey,
      hasParentAgent: !!this.parentAgent,
      timeout: timeout || TaskExecutorConfig.defaultTimeout,
    });

    return this.executeViaSubagent(options, startTime);
  }

  /**
   * Phase 1: Validate all preconditions.
   * Checks context, agent, parameters, and configuration.
   * @param {Object} options - Execution options
   * @returns {Promise<Array<{code: string, message: string}>>} Array of validation errors
   */
  async validatePreconditions(options) {
    const errors = [];

    // 1.1 Context 验证
    if (!this.ctx) {
      errors.push({
        code: TaskExecutorErrorCode.INVALID_CONTEXT,
        message: 'Context 不可用，无法委托任务',
      });
      return errors;
    }

    if (!this.ctx.subagents) {
      errors.push({
        code: TaskExecutorErrorCode.SUBAGENT_UNAVAILABLE,
        message: 'Subagent 服务不可用',
      });
      return errors;
    }

    // ctx.skills 不可用时记录警告
    if (!this.ctx.skills) {
      this.addWarning('SKILLS_UNAVAILABLE', 'Skills 服务不可用，Skill 绑定将被忽略');
    }

    // 1.2 Agent 验证
    if (!this.parentAgent) {
      errors.push({
        code: TaskExecutorErrorCode.MISSING_PARENT_AGENT,
        message: '缺少父 Agent，无法委托任务',
      });
      return errors;
    }

    // 检查 Agent 状态
    const status = this.parentAgent.status;
    if (status === 'stopped') {
      errors.push({
        code: TaskExecutorErrorCode.PARENT_AGENT_STOPPED,
        message: `父 Agent 已停止，当前状态: ${status}`,
        details: { status },
      });
      return errors;
    }

    // 注意：idle 状态也是可以执行任务的，只有 stopped 才是真正的错误
    // 因为父 agent 可能处于 idle 状态等待新的任务

    // 检查 Agent 是否有 session
    if (!this.parentAgent.session) {
      errors.push({
        code: TaskExecutorErrorCode.PARENT_AGENT_NO_SESSION,
        message: '父 Agent 没有 session',
      });
      return errors;
    }

    // 1.3 参数验证
    // promptKey 验证
    if (options.promptKey && !PROMPT_REGISTRY[options.promptKey]) {
      // promptKey 不在注册表中，但允许自定义 promptKey
      this.addWarning('UNKNOWN_PROMPT_KEY', `promptKey "${options.promptKey}" 不在预设列表中`);
    }

    // 1.4 必需变量验证
    const variableErrors = this.validateRequiredVariables(options.promptKey, options.variables || {});
    if (variableErrors.length > 0) {
      // 必需变量缺失是错误，不是警告
      for (const err of variableErrors) {
        errors.push(err);
      }
      return errors;
    }

    // Signal 取消检查
    if (this.signal?.aborted) {
      errors.push({
        code: TaskExecutorErrorCode.TASK_CANCELLED,
        message: '任务已被取消',
      });
      return errors;
    }

    // cwd 验证
    if (this.cwd) {
      try {
        await stat(this.cwd);
      } catch (e) {
        errors.push({
          code: TaskExecutorErrorCode.INVALID_CWD,
          message: `工作目录不存在: ${this.cwd}`,
          details: { cwd: this.cwd, error: e.message },
        });
        return errors;
      }
    }

    // 1.4 配置验证
    const delegationConfig = this.config?.ai?.delegation;
    if (!delegationConfig) {
      this.addWarning('NO_DELEGATION_CONFIG', '未配置 delegation，使用默认值');
    }

    // agentOptions 验证
    if (options.agentOptions) {
      const { provider, model, maxTokens } = options.agentOptions;
      if (maxTokens !== undefined && (typeof maxTokens !== 'number' || maxTokens <= 0)) {
        errors.push({
          code: TaskExecutorErrorCode.INVALID_AGENT_OPTIONS,
          message: 'agentOptions.maxTokens 必须是正数',
          details: { maxTokens },
        });
      }
    }

    return errors;
  }

  /**
   * Phase 2: Load Skill/Prompt content.
   * @param {Object} options - Load options
   * @returns {Promise<{fullPrompt: string, skillUsed: string|null, skillContent: string|null, promptTemplate: string|null}>}
   */
  async loadPrompt(options) {
    const { promptKey, variables = {} } = options;
    const result = {
      fullPrompt: '',
      skillUsed: null,
      skillContent: null,
      promptTemplate: null,
    };

    // 加载 Skill + Prompt 组合
    try {
      this.callbacks.onProgress?.({ stage: 'skill_loading', promptKey });

      const promptResult = await getPromptAsync(this.config, promptKey, this.cwd, this.scopedSkills);
      const { systemPrompt, promptTemplate, skillUsed } = promptResult;

      result.skillUsed = skillUsed;
      result.skillContent = systemPrompt;
      result.promptTemplate = promptTemplate;

      log.taskExecutor.debug(`加载 prompt`, {
        promptKey,
        hasTemplate: !!promptTemplate,
        templateLength: promptTemplate?.length || 0,
        variablesCount: Object.keys(variables).length,
      });

      // Skill 验证
      if (skillUsed && systemPrompt) {
        // Skill 内容为空
        if (systemPrompt.trim().length === 0) {
          this.addWarning('SKILL_CONTENT_EMPTY', `Skill "${skillUsed}" 内容为空`);
          result.skillContent = null;
          result.skillUsed = null;
        }
        // Skill 内容过大
        else if (estimateTextTokens(systemPrompt) > TaskExecutorConfig.maxSkillTokens) {
          this.addWarning('SKILL_TOO_LARGE', `Skill "${skillUsed}" 内容过大 (约 ${formatTokens(estimateTextTokens(systemPrompt))} tokens)，可能影响性能`);
        }
      }

      this.callbacks.onProgress?.({
        stage: 'skill_loaded',
        skillUsed,
        hasSkill: !!skillUsed,
      });

    } catch (e) {
      // Skill 加载失败
      this.addWarning('SKILL_LOAD_FAILED', `Skill 加载失败: ${e.message}`);
      log.taskExecutor.warn(`Skill/Prompt 加载失败: ${e.message}`);
    }

    // 构建完整 prompt
    let fullPrompt = '';

    if (result.promptTemplate) {
      try {
        // 检查模板变量
        const variableErrors = this.validateTemplateVariables(result.promptTemplate, variables);
        if (variableErrors.length > 0) {
          this.addWarning('TEMPLATE_VARIABLE_MISSING', `模板变量缺失: ${variableErrors.join(', ')}`);
          log.taskExecutor.warn(`模板变量缺失: ${variableErrors.join(', ')}`);
        }

        fullPrompt = buildFullPrompt({
          systemPrompt: PROMPT_REGISTRY[promptKey]?.contractVersion === 2 ? '' : result.skillContent || '',
          promptTemplate: result.promptTemplate,
          variables
        });

        log.taskExecutor.debug(`构建 prompt 完成`, {
          promptKey,
          fullPromptLength: fullPrompt.length,
          fullPromptTokens: estimateTextTokens(fullPrompt),
        });
      } catch (e) {
        this.addWarning('TEMPLATE_RENDER_FAILED', `模板渲染失败: ${e.message}`);
        log.taskExecutor.error(`模板渲染失败: ${e.message}`);
      }
    } else {
      // 没有模板，这是错误
      const errorMsg = `promptKey "${promptKey}" 没有对应的模板`;
      this.addWarning('NO_TEMPLATE', errorMsg);
      log.taskExecutor.error(errorMsg);
    }

    // 如果有 Skill，嵌入到 prompt 中
    if (result.skillContent) {
      fullPrompt = this.buildSubagentPrompt(fullPrompt, {
        skillContent: result.skillContent,
        skillName: result.skillUsed,
      });
    }

    // 检查 prompt 是否为空
    if (!fullPrompt || fullPrompt.trim().length === 0) {
      log.taskExecutor.error(`构建的 prompt 为空`, { promptKey, variables });
    }

    // 检查 prompt token 数
    if (estimateTextTokens(fullPrompt) > TaskExecutorConfig.maxPromptTokens) {
      this.addWarning('PROMPT_TOO_LARGE', `Prompt 过长 (约 ${formatTokens(estimateTextTokens(fullPrompt))} tokens)`);
    }

    result.fullPrompt = fullPrompt;
    return result;
  }

  /**
   * Validate template variables.
   * Checks that all variables used in template are provided.
   * @param {string} template - Prompt template with {variable} placeholders
   * @param {Object} variables - Variable values
   * @returns {string[]} Array of missing variable names
   */
  validateTemplateVariables(template, variables) {
    const missing = [];
    const variablePattern = /\{(\w+)\}/g;
    let match;

    while ((match = variablePattern.exec(template)) !== null) {
      const varName = match[1];
      if (!(varName in variables)) {
        missing.push(varName);
      }
    }

    return missing;
  }

  /**
   * Validate required variables per PROMPT_REGISTRY definition.
   * @param {string} promptKey - Prompt registry key
   * @param {Object} variables - Provided variables
   * @returns {Array<{code: string, message: string}>} Array of validation errors
   */
  validateRequiredVariables(promptKey, variables) {
    const errors = [];
    const promptMeta = PROMPT_REGISTRY[promptKey];

    if (!promptMeta || !promptMeta.variables) {
      return errors;
    }

    // 检查必需变量
    for (const varDef of promptMeta.variables) {
      if (varDef.required) {
        if (!(varDef.name in variables) || variables[varDef.name] === undefined || variables[varDef.name] === '') {
          errors.push({
            code: 'MISSING_REQUIRED_VARIABLE',
            message: `缺少必需变量: ${varDef.name} (${varDef.description})`,
            details: { variable: varDef.name, description: varDef.description },
          });
        }
      }
    }

    return errors;
  }

  /**
   * Phase 3: Start subagent.
   * @param {Object} options - Start options
   * @param {Object} promptData - Loaded prompt data
   * @returns {Promise<{run: Object, provider: string}>} Started run and provider info
   * @throws {TaskExecutorError} If provider not found or start fails
   */
  async startSubagent(options, promptData) {
    const { promptKey, description, agentOptions, timeout } = options;
    const { fullPrompt, skillUsed } = promptData;
    const inputLimit = options.maxInputTokens ?? (options.promptKey?.startsWith('phased-') ? MAX_SYNC_INPUT_TOKENS : null);
    if (inputLimit && estimateSubagentInputTokens(fullPrompt) >= inputLimit) {
      throw new TaskExecutorError(`同步输入超过预算（须小于 ${inputLimit} tokens），请减少固定 prompt 或拆分输入`, 'PROMPT_TOO_LARGE');
    }

    // 获取 provider
    const provider = this.config?.ai?.delegation?.provider || TaskExecutorConfig.defaultProvider;

    // 检查 provider 可用性
    const providerInstance = this.ctx.subagents.getProvider(provider);
    if (!providerInstance) {
      const availableProviders = this.ctx.subagents.list() || [];
      throw new TaskExecutorError(
        `Subagent provider "${provider}" 未注册，可用: ${availableProviders.join(', ') || '(无)'}`,
        TaskExecutorErrorCode.PROVIDER_NOT_FOUND,
        { availableProviders }
      );
    }

    // 3.1 Provider 能力检查
    const capabilities = providerInstance.capabilities || {};

    if (agentOptions && !capabilities.agentOptions) {
      throw new TaskExecutorError(
        `Provider "${provider}" 不支持 agentOptions`,
        TaskExecutorErrorCode.PROVIDER_CAPABILITY_MISSING,
        { capability: 'agentOptions', available: Object.keys(capabilities) }
      );
    }

    if (options.outputSchema && !capabilities.outputSchema) {
      this.addWarning('OUTPUT_SCHEMA_UNSUPPORTED', `Provider "${provider}" 不支持 outputSchema，将被忽略`);
    }

    if (options.toolFilter && !capabilities.toolFilter) {
      throw new TaskExecutorError(`Provider ${provider} 不支持工具隔离`, 'CAPABILITY_UNSUPPORTED');
    }

    // 3.2 检查深度限制
    const maxDepth = this.config?.ai?.delegation?.maxDepth;
    if (maxDepth !== undefined && maxDepth <= 0) {
      throw new TaskExecutorError(
        '已达到最大委托深度',
        TaskExecutorErrorCode.MAX_DEPTH_REACHED,
        { maxDepth }
      );
    }

    // 回调：Subagent 启动中
    this.callbacks.onProgress?.({
      stage: 'subagent_starting',
      provider,
    });

    log.taskExecutor.info(`启动 Subagent`, {
      provider,
      description: description || promptKey,
      skillUsed,
      promptLength: fullPrompt.length,
    });

    // 合并 agent options，过滤掉 undefined 值（避免覆盖父 agent 的 provider/model）
    const mergedAgentOptions = Object.fromEntries(
      Object.entries({
        ...TaskExecutorConfig.defaultAgentOptions,
        ...this.config?.ai?.delegation?.agentOptions,
        ...agentOptions,
      }).filter(([_, v]) => v !== undefined)
    );

    // 启动 subagent
    const startController = new AbortController();
    const startSignal = startController ? AbortSignal.any([startController.signal, this.signal].filter(Boolean)) : this.signal;
    startSignal?.throwIfAborted();
    if (options.runtime) options.runtime.parentSessionId = this.parentAgent.session.id;
    const startPromise = Promise.resolve(delegationContext.run(options.runtime, () => this.ctx.subagents.start(provider, {
      label: description || promptKey,
      prompt: [{ type: 'text', text: fullPrompt }],
      parent: this.parentAgent,
      signal: startSignal,
      ...(options.toolFilter ? { toolFilter: options.toolFilter } : {}),
      ...Object.values(mergedAgentOptions).some(v => v !== undefined) ? { agentOptions: mergedAgentOptions } : {},
    }))).then(async run => {
      if (options.runtime && !options.runtime.closed && !startSignal.aborted) {
        try { bindOwnedSession(options.runtime, run.id); }
        catch (error) { await run.dispose(); throw error; }
      }
      // A child may settle while an awaited progress callback persists its ID.
      if (options.syncV2) void run.result.catch(() => {});
      return run;
    });

    // 设置启动超时
    //  修复 Issue #3: 添加定时器清理，避免 unhandled promise rejection
    const startTimeoutMs = 30000; // 30 秒启动超时
    let startTimeoutId;
    const startTimeoutPromise = new Promise((_, reject) => {
      startTimeoutId = setTimeout(() => reject(new TaskExecutorError(
        `Subagent 启动超时 (${startTimeoutMs}ms)`,
        TaskExecutorErrorCode.START_TIMEOUT
      )), startTimeoutMs);
    });

    try {
      const run = await Promise.race([startPromise, startTimeoutPromise]);
      startSignal.throwIfAborted();
      if (options.runtime?.closed) throw new Error('DELEGATION_RUNTIME_CLOSED');
      return { run, provider, startController };
    } catch (e) {
      if (startController) {
        startController.abort(e);
        // DSH start() owns setup until it settles; reclaim even a handle published
        // after the caller's timeout, before releasing the sync reservation.
        try { const lateRun = await startPromise; await lateRun?.dispose(); } catch { /* start failed before publication */ }
      }
      if (e.code === TaskExecutorErrorCode.START_TIMEOUT) {
        throw e;
      }
      // 检查是否是池满错误
      if (e.message?.includes('pool') || e.message?.includes('maxActiveSubagents')) {
        throw new TaskExecutorError(
          'Subagent 池已满，无法创建新的子代理',
          TaskExecutorErrorCode.SUBAGENT_POOL_FULL,
          { originalError: e.message }
        );
      }
      throw e;
    } finally {
      //  修复 Issue #3: 清理定时器
      clearTimeout(startTimeoutId);
    }
  }

  /**
   * Phase 4: Execute subagent and wait for result.
   * Includes timeout and liveness monitoring.
   * @param {Object} run - Subagent run instance
   * @param {Object} options - Execution options
   * @returns {Promise<{result: Object, sessionId: string}>} Execution result
   */
  async executeSubagent(run, options) {
    const { timeout } = options;
    const sessionId = run.id;

    // 回调：Subagent 执行中
    await this.callbacks.onProgress?.({
      stage: 'executing',
      sessionId,
    });

    log.taskExecutor.debug(`Subagent 已启动`, { sessionId });

    // 设置执行超时
    const timeoutMs = Math.min(
      Math.max(timeout || TaskExecutorConfig.defaultTimeout, TaskExecutorConfig.minTimeout),
      TaskExecutorConfig.maxTimeout
    );

    //  修复 Issue #3: 添加定时器清理，避免 unhandled promise rejection
    // 如果 run.result 先完成，setTimeout 仍然在后台运行
    // 当超时触发时，reject() 被调用但没有 Promise 在等待它
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new TaskExecutorError(
        `执行超时 (${timeoutMs}ms)`,
        TaskExecutorErrorCode.EXECUTION_TIMEOUT
      )), timeoutMs);
    });

    // Liveness 检测
    const livenessConfig = options.liveness
      ?? this.config?.ai?.delegation?.liveness
      ?? TaskExecutorConfig.liveness;

    let livenessMonitor = null;
    let livenessReject = null;
    const livenessPromise = livenessConfig?.enabled
      ? new Promise((_, reject) => { livenessReject = reject; })
      : new Promise(() => {});

    if (livenessConfig?.enabled) {
      livenessMonitor = await this.monitorLiveness(sessionId, livenessConfig, Date.now());

      // 轮询 monitor 的 staleError，一旦设置就 reject
      (async () => {
        while (livenessMonitor && !livenessMonitor.staleError) {
          await sleep(1000);
        }
        if (livenessMonitor?.staleError && livenessReject) {
          livenessReject(livenessMonitor.staleError);
        }
      })();
    }

    try {
      // 等待结果（超时 + 无响应检测）
      const result = await Promise.race([
        run.result,
        timeoutPromise,
        livenessPromise,
      ]);

      // 记录原始结果 - 使用 info 级别确保能看到
      log.taskExecutor.info(`Subagent 原始结果`, {
        stopReason: result.stopReason,
        hasOutput: !!result.output,
        outputType: result.output ? (Array.isArray(result.output) ? 'array' : typeof result.output) : 'null',
        outputLength: result.output ? (Array.isArray(result.output) ? result.output.length : result.output.length) : 0,
        hasDiagnostic: !!result.diagnostic,
        diagnostic: result.diagnostic ? result.diagnostic.substring(0, 500) : null,
        hasError: !!result.error,
        errorMessage: result.error?.message,
      });

      return { result, sessionId };
    } finally {
      //  修复 Issue #3: 清理定时器，避免 unhandled promise rejection
      clearTimeout(timeoutId);
      if (livenessMonitor) {
        livenessMonitor.stop();
        livenessMonitor = null;
      }
    }
  }

  /**
   * Monitor subagent liveness via event polling.
   * Detects stalled subagents and optionally interrupts them.
   * @param {string} sessionId - Subagent session ID
   * @param {Object} config - Liveness configuration
   * @param {number} startTime - Task start timestamp
   * @returns {Promise<{stop: Function, staleError: Error|null}>} Monitor controller
   */
  async monitorLiveness(sessionId, config, startTime) {
    const {
      pollIntervalMs = 15000,
      warnAfterStaleCount = 2,
      interruptAfterStaleCount = 4,
      autoInterrupt = true,
      gracePeriodMs = 30000,
    } = config;

    let staleCount = 0;
    let lastActivityTime = startTime;
    let lastActivityDesc = '启动中';
    let warned = false;
    let stopped = false;
    let staleError = null;

    const controller = {
      stop: () => { stopped = true; },
      get staleError() { return staleError; },
      get lastActivityTime() { return lastActivityTime; },
      get lastActivityDesc() { return lastActivityDesc; },
    };

    // 判断一个事件是否代表"活跃"
    const isActiveEvent = (event) => {
      const type = event.type || '';
      // turn 生命周期：start 表示开始工作，end 表示结束
      // 只要有 turn/start 且没有对应的 turn/end，说明正在工作中
      if (type === 'turn/start' || type === 'turn/end') return true;
      // 消息事件：用户输入或助手回复都算活跃
      if (type === 'user/message' || type === 'assistant/message') return true;
      // 工具调用：说明 subagent 正在执行操作
      if (type.startsWith('tool_') || type.includes('tool')) return true;
      // 交付物：说明有产出
      if (type.includes('deliverable')) return true;
      return false;
    };

    // 从事件生成人类可读的活动描述
    const describeEvent = (event) => {
      const type = event.type || '';
      if (type === 'turn/start') return 'AI 思考中';
      if (type === 'turn/end') return '轮次完成';
      if (type === 'user/message') return '收到用户输入';
      if (type === 'assistant/message') return 'AI 回复中';
      if (type.includes('tool')) return '调用工具中';
      if (type.includes('deliverable')) return '生成交付物';
      return type;
    };

    // 后台轮询循环
    (async () => {
      // 等待 grace period
      await sleep(gracePeriodMs);

      while (!stopped) {
        await sleep(pollIntervalMs);
        if (stopped) break;

        try {
          if (!this.ctx?.sessionQuery) {
            log.taskExecutor.debug('sessionQuery 不可用，跳过活跃度检测');
            continue;
          }

          const observation = await this.ctx.sessionQuery.observeSession(sessionId);
          if (!observation?.events || observation.events.length === 0) {
            continue;
          }

          const events = observation.events;

          // 检查是否有未完成的 turn（turn/start 没有对应的 turn/end）
          let hasActiveTurn = false;
          let latestActiveEvent = null;
          let latestActiveTime = 0;

          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (!isActiveEvent(e)) continue;

            if (e.type === 'turn/start') {
              // 检查后面是否有 turn/end
              let hasEnd = false;
              for (let j = i + 1; j < events.length; j++) {
                if (events[j].type === 'turn/end') { hasEnd = true; break; }
              }
              if (!hasEnd) {
                hasActiveTurn = true;
                const t = e.time ? new Date(e.time).getTime() : 0;
                if (t > latestActiveTime) {
                  latestActiveTime = t;
                  latestActiveEvent = e;
                }
              }
            } else if (e.type !== 'turn/end') {
              const t = e.time ? new Date(e.time).getTime() : 0;
              if (t > latestActiveTime) {
                latestActiveTime = t;
                latestActiveEvent = e;
              }
            }
          }

          // 有未完成的 turn → 一定活跃，不算 stale
          if (hasActiveTurn) {
            lastActivityTime = latestActiveTime || Date.now();
            lastActivityDesc = latestActiveEvent ? describeEvent(latestActiveEvent) : 'AI 工作中';
            staleCount = 0;

            this.callbacks.onProgress?.({
              stage: 'liveness_active',
              sessionId,
              lastActivity: new Date(lastActivityTime).toISOString(),
              lastActivityDesc,
            });
            continue;
          }

          // 没有活跃 turn，检查最新活跃事件的时间
          if (latestActiveTime > lastActivityTime) {
            lastActivityTime = latestActiveTime;
            lastActivityDesc = latestActiveEvent ? describeEvent(latestActiveEvent) : '活跃';
            staleCount = 0;

            this.callbacks.onProgress?.({
              stage: 'liveness_active',
              sessionId,
              lastActivity: new Date(lastActivityTime).toISOString(),
              lastActivityDesc,
            });
            continue;
          }

          // 无新活动
          staleCount++;
          const stalenessDuration = Date.now() - lastActivityTime;

          log.taskExecutor.debug('Subagent 无新活动', {
            sessionId,
            staleCount,
            stalenessDuration: `${Math.round(stalenessDuration / 1000)}s`,
            lastActivityDesc,
          });

          this.callbacks.onProgress?.({
            stage: 'liveness_stale',
            sessionId,
            staleCount,
            stalenessDuration,
            lastActivity: new Date(lastActivityTime).toISOString(),
            lastActivityDesc,
          });

          // 达到警告阈值
          if (staleCount >= warnAfterStaleCount && !warned) {
            warned = true;
            const msg = `Subagent 可能已卡住: ${Math.round(stalenessDuration / 1000)}s 无活动（最后活动: ${lastActivityDesc}）`;
            this.addWarning('SUBAGENT_STALE', msg);
            log.taskExecutor.warn(msg, { sessionId, staleCount });
          }

          // 达到中断阈值
          if (staleCount >= interruptAfterStaleCount && autoInterrupt) {
            const msg = `Subagent 检测到无响应: ${Math.round(stalenessDuration / 1000)}s 无活动，自动中断`;
            log.taskExecutor.error(msg, { sessionId, staleCount });

            //  注意：ctx.subagents.interrupt() 对 one-shot subagent 是静默空操作
            // 因为 interrupt() 只作用于 continuable 类型的 subagent（ContinuableActivationRegistry.resident）
            // One-shot subagent 通过 SpawnInProcessProvider.start() 直接启动，不注册到 resident Map
            // 因此取消 one-shot subagent 的唯一有效机制是 AbortSignal
            // 这里不调用 interrupt()，而是依赖 signal.abort() 传播取消
            // 如果未来切换到 continuable subagent，可以恢复 interrupt() 调用

            staleError = new TaskExecutorError(
              msg,
              TaskExecutorErrorCode.EXECUTION_STALE,
              { sessionId, staleCount, stalenessDuration }
            );
            break;
          }
        } catch (e) {
          if (e.code === TaskExecutorErrorCode.EXECUTION_STALE) throw e;
          log.taskExecutor.warn(`活跃度检测失败: ${e.message}`);
        }
      }
    })();

    return controller;
  }

  /**
   * Execute task via subagent (full pipeline: load prompt → start → execute → collect).
   * @param {Object} options - Execution options
   * @param {number} startTime - Task start timestamp
   * @returns {Promise<TaskResult>} Task result
   */
  async executeViaSubagent(options, startTime) {
    const { promptKey, description } = options;
    let run = null;
    let runController;

    try {
      // ====== 二、Skill/Prompt 加载 ======
      const promptData = options.preparedPromptData || await this.loadPrompt(options);

      // ====== 三、Subagent 启动 ======
      const startResult = await this.startSubagent(options, promptData);
      run = startResult.run;
      runController = startResult.startController;
      const { provider } = startResult;

      // ====== 四、Subagent 执行 ======
      const execResult = await this.executeSubagent(run, options);
      const { result, sessionId } = execResult;
      this.signal?.throwIfAborted();

      // 提取输出
      const output = this.extractOutput(result.output);

      // 记录详细结果
      log.taskExecutor.debug(`Subagent 执行结果`, {
        stopReason: result.stopReason,
        outputLength: output.length,
        hasDiagnostic: !!result.diagnostic,
        diagnostic: result.diagnostic,
        structured: result.structured ? Object.keys(result.structured) : null,
        rawOutputType: result.output ? (Array.isArray(result.output) ? 'array' : typeof result.output) : 'null',
        rawOutputLength: result.output ? result.output.length : 0,
      });

      // 回调：交付物收集中
      this.callbacks.onProgress?.({
        stage: 'collecting_deliverables',
      });

      // ====== 六、交付物收集 ======
      const deliverables = await this.collectDeliverables(sessionId);

      const elapsed = Date.now() - startTime;

      log.taskExecutor.info(`Subagent 完成`, {
        sessionId,
        stopReason: result.stopReason,
        elapsed,
        outputLength: output.length,
        deliverablesCount: deliverables.length,
        diagnostic: result.diagnostic,
        structured: result.structured ? Object.keys(result.structured) : null,
      });

      const taskResult = new TaskResult({
        success: result.stopReason === 'completed',
        output,
        structured: result.structured,
        deliverables,
        sessionId,
        stopReason: result.stopReason,
        diagnostic: result.diagnostic,
        skillUsed: promptData.skillUsed,
        elapsed,
        errorCode: this.getErrorCodeFromStopReason(result.stopReason),
        warnings: this.warnings,
      });

      // ====== 九、监控诊断 ======
      this.recordMetrics(taskResult, provider, promptKey);

      // 回调：任务完成
      this.callbacks.onComplete?.({ result: taskResult });

      return taskResult;
    } catch (e) {
      const elapsed = Date.now() - startTime;

      const errorCode = e instanceof TaskExecutorError
        ? e.code
        : TaskExecutorErrorCode.EXECUTION_ERROR;

      log.taskExecutor.error(`Subagent 执行失败: ${e.message}`, {
        code: errorCode,
        stack: e.stack,
        elapsed,
      });

      const result = new TaskResult({
        success: false,
        output: '',
        diagnostic: e.message,
        stopReason: 'error',
        elapsed,
        errorCode,
        warnings: this.warnings,
      });

      // ====== 九、监控诊断 ======
      this.recordMetrics(result, null, promptKey);

      // 回调：错误
      this.callbacks.onError?.({ error: e, result });

      return result;
    } finally {
      // ====== 五、资源释放 ======
      runController?.abort();
      await this.disposeRun(run, { strict: !!options.syncV2 });
    }
  }

  /**
   * Phase 5: Dispose subagent resources.
   * @param {Object|null} run - Subagent run instance
   * @returns {Promise<void>}
   */
  async disposeRun(run, { strict = false } = {}) {
    if (!run) return;

    try {
      await run.dispose();
      log.taskExecutor.debug(`Subagent 资源已释放`);
    } catch (disposeError) {
      log.taskExecutor.warn(`资源释放失败: ${disposeError.message}`);
      if (strict) throw disposeError;
      // 不抛出错误，只记录警告
    }
  }

  /**
   * Map stopReason to error code.
   * @param {string} stopReason - Subagent stop reason
   * @returns {string|null} Error code or null for success
   */
  getErrorCodeFromStopReason(stopReason) {
    switch (stopReason) {
      case 'completed':
        return null;
      case 'aborted':
        return TaskExecutorErrorCode.EXECUTION_INTERRUPTED;
      case 'max-tokens':
        return TaskExecutorErrorCode.MAX_TOKENS_REACHED;
      case 'refusal':
        return TaskExecutorErrorCode.REFUSAL;
      case 'error':
      default:
        return TaskExecutorErrorCode.EXECUTION_ERROR;
    }
  }

  /**
   * Extract text output from subagent output blocks.
   * @param {Array<Object>} outputBlocks - Raw output blocks from subagent
   * @returns {string} Concatenated text output
   */
  extractOutput(outputBlocks) {
    if (!Array.isArray(outputBlocks) || outputBlocks.length === 0) {
      log.taskExecutor.warn(`Subagent 输出为空`);
      return '';
    }

    // 提取文本块
    const textOutput = outputBlocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    // 记录非文本块
    const nonTextBlocks = outputBlocks.filter(block => block.type !== 'text');
    if (nonTextBlocks.length > 0) {
      log.taskExecutor.debug(`Subagent 输出包含非文本块`, {
        types: nonTextBlocks.map(b => b.type),
      });
    }

    return textOutput;
  }

  /**
   * Build subagent prompt with optional skill content.
   * @param {string} userPrompt - User prompt text
   * @param {Object} options - Build options
   * @param {string} options.skillContent - Skill instruction content
   * @param {string} options.skillName - Skill name
   * @returns {string} Complete prompt
   */
  buildSubagentPrompt(userPrompt, options) {
    const { skillContent, skillName } = options;

    if (skillContent) {
      return `
<skill_content name="${skillName}">
${skillContent}
</skill_content>

---

## 任务数据

${userPrompt}

---

## 执行要求

1. 遵循上述 Skill 指令执行任务
2. 如果需要创建文件，使用 \`present\` 工具声明交付物
3. 返回完整的结果
`;
    }

    return userPrompt;
  }

  /**
   * Phase 6: Collect deliverables from subagent session.
   * @param {string} sessionId - Subagent session ID
   * @returns {Promise<Array>} Array of deliverable file objects
   */
  async collectDeliverables(sessionId) {
    const deliverables = [];

    if (!this.ctx?.sessionQuery) {
      log.taskExecutor.debug(`sessionQuery 不可用，跳过交付物收集`);
      return deliverables;
    }

    try {
      const observation = await this.ctx.sessionQuery.observeSession(sessionId);
      if (!observation) {
        log.taskExecutor.warn(`无法观察 session: ${sessionId}`);
        return deliverables;
      }

      if (observation?.events) {
        for (const event of observation.events) {
          if (event.type === 'deliverables/presented') {
            const files = event.data?.files || [];
            deliverables.push(...files);
            log.taskExecutor.debug(`发现交付物`, { count: files.length });
          }
        }
      }
    } catch (e) {
      log.taskExecutor.warn(`收集交付物失败: ${e.message}`);
    }

    return deliverables;
  }

  /**
   * Phase 9: Record execution metrics for diagnostics.
   * @param {TaskResult} result - Task result
   * @param {string|null} provider - Provider used
   * @param {string} promptKey - Prompt key used
   * @returns {void}
   */
  recordMetrics(result, provider, promptKey) {
    // 性能指标
    const metrics = {
      timestamp: Date.now(),
      promptKey,
      provider,
      success: result.success,
      elapsed: result.elapsed,
      stopReason: result.stopReason,
      errorCode: result.errorCode,
      outputLength: result.output?.length || 0,
      deliverablesCount: result.deliverables?.length || 0,
      warningsCount: result.warnings?.length || 0,
    };

    // 记录到日志
    log.taskExecutor.info(`任务指标`, metrics);

    // TODO: 可以发送到外部监控系统
    // this.callbacks.onMetrics?.(metrics);
  }
}

/**
 * Create a TaskExecutor instance (factory function).
 * @param {TaskExecutorOptions} options - Executor options
 * @returns {TaskExecutor} New task executor instance
 */
export function createTaskExecutor(options) {
  return new TaskExecutor(options);
}

/**
 * Convenience method: execute a task.
 * @param {Object} ctx - DSH context
 * @param {Object} llm - LLM service
 * @param {Object} config - Configuration
 * @param {Object} options - Task options (promptKey, variables, parentAgent, cwd, etc.)
 * @returns {Promise<TaskResult>} Task result
 */
export async function executeTask(ctx, llm, config, options) {
  const executor = new TaskExecutor({
    ctx,
    llm,
    config,
    parentAgent: options.parentAgent,
    cwd: options.cwd,
    signal: options.signal,
    scopedSkills: options.scopedSkills,
    callbacks: options.callbacks,
  });

  return executor.execute(options);
}

/**
 * Convenience method: execute task and parse JSON result.
 * @param {Object} ctx - DSH context
 * @param {Object} llm - LLM service
 * @param {Object} config - Configuration
 * @param {Object} options - Task options
 * @returns {Promise<{success: boolean, data?: Object, error?: string, result: TaskResult}>}
 */
export async function executeAndParse(ctx, llm, config, options) {
  const result = await executeTask(ctx, llm, config, options);

  if (result.isError) {
    return { success: false, error: result.diagnostic || result.output, result };
  }

  const parsed = parseAIResponse(result.output);
  return { success: true, data: parsed, result };
}














/** Render the exact initial subagent payload without starting a task. */
export async function prepareTaskPrompt(ctx, llm, config, options) {
  const executor = new TaskExecutor({ ctx, llm, config, cwd: options.cwd, parentAgent: options.parentAgent });
  return executor.loadPrompt(options);
}
