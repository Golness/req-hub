/**
 * TaskExecutor 基础测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TaskExecutor,
  TaskResult,
  TaskExecutorError,
  TaskExecutorErrorCode,
  TaskExecutorConfig,
  createTaskExecutor,
} from '../../src/server/task-executor.js';

// Mock 依赖模块

vi.mock('../../src/server/prompts.js', () => ({
  PROMPT_REGISTRY: {
    writing: {
      variables: [{ name: 'docsContent', required: true, description: '文档内容' }],
    },
  },
  getPromptAsync: vi.fn().mockResolvedValue({
    systemPrompt: 'You are a helpful assistant.',
    promptTemplate: 'Analyze: {docsContent}',
    skillUsed: null,
  }),
  buildFullPrompt: vi.fn(({ promptTemplate, variables }) => {
    let result = promptTemplate;
    for (const [k, v] of Object.entries(variables)) {
      result = result.replace(`{${k}}`, v);
    }
    return result;
  }),
}));

vi.mock('../../src/server/logger.js', () => ({
  log: {
    taskExecutor: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('../../src/server/token-utils.js', () => ({
  estimateTextTokens: (s) => Math.ceil(s.length / 4),
  formatTokens: (n) => `${n}`,
  MAX_SYNC_INPUT_TOKENS: 150000,
  estimatePreparedPromptTokens: (prepared) =>
    Buffer.byteLength(prepared.fullPrompt || '', 'utf8') + 8 + (prepared.skillTokenReserve || 0),
  estimateSubagentInputTokens: (s) => Buffer.byteLength(s || '', 'utf8') + 8,
}));

// Mock fs.stat for cwd validation
vi.mock('node:fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
}));

const { createMockCtx, createMockParentAgent, createMockLLM, createMockRun } =
  globalThis.__testHelpers;

describe('TaskResult', () => {
  it('should report isError=false for successful completion', () => {
    const r = new TaskResult({ success: true, stopReason: 'completed' });
    expect(r.isError).toBe(false);
  });

  it('should report isError=true for error stopReason', () => {
    const r = new TaskResult({ success: false, stopReason: 'error' });
    expect(r.isError).toBe(true);
  });

  it('should return user-friendly messages', () => {
    expect(new TaskResult({ success: true, stopReason: 'completed' }).getUserMessage()).toBe(
      'TASK_EXECUTION_SUCCEEDED',
    );
    expect(new TaskResult({ success: false, stopReason: 'aborted' }).getUserMessage()).toBe(
      'TASK_INTERRUPTED',
    );
    expect(new TaskResult({ success: false, stopReason: 'max-tokens' }).getUserMessage()).toContain(
      'ERR_OUTPUT_LENGTH_LIMIT',
    );
    expect(new TaskResult({ success: false, stopReason: 'refusal' }).getUserMessage()).toContain(
      'ERR_MODEL_REFUSED_TASK',
    );
  });

  it('toSimpleString returns output', () => {
    const r = new TaskResult({ output: 'hello' });
    expect(r.toSimpleString()).toBe('hello');
  });
});

describe('TaskExecutorError', () => {
  it('should have code and details', () => {
    const err = new TaskExecutorError('test', 'CODE_A', { foo: 1 });
    expect(err.code).toBe('CODE_A');
    expect(err.details).toEqual({ foo: 1 });
    expect(err.name).toBe('TaskExecutorError');
  });
});

describe('TaskExecutor', () => {
  let ctx, parentAgent, llm, config;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockCtx();
    parentAgent = createMockParentAgent();
    llm = createMockLLM();
    config = {};
  });

  describe('validatePreconditions', () => {
    it('should fail when ctx is missing', async () => {
      const executor = createTaskExecutor({ ctx: null, llm, config, parentAgent, cwd: '/tmp' });
      const errors = await executor.validatePreconditions({ promptKey: 'writing', variables: {} });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe(TaskExecutorErrorCode.INVALID_CONTEXT);
    });

    it('should fail when subagents service is missing', async () => {
      const badCtx = { subagents: null };
      const executor = createTaskExecutor({ ctx: badCtx, llm, config, parentAgent, cwd: '/tmp' });
      const errors = await executor.validatePreconditions({ promptKey: 'writing', variables: {} });
      expect(errors[0].code).toBe(TaskExecutorErrorCode.SUBAGENT_UNAVAILABLE);
    });

    it('should fail when parentAgent is missing', async () => {
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent: null, cwd: '/tmp' });
      const errors = await executor.validatePreconditions({ promptKey: 'writing', variables: {} });
      expect(errors[0].code).toBe(TaskExecutorErrorCode.MISSING_PARENT_AGENT);
    });

    it('should fail when parentAgent is stopped', async () => {
      const stopped = createMockParentAgent({ status: 'stopped' });
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent: stopped, cwd: '/tmp' });
      const errors = await executor.validatePreconditions({ promptKey: 'writing', variables: {} });
      expect(errors[0].code).toBe(TaskExecutorErrorCode.PARENT_AGENT_STOPPED);
    });

    it('should fail when parentAgent has no session', async () => {
      const noSession = createMockParentAgent({ session: null });
      const executor = createTaskExecutor({
        ctx,
        llm,
        config,
        parentAgent: noSession,
        cwd: '/tmp',
      });
      const errors = await executor.validatePreconditions({ promptKey: 'writing', variables: {} });
      expect(errors[0].code).toBe(TaskExecutorErrorCode.PARENT_AGENT_NO_SESSION);
    });

    it('should pass with valid inputs', async () => {
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent, cwd: '/tmp' });
      const errors = await executor.validatePreconditions({
        promptKey: 'writing',
        variables: { docsContent: 'some content' },
      });
      expect(errors).toEqual([]);
    });

    it('should fail when required variables are missing', async () => {
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent, cwd: '/tmp' });
      const errors = await executor.validatePreconditions({
        promptKey: 'writing',
        variables: {},
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe('MISSING_REQUIRED_VARIABLE');
    });
  });

  describe('validateTemplateVariables', () => {
    it('should detect missing variables', () => {
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent, cwd: '/tmp' });
      const missing = executor.validateTemplateVariables('Hello {name}, your {role} is ready', {
        name: 'Alice',
      });
      expect(missing).toEqual(['role']);
    });

    it('should return empty array when all variables present', () => {
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent, cwd: '/tmp' });
      const missing = executor.validateTemplateVariables('Hello {name}', { name: 'Alice' });
      expect(missing).toEqual([]);
    });
  });

  describe('extractOutput', () => {
    it('should extract text blocks', () => {
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent, cwd: '/tmp' });
      const output = executor.extractOutput([
        { type: 'text', text: 'line 1' },
        { type: 'tool_use', text: 'ignored' },
        { type: 'text', text: 'line 2' },
      ]);
      expect(output).toBe('line 1\nline 2');
    });

    it('should return empty string for empty input', () => {
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent, cwd: '/tmp' });
      expect(executor.extractOutput([])).toBe('');
      expect(executor.extractOutput(null)).toBe('');
    });
  });

  describe('getErrorCodeFromStopReason', () => {
    it('should map stopReasons to error codes', () => {
      const executor = createTaskExecutor({ ctx, llm, config, parentAgent, cwd: '/tmp' });
      expect(executor.getErrorCodeFromStopReason('completed')).toBeNull();
      expect(executor.getErrorCodeFromStopReason('aborted')).toBe(
        TaskExecutorErrorCode.EXECUTION_INTERRUPTED,
      );
      expect(executor.getErrorCodeFromStopReason('max-tokens')).toBe(
        TaskExecutorErrorCode.MAX_TOKENS_REACHED,
      );
      expect(executor.getErrorCodeFromStopReason('refusal')).toBe(TaskExecutorErrorCode.REFUSAL);
      expect(executor.getErrorCodeFromStopReason('error')).toBe(
        TaskExecutorErrorCode.EXECUTION_ERROR,
      );
    });
  });

  describe('execute', () => {
    it('should return error result when preconditions fail', async () => {
      const executor = createTaskExecutor({ ctx: null, llm, config, parentAgent, cwd: '/tmp' });
      const result = await executor.execute({ promptKey: 'writing', variables: {} });
      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe(TaskExecutorErrorCode.INVALID_CONTEXT);
    });

    it('should execute successfully with valid setup', async () => {
      const mockRun = createMockRun();
      ctx.subagents.start.mockResolvedValue(mockRun);

      const executor = createTaskExecutor({ ctx, llm, config, parentAgent, cwd: '/tmp' });
      const result = await executor.execute({
        promptKey: 'writing',
        variables: { docsContent: 'test doc' },
        description: 'Test analysis',
      });

      expect(result).toBeDefined();
      expect(result.elapsed).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('TaskExecutorConfig', () => {
  it('should have sensible defaults', () => {
    expect(TaskExecutorConfig.defaultTimeout).toBe(1200000);
    expect(TaskExecutorConfig.minTimeout).toBe(30000);
    expect(TaskExecutorConfig.maxTimeout).toBe(3600000);
    expect(TaskExecutorConfig.maxSkillTokens).toBeGreaterThan(0);
    expect(TaskExecutorConfig.liveness.enabled).toBe(true);
  });
});

describe('sync initial input budget', () => {
  it('rejects the boundary and oversized prepared inputs before contacting the provider', async () => {
    const executor = new TaskExecutor({ ctx: createMockCtx(), config: {} });
    for (const length of [149992, 150001]) {
      await expect(
        executor.startSubagent(
          { promptKey: 'phased-code-analysis-design' },
          { fullPrompt: 'x'.repeat(length) },
        ),
      ).rejects.toMatchObject({ code: 'PROMPT_TOO_LARGE' });
    }
    expect(executor.ctx.subagents.start).not.toHaveBeenCalled();
  });

  it('counts multibyte text before dispatch', async () => {
    const executor = new TaskExecutor({ ctx: createMockCtx(), config: {} });
    await expect(
      executor.startSubagent(
        { promptKey: 'phased-discussion-analysis-requirement' },
        { fullPrompt: '中'.repeat(50000) },
      ),
    ).rejects.toMatchObject({ code: 'PROMPT_TOO_LARGE' });
    expect(executor.ctx.subagents.start).not.toHaveBeenCalled();
  });
});

describe('prepared sync payload dispatch', () => {
  it.each([undefined, 16000])('preserves the Host output policy unless overridden (%s)', async (maxTokens) => {
    const executor = new TaskExecutor({ ctx: createMockCtx(), config: {} });
    await executor.startSubagent(
      { promptKey: 'writing', agentOptions: { maxTokens } },
      { fullPrompt: 'bounded prompt' },
    );
    const request = executor.ctx.subagents.start.mock.calls[0][1];
    if (maxTokens === undefined) {
      expect(request.agentOptions).toBeUndefined();
    } else {
      expect(request.agentOptions.maxTokens).toBe(maxTokens);
    }
  });

  it('sends exactly the premeasured text and does not reload the prompt', async () => {
    const executor = new TaskExecutor({ ctx: createMockCtx(), config: {} });
    const load = vi.spyOn(executor, 'loadPrompt');
    vi.spyOn(executor, 'executeSubagent').mockResolvedValue({
      result: { output: 'ok', stopReason: 'completed' },
      sessionId: 'run',
    });
    vi.spyOn(executor, 'collectDeliverables').mockResolvedValue([]);
    const preparedPromptData = { fullPrompt: 'measured complete prompt', skillUsed: null };
    const result = await executor.executeViaSubagent(
      { promptKey: 'phased-code-analysis-design', preparedPromptData },
      Date.now(),
    );
    expect(result.isError).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(executor.ctx.subagents.start.mock.calls[0][1].prompt).toEqual([
      { type: 'text', text: preparedPromptData.fullPrompt },
    ]);
  });

  it('does not impose the sync budget on unrelated tasks', async () => {
    const executor = new TaskExecutor({ ctx: createMockCtx(), config: {} });
    await executor.startSubagent({ promptKey: 'writing' }, { fullPrompt: 'x'.repeat(160000) });
    expect(executor.ctx.subagents.start).toHaveBeenCalledOnce();
  });
});

describe('shared execution deadline', () => {
  it.each([300000, 1200000, 3600000])(
    'uses the general deadline and ignores an independent timeout (general=%s)',
    async (timeout) => {
      vi.useFakeTimers();
      try {
        const executor = new TaskExecutor({
          ctx: createMockCtx(),
          config: { general: { taskTimeoutMs: timeout } },
        });
        const monitor = {
          staleError: null,
          stop: vi.fn(() => {
            monitor.staleError = new Error('stopped');
          }),
        };
        vi.spyOn(executor, 'monitorLiveness').mockResolvedValue(monitor);
        const run = { id: 'pending', result: new Promise(() => {}) };
        let error;
        const pending = executor.executeSubagent(run, { timeout: 3600000 }).catch((e) => {
          error = e;
        });
        await vi.advanceTimersByTimeAsync(timeout - 1);
        expect(error).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(error.code).toBe(TaskExecutorErrorCode.EXECUTION_TIMEOUT);
        expect(error.message).toBe('ERR_EXECUTION_TIMEOUT');
        expect(error.params).toEqual({ v0: timeout });
        expect(monitor.stop).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1000);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
