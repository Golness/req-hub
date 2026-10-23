import { withDocumentLock } from '../sync-document-validator.js';
/**
 * Document tree routes module.
 * Handles document tree and workspace-related HTTP endpoints.
 * @module routes/tree-routes
 */

import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { buildTree, countRequirements, findRequirementPath } from '../tree.js';
import { walkDocs, isInside, json, readBody } from '../utils.js';
import { getCached, setCached } from '../cache.js';
import { log } from '../logger.js';
import { SUPPORTED_DOC_EXTS } from '../tree.js';
import { rebuildIndex, loadIndex } from '../index-manager.js';

/**
 * Create document tree routes.
 * @param {Object} registry - Workspace registry service
 * @returns {Array<Object>} Array of route definitions
 */
export function createTreeRoutes(registry) {
  return [
    // GET /workspaces - 获取工作区列表
    {
      kind: 'exact',
      path: '/req-hub/workspaces',
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const workspaces = registry.list();
        const items = workspaces.map(w => ({
          id: w.id,
          title: w.title || w.id,
          path: w.path
        }));
        json(res, items);
      }
    },

    // POST /rebuild-index - 重建搜索索引
    {
      kind: 'exact',
      path: '/req-hub/rebuild-index',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const body = await readBody(req);
          const { workspaceId } = JSON.parse(body);

          if (!workspaceId) {
            json(res, { error: 'missing workspaceId' }, 400);
            return;
          }

          const workspaces = registry.list();
          const workspace = workspaces.find(w => w.id === workspaceId);
          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir);
          const tree = await buildTree(docsRoot);

          const startTime = Date.now();
          await rebuildIndex(docsRoot, tree);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          log.index.info(`索引重建完成 (${elapsed}s)`);
          json(res, { success: true, elapsed });
        } catch (e) {
          log.index.error(`索引重建失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    },

    // GET /index-status - 获取索引状态
    {
      kind: 'exact',
      path: '/req-hub/index-status',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const url = new URL(req.url, 'http://localhost');
          const workspaceId = url.searchParams.get('workspaceId');

          if (!workspaceId) {
            json(res, { built: false });
            return;
          }

          const workspaces = registry.list();
          const workspace = workspaces.find(w => w.id === workspaceId);
          if (!workspace) {
            json(res, { built: false });
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir || 'docs');
          const index = await loadIndex(docsRoot);

          if (!index) {
            json(res, { built: false });
            return;
          }

          json(res, {
            built: true,
            builtAt: index.builtAt,
            stats: {
              requirements: (index.requirements || []).length,
              features: Object.keys(index.featureIndex || {}).length,
              fields: Object.keys(index.fieldIndex || {}).length,
              tags: Object.keys(index.tagIndex || {}).length,
            },
          });
        } catch (e) {
          log.index.error(`获取索引状态失败: ${e.message}`);
          json(res, { built: false });
        }
      }
    },

    // GET /index-data - 获取索引详情
    {
      kind: 'exact',
      path: '/req-hub/index-data',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const url = new URL(req.url, 'http://localhost');
          const workspaceId = url.searchParams.get('workspaceId');

          if (!workspaceId) {
            json(res, { error: 'missing workspaceId' }, 400);
            return;
          }

          const workspaces = registry.list();
          const workspace = workspaces.find(w => w.id === workspaceId);
          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir);
          
          const index = await loadIndex(docsRoot);
          if (!index) {
            json(res, { error: '索引文件不存在，请先重建索引' }, 404);
            return;
          }

          json(res, index);
        } catch (e) {
          log.index.error(`读取索引失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    },

    // POST /open-in-explorer - 在文件资源管理器中打开目录
    {
      kind: 'exact',
      path: '/req-hub/open-in-explorer',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const body = await readBody(req);
          const { workspaceId, requirementId } = JSON.parse(body);

          if (!workspaceId || !requirementId) {
            json(res, { error: 'missing workspaceId or requirementId' }, 400);
            return;
          }

          const workspaces = registry.list();
          const workspace = workspaces.find(w => w.id === workspaceId);
          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir);
          const tree = await buildTree(docsRoot);

          // 查找需求目录路径
          const reqPath = findRequirementPath(docsRoot, tree, requirementId);
          if (!reqPath) {
            json(res, { error: 'requirement not found' }, 404);
            return;
          }

          const fullPath = reqPath.path;

          // 使用 spawn 打开文件资源管理器（不等待进程结束）
          const { spawn } = await import('child_process');

          let command, args;
          if (process.platform === 'win32') {
            command = 'explorer';
            args = [fullPath];
          } else if (process.platform === 'darwin') {
            command = 'open';
            args = [fullPath];
          } else {
            command = 'xdg-open';
            args = [fullPath];
          }

          try {
            const child = spawn(command, args, {
              detached: true,
              stdio: 'ignore'
            });
            child.unref();
            json(res, { success: true, path: fullPath });
          } catch (e) {
            log.tree.error(`打开文件资源管理器失败: ${e.message}`);
            json(res, { error: e.message }, 500);
          }
        } catch (e) {
          log.tree.error(`打开文件资源管理器失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    },

    // GET /stats - 获取统计信息
    {
      kind: 'exact',
      path: '/req-hub/stats',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const config = await loadConfig();
          const cacheKey = `all-workspaces:${config.docsDir}`;
          const cached = getCached(cacheKey);
          
          if (cached) {
            json(res, cached);
            return;
          }

          const workspaces = registry.list();
          const stats = [];

          for (const w of workspaces) {
            const docsRoot = resolve(w.path, config.docsDir);
            let docCount = 0;
            let exists = false;

            try {
              const info = await stat(docsRoot);
              if (info.isDirectory()) {
                exists = true;
                for (const ext of SUPPORTED_DOC_EXTS) {
                  const items = await walkDocs(docsRoot, ext);
                  docCount += items.length;
                }
              }
            } catch { /* ignore */ }

            stats.push({
              workspaceId: w.id,
              title: w.title || w.id,
              docCount,
              exists
            });
          }

          setCached(cacheKey, stats);
          json(res, stats);
        } catch (e) {
          log.tree.error(`获取统计信息失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    },

    // GET /list - 列出文档
    {
      kind: 'exact',
      path: '/req-hub/list',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const ext = url.searchParams.get('ext') || '.md';

        if (!workspaceId) {
          json(res, { error: 'missing workspaceId' }, 400);
          return;
        }

        if (!SUPPORTED_DOC_EXTS.includes(ext)) {
          json(res, { error: `ext must be one of: ${SUPPORTED_DOC_EXTS.join(', ')}` }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find(w => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);

        try {
          await stat(docsRoot);
        } catch {
          json(res, { items: [], docsRoot, exists: false });
          return;
        }

        const items = await walkDocs(docsRoot, ext);
        json(res, { items, docsRoot, exists: true, workspace: workspace.id });
      }
    },

    // GET /tree - 获取文档树
    {
      kind: 'exact',
      path: '/req-hub/tree',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');

        if (!workspaceId) {
          json(res, { error: 'missing workspaceId' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find(w => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);

        try {
          await stat(docsRoot);
        } catch {
          json(res, { tree: { developers: [] }, totalRequirements: 0, docsDir: config.docsDir, exists: false });
          return;
        }

        const tree = await buildTree(docsRoot);
        const totalRequirements = countRequirements(tree);

        json(res, { tree, totalRequirements, docsDir: config.docsDir, exists: true });
      }
    },

    // GET /read - 读取文件内容
    {
      kind: 'exact',
      path: '/req-hub/read',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const path = url.searchParams.get('path');

        if (!workspaceId || !path) {
          json(res, { error: 'missing workspaceId or path' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find(w => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);
        const fullPath = resolve(docsRoot, path);

        if (!isInside(docsRoot, fullPath)) {
          json(res, { error: 'path outside docs root' }, 400);
          return;
        }

        try {
          const info = await stat(fullPath);
          if (!info.isFile()) {
            json(res, { error: 'not a file' }, 400);
            return;
          }

          const { readFile } = await import('node:fs/promises');
          const text = await readFile(fullPath, 'utf-8');
          json(res, { text, path: relative(docsRoot, fullPath) });
        } catch (e) {
          json(res, { error: e.message }, 500);
        }
      }
    },

    // POST /write - 写入/更新文件内容
    {
      kind: 'exact',
      path: '/req-hub/write',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const raw = await readBody(req);
          const { workspaceId, path: filePath, content } = JSON.parse(raw);

          // 参数校验
          if (!workspaceId || !filePath || content === undefined) {
            json(res, { error: 'missing workspaceId, path or content' }, 400);
            return;
          }

          // 文件类型限制
          const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
          const allowedExts = ['.md', '.txt', '.text', '.json'];
          if (!allowedExts.includes(ext)) {
            json(res, { error: `文件类型 ${ext} 不支持编辑` }, 400);
            return;
          }

          // 内容大小限制 (10MB)
          if (content.length > 10 * 1024 * 1024) {
            json(res, { error: '文件内容超过 10MB 限制' }, 400);
            return;
          }

          // 工作区校验
          const workspaces = registry.list();
          const workspace = workspaces.find(w => w.id === workspaceId);
          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          // 路径解析 + 安全校验
          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir);
          const fullPath = resolve(docsRoot, filePath);

          if (!isInside(docsRoot, fullPath)) {
            json(res, { error: 'path outside docs root' }, 403);
            return;
          }

          // 写入文件
          await withDocumentLock(fullPath, () => writeFile(fullPath, content, 'utf8'));

          // 获取修改时间
          const fileStat = await stat(fullPath);

          json(res, { success: true, mtime: fileStat.mtime.toISOString() });
        } catch (e) {
          log.tree.error(`文件写入失败: ${e.message}`);
          json(res, { success: false, error: e.message }, 500);
        }
      }
    },

    // GET /requirements/:id - 获取需求详情
    {
      kind: 'prefix',
      path: '/req-hub/requirements/',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const reqId = decodeURIComponent(url.pathname.slice('/req-hub/requirements/'.length));

        if (!workspaceId || !reqId) {
          json(res, { error: 'missing workspaceId or requirement id' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find(w => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);
        const tree = await buildTree(docsRoot);
        const found = findRequirementPath(docsRoot, tree, reqId);

        if (!found) {
          json(res, { error: 'requirement not found' }, 404);
          return;
        }

        json(res, found);
      }
    },

    // POST /create-dir - 创建需求目录（可选同时新建 Git 分支）
    {
      kind: 'exact',
      path: '/req-hub/create-dir',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }

        try {
          const raw = await readBody(req);
          const { workspaceId, developer, date, title, createBranch, branchName } = JSON.parse(raw);

          if (!workspaceId || !developer || !date || !title) {
            json(res, { error: 'missing required fields: workspaceId, developer, date, title' }, 400);
            return;
          }

          if (/[\\/]/.test(developer) || developer.startsWith('.')) {
            json(res, { error: 'invalid developer name' }, 400);
            return;
          }

          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            json(res, { error: 'date must be YYYY-MM-DD format' }, 400);
            return;
          }

          const workspaces = registry.list();
          const workspace = workspaces.find(w => w.id === workspaceId);
          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          // ── 新建 Git 分支（在创建目录之前）──
          let branchResult = null;
          if (createBranch && branchName) {
            // 校验分支名格式（允许字母、数字、中文、点、横线、下划线和斜杠）
            if (!/^[a-zA-Z0-9一-龥][a-zA-Z0-9一-龥._/\-]*$/.test(branchName)) {
              json(res, { error: 'invalid branch name: only letters, digits, Chinese characters, dots, dashes, underscores and / are allowed' }, 400);
              return;
            }

            const { exec } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execAsync = promisify(exec);

            try {
              // 检查分支是否已存在
              const { stdout: existing } = await execAsync(`git branch --list "${branchName}"`, { cwd: workspace.path });
              if (existing.trim()) {
                json(res, { error: `分支 "${branchName}" 已存在` }, 409);
                return;
              }

              // 获取当前分支名（用于日志）
              const { stdout: currentBranch } = await execAsync('git branch --show-current', { cwd: workspace.path });
              const fromBranch = currentBranch.trim();

              // 创建新分支（不切换，保留未提交的修改在当前工作区）
              // git branch <name> 基于当前 HEAD 创建分支，不改变工作区
              await execAsync(`git branch "${branchName}"`, { cwd: workspace.path });

              // 切换到新分支（git checkout -b 的等效操作：保留未提交修改）
              await execAsync(`git checkout "${branchName}"`, { cwd: workspace.path });

              log.tree.info(`新建分支: ${branchName} (from ${fromBranch})`);
              branchResult = {
                created: true,
                branchName,
                fromBranch,
              };
            } catch (gitErr) {
              log.tree.error(`新建分支失败: ${gitErr.message}`);
              json(res, { error: `Git 操作失败: ${gitErr.stderr || gitErr.message}` }, 500);
              return;
            }
          }

          // ── 创建需求目录 ──
          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir);
          const dirName = `${date}-${title}`;
          const targetPath = join(docsRoot, developer, dirName);

          if (!isInside(docsRoot, targetPath)) {
            json(res, { error: 'path outside docs' }, 400);
            return;
          }

          if (existsSync(targetPath)) {
            json(res, { error: 'directory already exists' }, 409);
            return;
          }

          await mkdir(targetPath, { recursive: true });
          log.tree.info(`创建目录: ${developer}/${dirName}`);
          json(res, {
            success: true,
            path: relative(docsRoot, targetPath),
            fullPath: targetPath,
            branch: branchResult,
          });
        } catch (e) {
          log.tree.error(`创建目录失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    },

    // GET /fields/:field - 按字段名查找关联需求
    {
      kind: 'prefix',
      path: '/req-hub/fields/',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const fieldName = decodeURIComponent(url.pathname.slice('/req-hub/fields/'.length));

        if (!workspaceId || !fieldName) {
          json(res, { error: 'missing workspaceId or field name' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find(w => w.id === workspaceId);
        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);

        // Load search index
        const { loadIndex } = await import('../index-manager.js');
        const index = await loadIndex(docsRoot);

        if (!index) {
          json(res, { field: fieldName, associations: [], indexBuilt: false });
          return;
        }

        // Find the field in fieldIndex (case-insensitive match)
        const matchedKeys = Object.keys(index.fieldIndex || {}).filter(
          k => k.toLowerCase() === fieldName.toLowerCase() || k.toLowerCase().includes(fieldName.toLowerCase())
        );

        const associatedReqIds = new Set();
        for (const key of matchedKeys) {
          for (const id of index.fieldIndex[key]) {
            associatedReqIds.add(id);
          }
        }

        // Build association details
        const associations = [];
        for (const r of index.requirements || []) {
          if (!associatedReqIds.has(r.id)) continue;
          const matchedFields = (r.fields || []).filter(f =>
            matchedKeys.some(k => k.toLowerCase() === f.toLowerCase())
          );
          associations.push({
            id: r.id,
            developer: r.developer,
            date: r.date,
            title: r.title,
            type: r.type,
            summary: r.summary,
            matchedFields,
            changeDescription: r.summary || '',
          });
        }

        // Sort by date descending
        associations.sort((a, b) => b.date.localeCompare(a.date));

        json(res, {
          field: fieldName,
          matchedKeys,
          associations,
          total: associations.length,
          indexBuilt: true,
        });
      }
    },

    // GET /file-tree - 获取需求目录下的嵌套文件树
    {
      kind: 'exact',
      path: '/req-hub/file-tree',
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }

        const url = new URL(req.url, 'http://localhost');
        const workspaceId = url.searchParams.get('workspaceId');
        const requirementId = url.searchParams.get('requirementId');
        const requirementPath = url.searchParams.get('requirementPath')?.replaceAll('\\', '/');

        if (!workspaceId || !requirementId) {
          json(res, { error: 'missing workspaceId or requirementId' }, 400);
          return;
        }

        const workspaces = registry.list();
        const workspace = workspaces.find(w => w.id === workspaceId);
        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);
        const tree = await buildTree(docsRoot);

        // Find the requirement
        let reqPath = null;
        for (const dev of tree.developers) {
          for (const req of dev.requirements) {
            if (req.id === requirementId && (!requirementPath || req.path.replaceAll('\\', '/') === requirementPath)) {
              reqPath = resolve(docsRoot, req.path);
              break;
            }
          }
          if (reqPath) break;
        }

        if (!reqPath) {
          json(res, { error: 'requirement not found' }, 404);
          return;
        }

        // Supported file extensions
        const supportedExts = ['.md', '.txt', '.text', '.html', '.htm', '.json'];

        // Recursive function to build tree structure
        const buildFileTree = async (dirPath, relativePath = '') => {
          const result = [];
          let entries;
          try {
            entries = await readdir(dirPath, { withFileTypes: true });
          } catch {
            return result;
          }

          // Sort: directories first, then files
          entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

          for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);
            const relPath = relativePath ? join(relativePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
              // Skip hidden directories only
              if (entry.name.startsWith('.')) continue;
              
              const children = await buildFileTree(fullPath, relPath);
              // Always show directories, even if empty
              result.push({
                type: 'directory',
                name: entry.name,
                path: relPath,
                children
              });
            } else if (entry.isFile()) {
              // Check if file has supported extension
              const ext = entry.name.toLowerCase().match(/\.[^.]+$/)?.[0];
              if (ext && supportedExts.includes(ext)) {
                try {
                  const stats = await stat(fullPath);
                  result.push({
                    type: 'file',
                    name: entry.name,
                    path: relPath,
                    mtime: stats.mtime.toISOString(),
                    size: stats.size
                  });
                } catch {
                  result.push({
                    type: 'file',
                    name: entry.name,
                    path: relPath,
                    mtime: null,
                    size: null
                  });
                }
              }
            }
          }

          return result;
        };

        try {
          const fileTree = await buildFileTree(reqPath);
          json(res, { tree: fileTree });
        } catch (e) {
          log.tree.error(`获取文件树失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      }
    }
  ];
}
