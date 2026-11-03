import { safeDocumentPath } from '../safe-path.js';
import { withDocumentLock } from '../sync-document-validator.js';
import { creationStatus } from '../creation.js';
/**
 * Document tree routes module.
 * Handles document tree and workspace-related HTTP endpoints.
 * @module routes/tree-routes
 */

import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import {
  buildTree,
  countRequirements,
  countRequirementDirectories,
  findRequirementPath,
} from '../tree.js';
import { walkDocs, isInside, json, readBody } from '../utils.js';
import { log } from '../logger.js';
import { SUPPORTED_DOC_EXTS } from '../tree.js';
import { readSource } from '../knowledge/source-reader.js';

/**
 * Create document tree routes.
 * @param {Object} registry - Workspace registry service
 * @returns {Array<Object>} Array of route definitions
 */
export function createTreeRoutes(registry, options = {}) {
  return [
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
        const items = workspaces.map((w) => ({
          id: w.id,
          title: w.title || w.id,
          path: w.path,
        }));
        json(res, items);
      },
    },

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
          const workspace = workspaces.find((w) => w.id === workspaceId);
          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir);
          const tree = await buildTree(docsRoot);

          const reqPath = findRequirementPath(docsRoot, tree, requirementId);
          if (!reqPath) {
            json(res, { error: 'requirement not found' }, 404);
            return;
          }

          const fullPath = reqPath.path;

          // Launch the file manager without waiting for its window to close.
          const { spawn } = await import('child_process');

          let command;
          let args;
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
              stdio: 'ignore',
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
      },
    },

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
          const workspaces = registry.list();
          const stats = [];

          for (const w of workspaces) {
            let requirementCount = 0;
            let exists = false;
            let errorCode;

            try {
              const info = await stat(w.path);
              if (info.isDirectory()) {
                exists = true;
                const docsRoot = resolve(w.path, config.docsDir);
                if (docsRoot !== resolve(w.path)) {
                  await safeDocumentPath(w.path, config.docsDir, { allowMissing: true });
                }
                requirementCount = await countRequirementDirectories(docsRoot);
              }
            } catch (error) {
              if (error.code !== 'ENOENT' || exists) {
                errorCode = 'REQUIREMENT_STATS_UNAVAILABLE';
              }
            }

            stats.push({
              workspaceId: w.id,
              title: w.title || w.id,
              projectPath: w.path,
              requirementCount: errorCode ? null : requirementCount,
              exists,
              ...(errorCode ? { errorCode } : {}),
            });
          }

          json(res, stats);
        } catch (e) {
          log.tree.error(`获取统计信息失败: ${e.message}`);
          json(res, { error: e.message }, 500);
        }
      },
    },

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
        const workspace = workspaces.find((w) => w.id === workspaceId);

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
      },
    },

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
        const workspace = workspaces.find((w) => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);

        try {
          await stat(docsRoot);
        } catch {
          json(res, {
            tree: { developers: [] },
            totalRequirements: 0,
            docsDir: config.docsDir,
            exists: false,
            caseSensitivePaths: process.platform !== 'win32',
          });
          return;
        }

        const tree = await buildTree(docsRoot);
        const totalRequirements = countRequirements(tree);

        json(res, {
          tree,
          totalRequirements,
          docsDir: config.docsDir,
          exists: true,
          caseSensitivePaths: process.platform !== 'win32',
        });
      },
    },

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
        const workspace = workspaces.find((w) => w.id === workspaceId);

        if (!workspace) {
          json(res, { error: 'workspace not found' }, 404);
          return;
        }

        const config = await loadConfig();
        const docsRoot = resolve(workspace.path, config.docsDir);
        let fullPath;
        try {
          if (docsRoot !== resolve(workspace.path)) {
            await safeDocumentPath(workspace.path, config.docsDir);
          }
          fullPath = await safeDocumentPath(docsRoot, path);
        } catch (error) {
          return json(res, { error: error.message }, error.status || 404);
        }

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

          if (/\.(pdf|docx|xlsx)$/i.test(path)) {
            const source = await readSource(docsRoot, path);
            json(res, {
              text: source.text,
              path: source.relativePath,
              coordinate: source.coordinate,
              locations: source.locations,
              warnings: source.warnings,
            });
            return;
          }
          const { readFile } = await import('node:fs/promises');
          const text = await readFile(fullPath, 'utf-8');
          json(res, { text, path: relative(docsRoot, fullPath) });
        } catch (e) {
          json(res, { error: e.message }, 500);
        }
      },
    },

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

          if (!workspaceId || !filePath || content === undefined) {
            json(res, { error: 'missing workspaceId, path or content' }, 400);
            return;
          }

          const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
          const allowedExts = ['.md', '.txt', '.text', '.json'];
          if (!allowedExts.includes(ext)) {
            json(res, { error: `文件类型 ${ext} 不支持编辑` }, 400);
            return;
          }

          if (content.length > 10 * 1024 * 1024) {
            json(res, { error: '文件内容超过 10MB 限制' }, 400);
            return;
          }

          const workspaces = registry.list();
          const workspace = workspaces.find((w) => w.id === workspaceId);
          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          const config = await loadConfig();
          const docsRoot = resolve(workspace.path, config.docsDir);
          if (docsRoot !== resolve(workspace.path)) {
            await safeDocumentPath(workspace.path, config.docsDir, { allowMissing: true });
          }
          const fullPath = await safeDocumentPath(docsRoot, filePath, { allowMissing: true });

          if (!isInside(docsRoot, fullPath)) {
            json(res, { error: 'path outside docs root' }, 403);
            return;
          }

          await withDocumentLock(fullPath, async () => {
            await safeDocumentPath(docsRoot, filePath, { allowMissing: true });
            await writeFile(fullPath, content, 'utf8');
          });

          const fileStat = await stat(fullPath);

          const result = { success: true, mtime: fileStat.mtime.toISOString() };
          if (options.knowledgeService?.wiki) {
            try {
              result.wiki = await options.knowledgeService.wiki.capture(
                workspaceId,
                filePath,
                req.operationExec?.agent?.session?.id || req.headers?.['x-session-id'],
              );
            } catch {
              result.wiki = { state: 'failed', code: 'WIKI_INGEST_FAILED' };
            }
          }
          json(res, result);
        } catch (e) {
          log.tree.error(`文件写入失败: ${e.message}`);
          json(res, { success: false, error: e.message }, e.status || 500);
        }
      },
    },

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
        const workspace = workspaces.find((w) => w.id === workspaceId);

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
      },
    },

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
            json(
              res,
              { error: 'missing required fields: workspaceId, developer, date, title' },
              400,
            );
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
          const workspace = workspaces.find((w) => w.id === workspaceId);
          if (!workspace) {
            json(res, { error: 'workspace not found' }, 404);
            return;
          }

          const config = await loadConfig();
          const current = await creationStatus(workspace, config);
          if (
            current.existingRequirement &&
            (createBranch ||
              (current.existingRequirement.id === `${date}-${title}` &&
                current.existingRequirement.developer === developer))
          ) {
            json(
              res,
              {
                error: 'CREATE_ALREADY_EXISTS',
                branch: current.branch,
                requirement: current.existingRequirement,
              },
              409,
            );
            return;
          }
          const docsRoot = resolve(workspace.path, config.docsDir);
          const dirName = `${date}-${title}`;
          if (docsRoot !== resolve(workspace.path)) {
            await safeDocumentPath(workspace.path, config.docsDir, { allowMissing: true });
          }
          const targetPath = await safeDocumentPath(docsRoot, join(developer, dirName), {
            allowMissing: true,
          });
          if (!isInside(docsRoot, targetPath)) {
            json(res, { error: 'path outside docs' }, 400);
            return;
          }
          if (existsSync(targetPath)) {
            json(res, { error: 'directory already exists' }, 409);
            return;
          }

          let branchResult = null;
          if (createBranch && branchName) {
            // Accept Unicode branch labels, then validate the full name with Git.
            if (!/^[a-zA-Z0-9一-龥][a-zA-Z0-9一-龥._/\-]*$/.test(branchName)) {
              json(
                res,
                {
                  error:
                    'invalid branch name: only letters, digits, Chinese characters, dots, dashes, underscores and / are allowed',
                },
                400,
              );
              return;
            }

            const { exec } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execAsync = promisify(exec);

            try {
              const { stdout: existing } = await execAsync(`git branch --list "${branchName}"`, {
                cwd: workspace.path,
              });
              if (existing.trim()) {
                json(res, { error: `分支 "${branchName}" 已存在` }, 409);
                return;
              }

              const { stdout: currentBranch } = await execAsync('git branch --show-current', {
                cwd: workspace.path,
              });
              const fromBranch = currentBranch.trim();

              // Create from HEAD before switching so uncommitted work remains in the workspace.

              await execAsync(`git branch "${branchName}"`, { cwd: workspace.path });

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

          await safeDocumentPath(docsRoot, join(developer, dirName), { allowMissing: true });
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
      },
    },

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
        const workspace = workspaces.find((w) => w.id === workspaceId);
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
            if (
              req.id === requirementId &&
              (!requirementPath || req.path.replaceAll('\\', '/') === requirementPath)
            ) {
              reqPath = resolve(docsRoot, req.path);
              break;
            }
          }
          if (reqPath) {
            break;
          }
        }

        if (!reqPath) {
          json(res, { error: 'requirement not found' }, 404);
          return;
        }

        // Supported file extensions
        const supportedExts = [
          '.md',
          '.txt',
          '.text',
          '.html',
          '.htm',
          '.json',
          '.pdf',
          '.docx',
          '.xlsx',
        ];

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
            if (a.isDirectory() && !b.isDirectory()) {
              return -1;
            }
            if (!a.isDirectory() && b.isDirectory()) {
              return 1;
            }
            return a.name.localeCompare(b.name);
          });

          for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);
            const relPath = relativePath ? join(relativePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
              // Skip hidden directories only
              if (entry.name.startsWith('.')) {
                continue;
              }

              const children = await buildFileTree(fullPath, relPath);
              // Always show directories, even if empty
              result.push({
                type: 'directory',
                name: entry.name,
                path: relPath,
                children,
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
                    absolutePath: fullPath,
                    path: relPath,
                    mtime: stats.mtime.toISOString(),
                    size: stats.size,
                  });
                } catch {
                  result.push({
                    type: 'file',
                    name: entry.name,
                    absolutePath: fullPath,
                    path: relPath,
                    mtime: null,
                    size: null,
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
      },
    },
  ];
}
