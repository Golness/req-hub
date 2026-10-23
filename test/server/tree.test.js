/**
 * 文档树构建模块测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs
const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();

vi.mock('node:fs/promises', () => ({
  readdir: (...args) => mockReaddir(...args),
  stat: (...args) => mockStat(...args),
  readFile: (...args) => mockReadFile(...args),
}));

const { buildTree, countRequirements, findRequirementPath, SUPPORTED_DOC_EXTS } = await import('../../src/server/tree.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SUPPORTED_DOC_EXTS', () => {
  it('should include common doc extensions', () => {
    expect(SUPPORTED_DOC_EXTS).toContain('.md');
    expect(SUPPORTED_DOC_EXTS).toContain('.html');
    expect(SUPPORTED_DOC_EXTS).toContain('.txt');
  });
});

describe('buildTree', () => {
  it('should return empty tree when docsDir cannot be read', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    const tree = await buildTree('/nonexistent');
    expect(tree).toEqual({ developers: [] });
  });

  it('should skip non-directory entries', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'file.txt', isDirectory: () => false },
    ]);
    const tree = await buildTree('/docs');
    expect(tree.developers).toEqual([]);
  });

  it('should skip hidden directories', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: '.hidden', isDirectory: () => true },
    ]);
    const tree = await buildTree('/docs');
    expect(tree.developers).toEqual([]);
  });

  it('should build tree with developers and requirements', async () => {
    // First call: list developer dirs
    mockReaddir.mockResolvedValueOnce([
      { name: 'alice', isDirectory: () => true },
    ]);

    // Second call: list requirement dirs for alice
    mockReaddir.mockResolvedValueOnce([
      { name: '2024-01-15-user-auth', isDirectory: () => true },
    ]);

    // Third call: list files in requirement dir
    mockReaddir.mockResolvedValueOnce(['prd.md', 'design.md']);

    // stat calls for files
    mockStat.mockResolvedValue({ mtime: new Date('2024-01-20') });

    const tree = await buildTree('/docs');

    expect(tree.developers.length).toBe(1);
    expect(tree.developers[0].name).toBe('alice');
    expect(tree.developers[0].requirementCount).toBe(1);
    expect(tree.developers[0].requirements[0].id).toBe('2024-01-15-user-auth');
    expect(tree.developers[0].requirements[0].date).toBe('2024-01-15');
    expect(tree.developers[0].requirements[0].title).toBe('user-auth');
    expect(tree.developers[0].requirements[0].fileCount).toBe(2);
  });

  it('should skip non-requirement directories', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'bob', isDirectory: () => true },
    ]);
    mockReaddir.mockResolvedValueOnce([
      { name: 'not-a-req-dir', isDirectory: () => true },
    ]);

    const tree = await buildTree('/docs');
    expect(tree.developers[0].requirementCount).toBe(0);
  });

  it('should handle .meta.json file', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'charlie', isDirectory: () => true },
    ]);
    mockReaddir.mockResolvedValueOnce([
      { name: '2024-03-01-feature-x', isDirectory: () => true },
    ]);
    mockReaddir.mockResolvedValueOnce(['doc.md', '.meta.json']);

    mockStat.mockResolvedValue({ mtime: new Date('2024-03-05') });
    mockReadFile.mockResolvedValue(JSON.stringify({ summary: 'test', type: 'feature' }));

    const tree = await buildTree('/docs');
    const req = tree.developers[0].requirements[0];
    expect(req.hasMeta).toBe(true);
    expect(req.meta).toEqual({ summary: 'test', type: 'feature' });
  });

  it('should sort developers by name', async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: 'zara', isDirectory: () => true },
      { name: 'alice', isDirectory: () => true },
    ]);
    mockReaddir.mockResolvedValue([]);

    const tree = await buildTree('/docs');
    expect(tree.developers[0].name).toBe('alice');
    expect(tree.developers[1].name).toBe('zara');
  });
});

describe('countRequirements', () => {
  it('should count total requirements across developers', () => {
    const tree = {
      developers: [
        { name: 'a', requirementCount: 3, requirements: [] },
        { name: 'b', requirementCount: 2, requirements: [] },
      ],
    };
    expect(countRequirements(tree)).toBe(5);
  });

  it('should return 0 for empty tree', () => {
    expect(countRequirements({ developers: [] })).toBe(0);
  });
});

describe('findRequirementPath', () => {
  it('should find requirement by id', () => {
    const tree = {
      developers: [{
        name: 'dev',
        requirements: [{
          id: '2024-01-01-test',
          path: 'dev/2024-01-01-test',
        }],
      }],
    };
    const result = findRequirementPath('/docs', tree, '2024-01-01-test');
    expect(result).not.toBeNull();
    expect(result.req.id).toBe('2024-01-01-test');
  });

  it('should return null for unknown id', () => {
    const tree = { developers: [] };
    expect(findRequirementPath('/docs', tree, 'unknown')).toBeNull();
  });
});
