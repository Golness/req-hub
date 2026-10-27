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

describe('loadConfig', () => {
  it('leaves the analysis page limit automatic unless explicitly configured', async () => {
    mockExistsSync.mockReturnValue(true);mockReadFile.mockResolvedValue(JSON.stringify({sync:{baseBranch:'main'}}));
    expect((await loadConfig()).sync.maxAnalysisReadPages).toBeUndefined();
    mockReadFile.mockResolvedValue(JSON.stringify({sync:{maxAnalysisReadPages:24}}));
    expect((await loadConfig()).sync.maxAnalysisReadPages).toBe(24);
  });
  it.each([{ maxAnalysisReadPages: 0 }, { maxAnalysisReadPages: 129 }, { maxCompletionReminders: 6 }, {maxInvalidOutputWrites:0}, {maxInvalidOutputWrites:21}])('rejects invalid sync execution limits %j', async sync => {
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
      docsDir: 'docs',
      workspaceId: null,
      developerName: null,
      requirementId: null,
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
