/**
 * 配置管理模块测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockReaddir = vi.fn();
const mockExistsSync = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args) => mockReadFile(...args),
  writeFile: (...args) => mockWriteFile(...args),
  readdir: (...args) => mockReaddir(...args),
  mkdir: vi.fn(), rename: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: (...args) => mockExistsSync(...args),
}));

const { loadConfig, saveConfig, autoDefaultConfig } = await import('../../src/server/config.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

it.each([
  { taskTimeoutMs: 29999 },
  { taskTimeoutMs: 3600001 },
  { knowledgeMaxInputBytes: 999 },
  { knowledgeMaxResultBytes: 1000001 },
])('rejects invalid general execution policy %j', async general => {
  await expect(saveConfig({ general })).rejects.toThrow('INVALID_CONFIG');
});

it.each([300000, 1200000, 3600000])('preserves an explicit deadline of %s ms', async (timeout) => {
  mockExistsSync.mockReturnValue(true);
  mockReadFile.mockResolvedValue(JSON.stringify({ general: { taskTimeoutMs: timeout } }));
  expect((await loadConfig()).general.taskTimeoutMs).toBe(timeout);
});

describe('loadConfig', () => {
  it('validates workspace publication bindings independently of CLI connection settings', async () => {
    mockExistsSync.mockReturnValue(true);
    const binding = {
      workspaceRoot: 'C:/projects/alpha', kind: 'wiki', token: 'WikABC',
      url: 'https://team.feishu.cn/wiki/WikABC', title: 'Parent', spaceId: '123',
      objToken: 'DocABC', objType: 'docx', appId: 'cli_test', accountId: 'ou_user',
      profile: '', identity: 'user', checkedAt: '2026-11-05T00:00:00.000Z',
    };
    mockReadFile.mockResolvedValue(JSON.stringify({ larkTargets: { alpha: binding } }));
    expect((await loadConfig()).larkTargets.alpha).toEqual(binding);
    const defaultBinding = { ...binding, useDefault: true };
    mockReadFile.mockResolvedValue(JSON.stringify({ larkTargets: { alpha: defaultBinding } }));
    expect((await loadConfig()).larkTargets.alpha).toEqual(defaultBinding);
    for (const larkTargets of [null, [], { alpha: { ...binding, kind: 'docx' } }]) {
      mockReadFile.mockResolvedValue(JSON.stringify({ larkTargets }));
      await expect(loadConfig()).rejects.toThrow('INVALID_CONFIG');
    }
  });

  it('validates CLI settings and refuses credential fields in plugin storage', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify({ lark: {} }));
    expect((await loadConfig()).lark).toEqual({
      executable: 'lark-cli', profile: '', identity: 'user', timeoutMs: 30000,
    });
    for (const lark of [null, { appSecret: 'private' }, { executable: 'lark-cli --help' },
      { identity: 'auto' }, { timeoutMs: 120001 }, { profile: 'bad profile' }]) {
      mockReadFile.mockResolvedValue(JSON.stringify({ lark }));
      await expect(loadConfig()).rejects.toThrow('INVALID_CONFIG');
    }
  });
  it('validates the shared subagent limit and defaults an existing delegation to three', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify({ ai: { delegation: {} } }));
    expect((await loadConfig()).ai.delegation.maxConcurrency).toBe(3);
    for (const maxConcurrency of [0, 17, 1.5, '3']) {
      mockReadFile.mockResolvedValue(JSON.stringify({ ai: { delegation: { maxConcurrency } } }));
      await expect(loadConfig()).rejects.toThrow('INVALID_CONFIG');
    }
  });
  it('defaults daily conversation import off and rejects a non-boolean opt-in', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify({}));
    expect((await loadConfig()).knowledgeV2.dailyImportConversations).toBe(false);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ knowledgeV2: { dailyImportConversations: 'yes' } }),
    );
    await expect(loadConfig()).rejects.toThrow('INVALID_CONFIG');
    mockReadFile.mockResolvedValue(
      JSON.stringify({ knowledgeV2: { dailyImportConversations: true } }),
    );
    expect((await loadConfig()).knowledgeV2.dailyImportConversations).toBe(true);
  });
  it.each([
    { knowledgeV2: { autoManage: 'yes' } },
    { knowledgeV2: { dailyUpdateEnabled: 'yes' } },
    { knowledgeV2: { dailyUpdateTime: '24:00' } },
    { knowledgeV2: { dailyUpdateTime: '9:30' } },
    { enhancements: { maxConcurrentJobs: 0 } },
    { enhancements: { maxConcurrentJobs: 9 } },
  ])('rejects invalid automation settings %j', async (config) => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(config));
    await expect(loadConfig()).rejects.toThrow('INVALID_CONFIG');
  });
  it('drops the obsolete wiki section instead of migrating it', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ wiki: { autoManage: true, dailyUpdateTime: '02:00' } }),
    );
    expect((await loadConfig()).wiki).toBeUndefined();
  });
  it('retains explicit empty skill bindings in both prompt protocols',async()=>{
    mockExistsSync.mockReturnValue(true);mockReadFile.mockResolvedValue(JSON.stringify({ai:{skillBindings:{writing:null},syncV2:{contractVersion:2,skillBindings:{'phased-merge-design':null}}}}));
    const config=await loadConfig();expect(config.ai.skillBindings.writing).toBeNull();expect(config.ai.syncV2.skillBindings['phased-merge-design']).toBeNull();
  });
  it('leaves the analysis page limit automatic unless explicitly configured', async () => {
    mockExistsSync.mockReturnValue(true);mockReadFile.mockResolvedValue(JSON.stringify({sync:{baseBranch:'main'}}));
    expect((await loadConfig()).sync.maxAnalysisReadPages).toBeUndefined();
    mockReadFile.mockResolvedValue(JSON.stringify({sync:{maxAnalysisReadPages:24}}));
    expect((await loadConfig()).sync.maxAnalysisReadPages).toBe(24);
  });
  it.each([{ maxAnalysisReadPages: 0 }, { maxAnalysisReadPages: 1025 }, { maxCompletionReminders: 6 }, {maxInvalidOutputWrites:0}, {maxInvalidOutputWrites:21}])('rejects invalid sync execution limits %j', async sync => {
    mockExistsSync.mockReturnValue(true); mockReadFile.mockResolvedValue(JSON.stringify({ sync }));
    await expect(loadConfig()).rejects.toThrow('INVALID_CONFIG');
  });
  it.each([{retainedVersions:0},{versionRetentionDays:0},{missingRetentionDays:-1},{retainedJobs:0},{jobRetentionDays:0},{graceHours:-1}])('rejects invalid conversation cleanup policy %j',async conversations=>{
    mockExistsSync.mockReturnValue(true);mockReadFile.mockResolvedValue(JSON.stringify({conversations}));await expect(loadConfig()).rejects.toThrow('INVALID_CONFIG');
  });
  it('should return default config when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const config = await loadConfig();
    expect(config).toEqual({
      general: { timeZone: 'Asia/Shanghai', taskTimeoutMs: 1200000, knowledgeMaxInputBytes: 2000000, knowledgeMaxResultBytes: 250000 },
      docsDir: 'docs',
      workspaceId: null,
      developerName: null,
      requirementId: null,
      knowledgeV2: {
        autoManage: false,
        autoManageDelayMs: 30000,
        dailyImportConversations: false,
        dailyUpdateEnabled: false,
        dailyUpdateTime: '02:00',
      },
    });
  });

  it('should load config from file', async () => {
    const saved = { docsDir: 'custom-docs', workspaceId: 'ws1' };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(saved));

    const config = await loadConfig();
    expect(config).toMatchObject(saved);
  });

  it('reports a corrupt config rather than resetting user settings', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('not valid json');

    await expect(loadConfig()).rejects.toThrow();
  });

  it('reports unreadable configuration', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockRejectedValue(new Error('EACCES'));

    await expect(loadConfig()).rejects.toThrow();
  });

  it('migrates legacy settings once into profile storage without writing the source', async () => {
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mockReadFile.mockResolvedValue(JSON.stringify({ docsDir: 'requirements', ai: { selectedModel: 'saved-model' } }));
    const config = await loadConfig();
    expect(config.docsDir).toBe('requirements'); expect(config.ai.selectedModel).toBe('saved-model');
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const legacy = mockReadFile.mock.calls[0][0], migrated = mockWriteFile.mock.calls[0][0];
    expect(migrated).not.toBe(legacy);
    expect(migrated).toContain('req-hub');
    mockExistsSync.mockReturnValue(true); await loadConfig();
    expect(mockWriteFile).toHaveBeenCalledOnce();
  });
});

describe('saveConfig', () => {
  it('should write config to file', async () => {
    const config = { docsDir: 'docs', workspaceId: 'ws1' };
    await saveConfig(config);

    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(JSON.parse(mockWriteFile.mock.calls[0][1])).toEqual(config);
    expect(mockWriteFile.mock.calls[0][0]).toMatch(/config\.json\..+\.tmp$/);
  });
});

describe('autoDefaultConfig', () => {
  it('should return config unchanged when no workspaces', async () => {
    const registry = { list: () => [] };
    const config = { docsDir: 'docs' };
    const result = await autoDefaultConfig(config, registry);
    expect(result).toEqual(config);
  });

  it('should auto-select first workspace', async () => {
    const registry = {
      list: () => [{ id: 'ws1', path: '/project' }],
    };
    const config = { docsDir: 'docs' };

    mockReaddir.mockResolvedValue([]);
    const result = await autoDefaultConfig(config, registry);
    expect(result.workspaceId).toBe('ws1');
  });

  it('should auto-select first developer', async () => {
    const registry = {
      list: () => [{ id: 'ws1', path: '/project' }],
    };
    const config = { docsDir: 'docs', workspaceId: 'ws1' };

    mockReaddir.mockResolvedValueOnce([
      { name: 'alice', isDirectory: () => true },
      { name: 'bob', isDirectory: () => true },
    ]);
    mockReaddir.mockResolvedValueOnce([]);

    const result = await autoDefaultConfig(config, registry);
    expect(result.developerName).toBe('alice');
  });

  it('should auto-select first requirement', async () => {
    const registry = {
      list: () => [{ id: 'ws1', path: '/project' }],
    };
    const config = { docsDir: 'docs', workspaceId: 'ws1', developerName: 'alice' };

    // First call: list developer dirs
    mockReaddir.mockResolvedValueOnce([
      { name: 'alice', isDirectory: () => true },
    ]);
    // Second call: list requirement dirs
    mockReaddir.mockResolvedValueOnce([
      { name: '2024-01-15-feature', isDirectory: () => true },
    ]);

    const result = await autoDefaultConfig(config, registry);
    expect(result.requirementId).toBe('2024-01-15-feature');
  });

  it('should not override existing developerName', async () => {
    const registry = {
      list: () => [{ id: 'ws1', path: '/project' }],
    };
    const config = { docsDir: 'docs', workspaceId: 'ws1', developerName: 'bob' };

    mockReaddir.mockResolvedValueOnce([
      { name: 'alice', isDirectory: () => true },
    ]);
    mockReaddir.mockResolvedValueOnce([]);

    const result = await autoDefaultConfig(config, registry);
    expect(result.developerName).toBe('bob');
  });

  it('should handle readdir errors gracefully', async () => {
    const registry = {
      list: () => [{ id: 'ws1', path: '/project' }],
    };
    const config = { docsDir: 'docs', workspaceId: 'ws1' };

    mockReaddir.mockRejectedValue(new Error('ENOENT'));

    const result = await autoDefaultConfig(config, registry);
    expect(result.workspaceId).toBe('ws1');
    // Should not throw
  });
});


it.each([
  { defaultUsername: '../alice' }, { defaultUsername: 'alice/bob' },
  { defaultUsername: 'a*' }, { sync: { dailyOffsetDays: -1 } },
  { sync: { dailyOffsetDays: 1.5 } }, { sync: { dailyOffsetDays: 366 } },
  { sync: { dailyUpdateTime: '24:00' } }, { general: { timeZone: 'Invalid/Zone' } },
  { sync: { dailyUpdateEnabled: 'yes' } },
])('rejects invalid daily sync configuration %j', async (value) => {
  mockExistsSync.mockReturnValue(true);
  mockReadFile.mockResolvedValue(JSON.stringify(value));
  await expect(loadConfig()).rejects.toThrow('INVALID_CONFIG');
});
