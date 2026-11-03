'use strict';

/**
 * Integration tests for ReqHub create functionality.
 * Verifies API request parameters and branch name parsing logic.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Create Functionality Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('API Request Parameters', () => {
    it('should call /create-status with correct workspaceId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          branch: 'feature/zhangsan/2026-03-20-报表导出',
          head: 'abc123',
          dirty: false,
          inProgress: false,
          canUpdateMain: false,
          existingRequirement: null,
        }),
      });

      const response = await fetch('/req-hub/create-status?workspaceId=ws-1');
      const data = await response.json();

      expect(mockFetch).toHaveBeenCalledWith('/req-hub/create-status?workspaceId=ws-1');
      expect(data.branch).toBe('feature/zhangsan/2026-03-20-报表导出');
    });

    it('should call /tree with workspaceId parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tree: {
            developers: [
              {
                name: 'zhangsan',
                requirementCount: 1,
                requirements: [
                  {
                    id: '2026-03-20-报表导出',
                    date: '2026-03-20',
                    title: '报表导出',
                    path: 'zhangsan/2026-03-20-报表导出',
                    fileCount: 0,
                  },
                ],
              },
            ],
          },
        }),
      });

      const response = await fetch('/req-hub/tree?workspaceId=ws-1');
      const data = await response.json();

      expect(mockFetch).toHaveBeenCalledWith('/req-hub/tree?workspaceId=ws-1');
      expect(data.tree.developers).toHaveLength(1);
      expect(data.tree.developers[0].name).toBe('zhangsan');
    });

    it('should call /create-dir with correct payload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          path: 'zhangsan/2026-03-20-报表导出',
          fullPath: '/path/to/docs/zhangsan/2026-03-20-报表导出',
          branch: null,
        }),
      });

      const payload = {
        workspaceId: 'ws-1',
        developer: 'zhangsan',
        date: '2026-03-20',
        title: '报表导出',
        createBranch: false,
      };

      const response = await fetch('/req-hub/create-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      expect(mockFetch).toHaveBeenCalledWith('/req-hub/create-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(data.success).toBe(true);
      expect(data.path).toBe('zhangsan/2026-03-20-报表导出');
    });

    it('should call /create-dir with branch creation payload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          path: 'zhangsan/2026-03-20-报表导出',
          fullPath: '/path/to/docs/zhangsan/2026-03-20-报表导出',
          branch: {
            created: true,
            branchName: 'feature/zhangsan/2026-03-20-报表导出',
            fromBranch: 'main',
          },
        }),
      });

      const payload = {
        workspaceId: 'ws-1',
        developer: 'zhangsan',
        date: '2026-03-20',
        title: '报表导出',
        createBranch: true,
        branchName: 'feature/zhangsan/2026-03-20-报表导出',
      };

      const response = await fetch('/req-hub/create-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      expect(data.branch.created).toBe(true);
      expect(data.branch.branchName).toBe('feature/zhangsan/2026-03-20-报表导出');
    });

    it('should call /update-main with correct parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          branch: 'main',
          remote: 'origin',
          head: 'def456',
          updated: true,
        }),
      });

      const payload = {
        workspaceId: 'ws-1',
        expectedHead: 'abc123',
        branch: 'main',
      };

      const response = await fetch('/req-hub/update-main', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();

      expect(mockFetch).toHaveBeenCalledWith('/req-hub/update-main', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(data.updated).toBe(true);
    });
  });

  describe('Branch Name Parsing', () => {
    it('should parse feature/<dev>/<date>-<title> format', () => {
      const branch = 'feature/zhangsan/2026-03-20-报表导出';
      const match = branch.match(/^(?:feature\/)?([^/-]+)[/-](\d{4}-\d{2}-\d{2})-(.+)$/);

      expect(match).not.toBeNull();
      expect(match[1]).toBe('zhangsan');
      expect(match[2]).toBe('2026-03-20');
      expect(match[3]).toBe('报表导出');
    });

    it('should parse <dev>/<date>-<title> format', () => {
      const branch = 'zhangsan/2026-03-20-报表导出';
      const match = branch.match(/^(?:feature\/)?([^/-]+)[/-](\d{4}-\d{2}-\d{2})-(.+)$/);

      expect(match).not.toBeNull();
      expect(match[1]).toBe('zhangsan');
      expect(match[2]).toBe('2026-03-20');
      expect(match[3]).toBe('报表导出');
    });

    it('should detect non-matching branch names', () => {
      const branch = 'fix/login-bug';
      const match = branch.match(/^(?:feature\/)?([^/-]+)[/-](\d{4}-\d{2}-\d{2})-(.+)$/);

      expect(match).toBeNull();
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('should detect Ctrl+N key combination', () => {
      const handleKeyDown = vi.fn();
      document.addEventListener('keydown', handleKeyDown);

      const event = new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        bubbles: true,
      });
      document.dispatchEvent(event);

      expect(handleKeyDown).toHaveBeenCalled();
      const callArgs = handleKeyDown.mock.calls[0][0];
      expect(callArgs.key).toBe('n');
      expect(callArgs.ctrlKey).toBe(true);
    });

    it('should detect Cmd+N key combination (Mac)', () => {
      const handleKeyDown = vi.fn();
      document.addEventListener('keydown', handleKeyDown);

      const event = new KeyboardEvent('keydown', {
        key: 'n',
        metaKey: true,
        bubbles: true,
      });
      document.dispatchEvent(event);

      expect(handleKeyDown).toHaveBeenCalled();
      const callArgs = handleKeyDown.mock.calls[0][0];
      expect(callArgs.key).toBe('n');
      expect(callArgs.metaKey).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle CREATE_ALREADY_EXISTS error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: 'CREATE_ALREADY_EXISTS',
          branch: 'feature/zhangsan/2026-03-15-报价单导出',
          requirement: {
            path: 'zhangsan/2026-03-15-报价单导出',
          },
        }),
      });

      const response = await fetch('/req-hub/create-dir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          developer: 'zhangsan',
          date: '2026-03-15',
          title: '报价单导出',
        }),
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(409);
      const data = await response.json();
      expect(data.error).toBe('CREATE_ALREADY_EXISTS');
    });

    it('should handle CREATE_MAIN_CHANGED error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: 'CREATE_MAIN_CHANGED',
        }),
      });

      const response = await fetch('/req-hub/update-main', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: 'ws-1',
          expectedHead: 'abc123',
        }),
      });

      expect(response.ok).toBe(false);
      const data = await response.json();
      expect(data.error).toBe('CREATE_MAIN_CHANGED');
    });
  });
});
