/**
 * 分析引擎测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/server/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ docsDir: 'docs' }),
}));

vi.mock('../../src/server/doc-reader.js', () => ({
  readRequirementDocs: vi.fn().mockResolvedValue('# Test Doc\nSome content'),
  writeMetaJson: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/server/meta.js', () => ({
  validateMeta: vi.fn((meta) => meta),
}));

vi.mock('../../src/server/task-executor.js', () => ({
  executeTask: vi.fn().mockResolvedValue({
    isError: false,
    output: '{"summary":"test analysis","features":["f1"],"type":"feature"}',
  }),
}));

vi.mock('../../src/server/ai-engine.js', () => ({
  parseAIResponse: vi.fn((text) => {
    try { return JSON.parse(text); } catch { return null; }
  }),
}));

vi.mock('../../src/server/logger.js', () => ({
  log: {
    analysis: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

const { analyzeRequirement } = await import('../../src/server/analyze-engine.js');
const { readRequirementDocs, writeMetaJson } = await import('../../src/server/doc-reader.js');
const { executeTask } = await import('../../src/server/task-executor.js');

const { createMockCtx, createMockParentAgent, createMockLLM } = globalThis.__testHelpers;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default mocks
  readRequirementDocs.mockResolvedValue('# Test Doc\nSome content');
  executeTask.mockResolvedValue({
    isError: false,
    output: '{"summary":"test analysis","features":["f1"],"type":"feature"}',
  });
});

describe('analyzeRequirement', () => {
  const baseOptions = () => ({
    ctx: createMockCtx(),
    llm: createMockLLM(),
    config: {},
    parentAgent: createMockParentAgent(),
    reqPath: '/docs/dev/2024-01-01-test',
    requirementId: '2024-01-01-test',
    cwd: '/project',
  });

  it('should successfully analyze a requirement', async () => {
    const result = await analyzeRequirement(baseOptions());

    expect(result.success).toBe(true);
    expect(result.meta).toBeDefined();
    expect(result.elapsed).toBeDefined();
    expect(writeMetaJson).toHaveBeenCalled();
  });

  it('should fail when no docs found', async () => {
    readRequirementDocs.mockResolvedValue(null);

    const result = await analyzeRequirement(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('无支持的文档文件');
  });

  it('should fail when task execution returns error', async () => {
    executeTask.mockResolvedValue({
      isError: true,
      output: '',
      diagnostic: 'LLM rate limit exceeded',
    });

    const result = await analyzeRequirement(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM rate limit exceeded');
  });

  it('should fail when AI response is invalid', async () => {
    executeTask.mockResolvedValue({
      isError: false,
      output: 'not valid json at all',
    });

    const result = await analyzeRequirement(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toContain('无效');
  });

  it('should handle exceptions gracefully', async () => {
    readRequirementDocs.mockRejectedValue(new Error('disk error'));

    const result = await analyzeRequirement(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toBe('disk error');
    expect(result.elapsed).toBeDefined();
  });

  it('should pass scopedSkills to executeTask', async () => {
    const scopedSkills = { 'my-skill': 'content' };
    await analyzeRequirement({ ...baseOptions(), scopedSkills });

    expect(executeTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        scopedSkills,
      }),
    );
  });

  it('should call executeTask with correct promptKey', async () => {
    await analyzeRequirement(baseOptions());

    expect(executeTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        promptKey: 'analyze',
      }),
    );
  });
});
