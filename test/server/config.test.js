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
    expect(config).toEqual(saved);
  });

  it('should return default config on parse error', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('not valid json');

    const config = await loadConfig();
    expect(config.docsDir).toBe('docs');
  });

  it('should return default config on read error', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockRejectedValue(new Error('EACCES'));

    const config = await loadConfig();
    expect(config.docsDir).toBe('docs');
  });
});

describe('saveConfig', () => {
  it('should write config to file', async () => {
    const config = { docsDir: 'docs', workspaceId: 'ws1' };
    await saveConfig(config);

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify(config, null, 2),
      'utf8',
    );
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
