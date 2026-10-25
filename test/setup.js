/**
 * Vitest 全局 setup
 * 提供 DSH 服务的 mock 和通用工具
 */

import { vi } from 'vitest';
import Module, { createRequire } from 'node:module';

// CSS Modules retain class identities in source-plane DOM tests.
Module._extensions['.css'] = (module) => { module.exports = { default: new Proxy({}, { get: (_, key) => typeof key === 'string' ? key : undefined }) }; };

// ─── Mock DSH Context ─────────────────────────────────────────────

/**
 * 创建 mock DSH 上下文
 */
export function createMockCtx(overrides = {}) {
  return {
    subagents: {
      start: vi.fn().mockResolvedValue(createMockRun()),
      getProvider: vi.fn().mockReturnValue({
        capabilities: { agentOptions: true, outputSchema: false, toolFilter: false },
      }),
      list: vi.fn().mockReturnValue(['spawn']),
      interrupt: vi.fn(),
    },
    skills: {
      load: vi.fn().mockResolvedValue(''),
      get: vi.fn().mockResolvedValue(null),
    },
    sessionQuery: {
      observeSession: vi.fn().mockResolvedValue({ events: [] }),
    },
    webServer: {
      broadcast: vi.fn(),
    },
    ...overrides,
  };
}

/**
 * 创建 mock subagent run 对象
 */
export function createMockRun(overrides = {}) {
  return {
    id: 'mock-session-id',
    result: Promise.resolve({
      stopReason: 'completed',
      output: [{ type: 'text', text: '{"summary":"test"}' }],
      diagnostic: null,
      structured: null,
      ...overrides,
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * 创建 mock parent agent
 */
export function createMockParentAgent(overrides = {}) {
  return {
    status: 'running',
    session: { id: 'parent-session-id' },
    ...overrides,
  };
}

/**
 * 创建 mock LLM 服务
 */
export function createMockLLM(overrides = {}) {
  return {
    getModel: vi.fn().mockReturnValue('mock-model'),
    ...overrides,
  };
}

// ─── Mock fs ───────────────────────────────────────────────────────

/**
 * 创建 mock 文件系统
 * 返回一个 Map 模拟文件路径 → 内容
 */
export function createMockFS() {
  const files = new Map();
  const dirs = new Set();

  return {
    files,
    dirs,
    addFile(path, content) {
      files.set(path, typeof content === 'string' ? content : JSON.stringify(content));
    },
    addDir(path) {
      dirs.add(path);
    },
    clear() {
      files.clear();
      dirs.clear();
    },
  };
}

// ─── Mock Logger ───────────────────────────────────────────────────

/**
 * 创建 mock logger
 */
export function createMockLogger() {
  const noop = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    state: { ...noop },
    taskExecutor: { ...noop },
    analysis: { ...noop },
    sync: { ...noop },
    tree: { ...noop },
    config: { ...noop },
    general: { ...noop },
  };
}

// ─── Global stubs ──────────────────────────────────────────────────

// Make mock helpers available globally in tests
globalThis.__testHelpers = {
  createMockCtx,
  createMockRun,
  createMockParentAgent,
  createMockLLM,
  createMockFS,
  createMockLogger,
};
