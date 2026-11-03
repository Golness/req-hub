import { delegationContext, bindOwnedSession } from './delegation-context.js';
/**
 * Task executor module.
 * All LLM tasks are delegated to DSH Subagent for execution.
 *
 * The caller supplies prompt preparation and tool restrictions. Each run owns
 * its cancellation, timeout monitoring and asynchronous disposal.
 * @module task-executor
 */

import { getPromptAsync, buildFullPrompt, PROMPT_REGISTRY } from './prompts.js';
import { log } from './logger.js';
import { stat } from 'node:fs/promises';
import {
  estimateTextTokens,
  formatTokens,
  MAX_SYNC_INPUT_TOKENS,
  estimateSubagentInputTokens,
  estimatePreparedPromptTokens,
} from './token-utils.js';

/**
 * Sleep for a specified duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Task executor error codes.
 * Organized by category: preconditions, skill/prompt, provider, execution, resources.
 * @type {Object<string, string>}
 */
export const TaskExecutorErrorCode = {
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

  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  SKILL_CONTENT_EMPTY: 'SKILL_CONTENT_EMPTY',
  SKILL_TOO_LARGE: 'SKILL_TOO_LARGE',
  TEMPLATE_VARIABLE_MISSING: 'TEMPLATE_VARIABLE_MISSING',
  TEMPLATE_RENDER_FAILED: 'TEMPLATE_RENDER_FAILED',

  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_CAPABILITY_MISSING: 'PROVIDER_CAPABILITY_MISSING',
  MAX_DEPTH_REACHED: 'MAX_DEPTH_REACHED',
  SUBAGENT_POOL_FULL: 'SUBAGENT_POOL_FULL',
  START_TIMEOUT: 'START_TIMEOUT',

  EXECUTION_ERROR: 'EXECUTION_ERROR',
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
  EXECUTION_STALE: 'EXECUTION_STALE',
  EXECUTION_INTERRUPTED: 'EXECUTION_INTERRUPTED',
  MAX_TOKENS_REACHED: 'MAX_TOKENS_REACHED',
  REFUSAL: 'REFUSAL',

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
  defaultProvider: 'spawn',

  defaultAgentOptions: {
    provider: undefined, // Inherit the parent model unless the caller overrides it.
    model: undefined, // Inherit the parent model unless the caller overrides it.
    maxTokens: 8000,
  },

  defaultTimeout: 1200000,

  minTimeout: 30000,

  maxTimeout: 1200000,

  maxSkillTokens: 25000,

  maxPromptTokens: 50000,

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
   * @param {string|null} [options.skillUsed=null] - Skill verified in the child log.
   * @param {string|null} [options.requestedSkill=null] - Configured or default skill name.
   * @param {string} [options.skillStatus] - Requested, loaded, unavailable or not_bound.
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
    this.requestedSkill = options.requestedSkill || null;
    this.skillStatus = options.skillStatus || 'not_bound';
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

    this.callbacks.onStart?.({
      promptKey,
      description: description || promptKey,
      timestamp: Date.now(),
    });

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

    if (!this.ctx.skills) {
      this.addWarning('SKILLS_UNAVAILABLE', 'Skills 服务不可用，Skill 绑定将被忽略');
    }

    if (!this.parentAgent) {
      errors.push({
        code: TaskExecutorErrorCode.MISSING_PARENT_AGENT,
        message: '缺少父 Agent，无法委托任务',
      });
      return errors;
    }

    const status = this.parentAgent.status;
    if (status === 'stopped') {
      errors.push({
        code: TaskExecutorErrorCode.PARENT_AGENT_STOPPED,
        message: `父 Agent 已停止，当前状态: ${status}`,
        details: { status },
      });
      return errors;
    }

    // An idle parent may delegate work; only a stopped parent is rejected.

    if (!this.parentAgent.session) {
      errors.push({
        code: TaskExecutorErrorCode.PARENT_AGENT_NO_SESSION,
        message: '父 Agent 没有 session',
      });
      return errors;
    }

    if (options.promptKey && !PROMPT_REGISTRY[options.promptKey]) {
      // Custom prompt keys remain valid even when absent from the built-in registry.
      this.addWarning('UNKNOWN_PROMPT_KEY', `promptKey "${options.promptKey}" 不在预设列表中`);
    }

    const variableErrors = this.validateRequiredVariables(
      options.promptKey,
      options.variables || {},
    );
    if (variableErrors.length > 0) {
      for (const err of variableErrors) {
        errors.push(err);
      }
      return errors;
    }

    if (this.signal?.aborted) {
      errors.push({
        code: TaskExecutorErrorCode.TASK_CANCELLED,
        message: '任务已被取消',
      });
      return errors;
    }

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

    const delegationConfig = this.config?.ai?.delegation;
    if (!delegationConfig) {
      this.addWarning('NO_DELEGATION_CONFIG', '未配置 delegation，使用默认值');
    }

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
   * @returns Prepared delegation text, native skill selection and its reserved context budget.
   */
  async loadPrompt(options) {
    const { promptKey, variables = {} } = options;
    const result = {
      fullPrompt: '',
      skillUsed: null,
      skillContent: null,
      promptTemplate: null,
    };

    try {
      this.callbacks.onProgress?.({ stage: 'skill_loading', promptKey });

      const promptResult = await getPromptAsync(
        this.config,
        promptKey,
        this.parentAgent?.session?.header?.cwd || this.cwd,
        this.scopedSkills ||
          this.ctx?.agentPresets?.serviceFor?.(this.parentAgent, 'skills') ||
          this.ctx?.skills,
        { scope: this.parentAgent, signal: this.signal },
      );
      const { promptTemplate } = promptResult;

      result.skillUsed = null;
      result.requestedSkill = promptResult.requestedSkill || null;
      result.skillDefinition = promptResult.skillDefinition || null;
      result.skillStatus = promptResult.skillStatus || 'not_bound';
      result.skillContent = promptResult.skillDefinition?.content || null;
      result.skillTokenReserve = result.skillDefinition
        ? estimateSubagentInputTokens(JSON.stringify(result.skillDefinition)) + 256
        : 0;
      result.promptTemplate = promptTemplate;

      log.taskExecutor.debug(`加载 prompt`, {
        promptKey,
        hasTemplate: !!promptTemplate,
        templateLength: promptTemplate?.length || 0,
        variablesCount: Object.keys(variables).length,
      });

      this.callbacks.onProgress?.({
        stage: 'skill_loading',
        requestedSkill: result.requestedSkill,
        skillStatus: result.skillStatus,
        hasSkill: false,
      });
    } catch (e) {
      this.signal?.throwIfAborted();
      this.addWarning('SKILL_LOAD_FAILED', `Skill 加载失败: ${e.message}`);
      log.taskExecutor.warn(`Skill/Prompt 加载失败: ${e.message}`);
    }

    let fullPrompt = '';

    if (result.promptTemplate) {
      try {
        const variableErrors = this.validateTemplateVariables(result.promptTemplate, variables);
        if (variableErrors.length > 0) {
          this.addWarning(
            'TEMPLATE_VARIABLE_MISSING',
            `模板变量缺失: ${variableErrors.join(', ')}`,
          );
          log.taskExecutor.warn(`模板变量缺失: ${variableErrors.join(', ')}`);
        }

        fullPrompt = buildFullPrompt({
          systemPrompt: '',
          promptTemplate: result.promptTemplate,
          variables,
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
      const errorMsg = `promptKey "${promptKey}" 没有对应的模板`;
      this.addWarning('NO_TEMPLATE', errorMsg);
      log.taskExecutor.error(errorMsg);
    }

    if (result.skillStatus === 'requested' && result.requestedSkill) {
      fullPrompt = this.buildSubagentPrompt(fullPrompt, {
        skillName: result.requestedSkill,
      });
    }

    if (!fullPrompt || fullPrompt.trim().length === 0) {
      log.taskExecutor.error(`构建的 prompt 为空`, { promptKey, variables });
    }

    if (estimateTextTokens(fullPrompt) > TaskExecutorConfig.maxPromptTokens) {
      this.addWarning(
        'PROMPT_TOO_LARGE',
        `Prompt 过长 (约 ${formatTokens(estimateTextTokens(fullPrompt))} tokens)`,
      );
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

    for (const varDef of promptMeta.variables) {
      if (varDef.required) {
        if (
          !(varDef.name in variables) ||
          variables[varDef.name] === undefined ||
          variables[varDef.name] === ''
        ) {
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
    const inputLimit =
      options.maxInputTokens ??
      (options.promptKey?.startsWith('phased-') ? MAX_SYNC_INPUT_TOKENS : null);
    if (inputLimit && estimatePreparedPromptTokens(promptData) >= inputLimit) {
      throw new TaskExecutorError(
        `同步输入超过预算（须小于 ${inputLimit} tokens），请减少固定 prompt 或拆分输入`,
        'PROMPT_TOO_LARGE',
      );
    }

    const provider = this.config?.ai?.delegation?.provider || TaskExecutorConfig.defaultProvider;

    const providerInstance = this.ctx.subagents.getProvider(provider);
    if (!providerInstance) {
      const availableProviders = this.ctx.subagents.list() || [];
      throw new TaskExecutorError(
        `Subagent provider "${provider}" 未注册，可用: ${availableProviders.join(', ') || '(无)'}`,
        TaskExecutorErrorCode.PROVIDER_NOT_FOUND,
        { availableProviders },
      );
    }

    const capabilities = providerInstance.capabilities || {};

    if (agentOptions && !capabilities.agentOptions) {
      throw new TaskExecutorError(
        `Provider "${provider}" 不支持 agentOptions`,
        TaskExecutorErrorCode.PROVIDER_CAPABILITY_MISSING,
        { capability: 'agentOptions', available: Object.keys(capabilities) },
      );
    }

    if (options.outputSchema && !capabilities.outputSchema) {
      this.addWarning(
        'OUTPUT_SCHEMA_UNSUPPORTED',
        `Provider "${provider}" 不支持 outputSchema，将被忽略`,
      );
    }

    if (options.toolFilter && !capabilities.toolFilter) {
      throw new TaskExecutorError(`Provider ${provider} 不支持工具隔离`, 'CAPABILITY_UNSUPPORTED');
    }

    const maxDepth = this.config?.ai?.delegation?.maxDepth;
    if (maxDepth !== undefined && maxDepth <= 0) {
      throw new TaskExecutorError('已达到最大委托深度', TaskExecutorErrorCode.MAX_DEPTH_REACHED, {
        maxDepth,
      });
    }

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

    // Omit undefined overrides so the parent provider and model remain available.
    const mergedAgentOptions = Object.fromEntries(
      Object.entries({
        ...TaskExecutorConfig.defaultAgentOptions,
        ...this.config?.ai?.delegation?.agentOptions,
        ...agentOptions,
      }).filter(([_, v]) => v !== undefined),
    );

    const startController = new AbortController();
    const startSignal = startController
      ? AbortSignal.any([startController.signal, this.signal].filter(Boolean))
      : this.signal;
    startSignal?.throwIfAborted();
    if (options.runtime) {
      options.runtime.parentSessionId = this.parentAgent.session.id;
    }
    const startPromise = Promise.resolve(
      delegationContext.run(options.runtime, () =>
        this.ctx.subagents.start(provider, {
          label: description || promptKey,
          prompt: [{ type: 'text', text: fullPrompt }],
          parent: this.parentAgent,
          signal: startSignal,
          ...(options.toolFilter ? { toolFilter: options.toolFilter } : {}),
          ...(Object.values(mergedAgentOptions).some((v) => v !== undefined)
            ? { agentOptions: mergedAgentOptions }
            : {}),
        }),
      ),
    ).then(async (run) => {
      if (options.runtime && !options.runtime.closed && !startSignal.aborted) {
        try {
          bindOwnedSession(options.runtime, run.id);
        } catch (error) {
          await run.dispose();
          throw error;
        }
      }
      // A child may settle while an awaited progress callback persists its ID.
      if (options.syncV2) {
        void run.result.catch((error) => {
          // Setup failed before result consumption; observe the result rejection while cleanup reclaims the run.
        });
      }
      return run;
    });

    // Clear timeout handles when the run settles so they cannot reject after completion.
    const startTimeoutMs = 30000;
    let startTimeoutId;
    const startTimeoutPromise = new Promise((_, reject) => {
      startTimeoutId = setTimeout(
        () =>
          reject(
            new TaskExecutorError(
              `Subagent 启动超时 (${startTimeoutMs}ms)`,
              TaskExecutorErrorCode.START_TIMEOUT,
            ),
          ),
        startTimeoutMs,
      );
    });

    try {
      const run = await Promise.race([startPromise, startTimeoutPromise]);
      startSignal.throwIfAborted();
      if (options.runtime?.closed) {
        throw new Error('DELEGATION_RUNTIME_CLOSED');
      }
      return { run, provider, startController };
    } catch (e) {
      if (startController) {
        startController.abort(e);
        // DSH start() owns setup until it settles; reclaim even a handle published
        // after the caller's timeout, before releasing the sync reservation.
        try {
          const lateRun = await startPromise;
          await lateRun?.dispose();
        } catch (error) {
          // A rejected start promise has no published run handle to reclaim.
        }
      }
      if (e.code === TaskExecutorErrorCode.START_TIMEOUT) {
        throw e;
      }

      if (e.message?.includes('pool') || e.message?.includes('maxActiveSubagents')) {
        throw new TaskExecutorError(
          'Subagent 池已满，无法创建新的子代理',
          TaskExecutorErrorCode.SUBAGENT_POOL_FULL,
          { originalError: e.message },
        );
      }
      throw e;
    } finally {
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

    await this.callbacks.onProgress?.({
      stage: 'executing',
      sessionId,
    });

    log.taskExecutor.debug(`Subagent 已启动`, { sessionId });

    const timeoutMs = Math.min(
      Math.max(timeout || TaskExecutorConfig.defaultTimeout, TaskExecutorConfig.minTimeout),
      TaskExecutorConfig.maxTimeout,
    );

    // Clear timeout handles when the run settles so they cannot reject after completion.

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new TaskExecutorError(
              `执行超时 (${timeoutMs}ms)`,
              TaskExecutorErrorCode.EXECUTION_TIMEOUT,
            ),
          ),
        timeoutMs,
      );
    });

    const livenessConfig =
      options.liveness ?? this.config?.ai?.delegation?.liveness ?? TaskExecutorConfig.liveness;

    let livenessMonitor = null;
    let livenessReject = null;
    const livenessPromise = livenessConfig?.enabled
      ? new Promise((_, reject) => {
          livenessReject = reject;
        })
      : new Promise(() => {});

    if (livenessConfig?.enabled) {
      livenessMonitor = await this.monitorLiveness(sessionId, livenessConfig, Date.now());

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
      const result = await Promise.race([run.result, timeoutPromise, livenessPromise]);

      let outputType;
      if (result.output) {
        if (Array.isArray(result.output)) {
          outputType = 'array';
        } else {
          outputType = typeof result.output;
        }
      } else {
        outputType = 'null';
      }
      let outputLength;
      if (result.output) {
        if (Array.isArray(result.output)) {
          outputLength = result.output.length;
        } else {
          outputLength = result.output.length;
        }
      } else {
        outputLength = 0;
      }
      log.taskExecutor.info(`Subagent 原始结果`, {
        stopReason: result.stopReason,
        hasOutput: !!result.output,
        outputType: outputType,
        outputLength: outputLength,
        hasDiagnostic: !!result.diagnostic,
        diagnostic: result.diagnostic ? result.diagnostic.substring(0, 500) : null,
        hasError: !!result.error,
        errorMessage: result.error?.message,
      });

      return { result, sessionId };
    } finally {
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
      stop: () => {
        stopped = true;
      },
      get staleError() {
        return staleError;
      },
      get lastActivityTime() {
        return lastActivityTime;
      },
      get lastActivityDesc() {
        return lastActivityDesc;
      },
    };

    const isActiveEvent = (event) => {
      const type = event.type || '';

      if (type === 'turn/start' || type === 'turn/end') {
        return true;
      }

      if (type === 'user/message' || type === 'assistant/message') {
        return true;
      }

      if (type.startsWith('tool_') || type.includes('tool')) {
        return true;
      }

      if (type.includes('deliverable')) {
        return true;
      }
      return false;
    };

    const describeEvent = (event) => {
      const type = event.type || '';
      if (type === 'turn/start') {
        return 'AI 思考中';
      }
      if (type === 'turn/end') {
        return '轮次完成';
      }
      if (type === 'user/message') {
        return '收到用户输入';
      }
      if (type === 'assistant/message') {
        return 'AI 回复中';
      }
      if (type.includes('tool')) {
        return '调用工具中';
      }
      if (type.includes('deliverable')) {
        return '生成交付物';
      }
      return type;
    };

    (async () => {
      await sleep(gracePeriodMs);

      while (!stopped) {
        await sleep(pollIntervalMs);
        if (stopped) {
          break;
        }

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

          let hasActiveTurn = false;
          let latestActiveEvent = null;
          let latestActiveTime = 0;

          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            if (!isActiveEvent(e)) {
              continue;
            }

            if (e.type === 'turn/start') {
              let hasEnd = false;
              for (let j = i + 1; j < events.length; j++) {
                if (events[j].type === 'turn/end') {
                  hasEnd = true;
                  break;
                }
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

          if (staleCount >= warnAfterStaleCount && !warned) {
            warned = true;
            const msg = `Subagent 可能已卡住: ${Math.round(stalenessDuration / 1000)}s 无活动（最后活动: ${lastActivityDesc}）`;
            this.addWarning('SUBAGENT_STALE', msg);
            log.taskExecutor.warn(msg, { sessionId, staleCount });
          }

          if (staleCount >= interruptAfterStaleCount && autoInterrupt) {
            const msg = `Subagent 检测到无响应: ${Math.round(stalenessDuration / 1000)}s 无活动，自动中断`;
            log.taskExecutor.error(msg, { sessionId, staleCount });

            // One-shot runs are cancelled through AbortSignal; interrupt() only owns continuable residents.

            staleError = new TaskExecutorError(msg, TaskExecutorErrorCode.EXECUTION_STALE, {
              sessionId,
              staleCount,
              stalenessDuration,
            });
            break;
          }
        } catch (e) {
          if (e.code === TaskExecutorErrorCode.EXECUTION_STALE) {
            throw e;
          }
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
      const promptData = options.preparedPromptData || (await this.loadPrompt(options));

      const startResult = await this.startSubagent(options, promptData);
      run = startResult.run;
      runController = startResult.startController;
      const { provider } = startResult;

      const execResult = await this.executeSubagent(run, options);
      const { result, sessionId } = execResult;
      this.signal?.throwIfAborted();
      const failure =
        result.stopReason === 'error' && !result.diagnostic
          ? options.runtime?.failure || (await this.readSubagentFailure(sessionId))
          : null;

      const output = this.extractOutput(result.output);

      let outputType;
      if (result.output) {
        if (Array.isArray(result.output)) {
          outputType = 'array';
        } else {
          outputType = typeof result.output;
        }
      } else {
        outputType = 'null';
      }
      log.taskExecutor.debug(`Subagent 执行结果`, {
        stopReason: result.stopReason,
        outputLength: output.length,
        hasDiagnostic: !!result.diagnostic,
        diagnostic: result.diagnostic || failure?.message || result.error?.message || null,
        structured: result.structured ? Object.keys(result.structured) : null,
        rawOutputType: outputType,
        rawOutputLength: result.output ? result.output.length : 0,
      });

      this.callbacks.onProgress?.({
        stage: 'collecting_deliverables',
      });

      const deliverables = await this.collectDeliverables(sessionId);

      const skillReceipt = await this.readNativeSkillReceipt(sessionId, promptData.requestedSkill);
      if (promptData.skillStatus === 'requested' && !skillReceipt) {
        this.addWarning(
          'NATIVE_SKILL_NOT_LOADED',
          'DSH did not record the requested skill invocation.',
        );
      }
      let skillStatus = promptData.skillStatus;
      if (promptData.requestedSkill) {
        skillStatus = skillReceipt ? 'loaded' : 'unavailable';
      }
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
        diagnostic: result.diagnostic || failure?.message || result.error?.message || null,
        skillUsed: skillReceipt ? promptData.requestedSkill : null,
        requestedSkill: promptData.requestedSkill,
        skillStatus,
        elapsed,
        errorCode: failure?.code || this.getErrorCodeFromStopReason(result.stopReason),
        warnings: this.warnings,
      });

      this.recordMetrics(taskResult, provider, promptKey);

      this.callbacks.onComplete?.({ result: taskResult });

      return taskResult;
    } catch (e) {
      const elapsed = Date.now() - startTime;

      const errorCode =
        e instanceof TaskExecutorError ? e.code : TaskExecutorErrorCode.EXECUTION_ERROR;

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

      this.recordMetrics(result, null, promptKey);

      this.callbacks.onError?.({ error: e, result });

      return result;
    } finally {
      runController?.abort();
      await this.disposeRun(run, { strict: !!options.syncV2 });
    }
  }

  /**
   * Verify native skill loading from one owned spawn child's durable messages.
   * @param sessionId - The child session returned by the Host provider.
   * @param name - Requested skill name, or null for an unbound task.
   * @returns Whether DSH recorded a native instructions injection for this skill.
   */
  async readNativeSkillReceipt(sessionId, name) {
    if (!name || !this.ctx.sessionQuery?.observeSession) {
      return false;
    }
    let observation;
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal: this.signal });
      this.signal?.throwIfAborted();
      if (observation.header?.parentSession !== this.parentAgent?.session?.id) {
        return false;
      }
      return observation.events.some(
        (event) =>
          event.type === 'user/message' &&
          event.data?.source?.kind === 'skill-invocation' &&
          event.data.source.name === name &&
          event.data.source.form === 'instructions',
      );
    } catch (error) {
      this.signal?.throwIfAborted();
      return false;
    } finally {
      observation?.[Symbol.dispose]?.();
    }
  }

  /** Recover a failed owned child's final-turn diagnostic when spawn omits it. */
  async readSubagentFailure(sessionId) {
    if (!this.ctx.sessionQuery?.observeSession) {
      return null;
    }
    let observation;
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, { signal: this.signal });
      const end = observation.events.findLast((event) => event.type === 'turn/end');
      return end?.data?.reason?.kind === 'error' ? end.data.reason.error : null;
    } catch (error) {
      log.taskExecutor.warn('Subagent failure diagnostic unavailable', {
        sessionId,
        error: error.message,
      });
      return null;
    } finally {
      observation?.[Symbol.dispose]?.();
    }
  }

  /** Phase 5: await quiescent disposal before returning execution ownership. */
  async disposeRun(run, { strict = false } = {}) {
    if (!run) {
      return;
    }

    try {
      await run.dispose();
      log.taskExecutor.debug(`Subagent 资源已释放`);
    } catch (disposeError) {
      log.taskExecutor.warn(`资源释放失败: ${disposeError.message}`);
      if (strict) {
        throw disposeError;
      }
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

    const textOutput = outputBlocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const nonTextBlocks = outputBlocks.filter((block) => block.type !== 'text');
    if (nonTextBlocks.length > 0) {
      log.taskExecutor.debug(`Subagent 输出包含非文本块`, {
        types: nonTextBlocks.map((b) => b.type),
      });
    }

    return textOutput;
  }

  /**
   * Build delegation text with an optional native DSH skill invocation.
   * @param {string} userPrompt - User prompt text
   * @param {Object} options - Build options
   * @param {string} options.skillName - Validated native invocation name
   * @returns {string} Complete prompt
   */
  buildSubagentPrompt(userPrompt, options) {
    const { skillName } = options;
    if (!skillName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
      return userPrompt;
    }
    return `/${skillName}

Apply the skill loaded by DSH to English instructions and intermediate text.
Use English for progress, analysis, reports, diagnostics, and task acknowledgments.
Only final deliverable content uses the requested or input document language.
Use Simplified Chinese when no delivery language can be determined.
Keep facts, conditions, uncertainty, code, paths, and protocol fields unchanged.
The task protocol controls tools and output format. Do not add delivery tools.
If DSH cannot load this skill, continue with the task protocol.

Task protocol and frozen input:
${userPrompt}`;
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

    let observation;
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId);
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
    } finally {
      observation?.[Symbol.dispose]?.();
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

    log.taskExecutor.info(`任务指标`, metrics);

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
 * Render the exact initial subagent payload without starting a task.
 * @param ctx - The injected Host context.
 * @param llm - The Host model service.
 * @param config - Validated plugin configuration.
 * @param options - Operation-specific limits and service dependencies.
 * @returns The prepared payload and complete input-budget metadata.
 */
export async function prepareTaskPrompt(ctx, llm, config, options) {
  const executor = new TaskExecutor({
    ctx,
    llm,
    config,
    cwd: options.cwd,
    parentAgent: options.parentAgent,
    signal: options.signal,
    scopedSkills: options.scopedSkills,
  });
  return executor.loadPrompt(options);
}
