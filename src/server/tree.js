/**
 * Document tree management module.
 * Handles building and querying of document directory tree structure.
 * @module tree
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** @type {RegExp} Pattern for requirement directory names (YYYY-MM-DD-title) */
const REQ_DIR_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

/**
 * @typedef {Object} RequirementDir
 * @property {string} id - Directory name (requirement ID)
 * @property {string} date - Date in YYYY-MM-DD format
 * @property {string} title - Requirement title
 */

/**
 * Parse requirement directory name.
 * @param {string} dirName - Directory name
 * @returns {RequirementDir|null} Parsed info or null if not a requirement dir
 */
function parseRequirementDir(dirName) {
  const m = dirName.match(REQ_DIR_RE);
  if (!m) return null;
  return {
    id: dirName,
    date: m[1],
    title: m[2],
  };
}

/**
 * Infer document type from filename.
 * @param {string} filename - File name
 * @returns {'cr'|'design'|'requirement'|'other'} Document type
 */
function inferDocType(filename) {
  const lower = filename.toLowerCase();
  if (/\bcr\b/.test(lower) || lower.includes('code review') || lower.includes('codereview')) return 'cr';
  if (lower.includes('技术') || lower.includes('design') || lower.includes('tech') || lower.includes('technical')) return 'design';
  if (lower.includes('需求') || lower.includes('require') || lower.includes('prd')) return 'requirement';
  return 'other';
}

/**
 * @typedef {Object} DocFile
 * @property {string} name - File name
 * @property {'cr'|'design'|'requirement'|'other'} type - Inferred document type
 * @property {string|null} mtime - Last modified time (ISO 8601)
 */

/**
 * @typedef {Object} Requirement
 * @property {string} id - Requirement ID (directory name)
 * @property {string} date - Date in YYYY-MM-DD format
 * @property {string} title - Requirement title
 * @property {string} developer - Developer name
 * @property {string} path - Relative path from docs root
 * @property {DocFile[]} files - List of document files
 * @property {number} fileCount - Number of document files
 * @property {boolean} hasMeta - Whether .meta.json exists
 * @property {string|null} metaUpdatedAt - Meta file update time (ISO 8601)
 * @property {Object|null} meta - Parsed meta data
 */

/**
 * @typedef {Object} DeveloperNode
 * @property {string} name - Developer name
 * @property {number} requirementCount - Number of requirements
 * @property {Requirement[]} requirements - List of requirements
 */

/**
 * @typedef {Object} DocumentTree
 * @property {DeveloperNode[]} developers - List of developer nodes
 */

/**
 * Build document tree from docs directory.
 * Scans developer directories and their requirement subdirectories.
 * @param {string} docsDir - Document root directory
 * @returns {Promise<DocumentTree>} Document tree structure
 */
export async function buildTree(docsDir) {
  const tree = { developers: [] };

  let devEntries;
  try {
    devEntries = await readdir(docsDir, { withFileTypes: true });
  } catch {
    return tree;
  }

  for (const entry of devEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const devPath = join(docsDir, entry.name);
    const devNode = {
      name: entry.name,
      requirementCount: 0,
      requirements: [],
    };

    let reqDirs;
    try {
      reqDirs = await readdir(devPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const rd of reqDirs) {
      if (!rd.isDirectory()) continue;
      const parsed = parseRequirementDir(rd.name);
      if (!parsed) continue;

      const reqPath = join(devPath, rd.name);
      let files;
      try {
        files = await readdir(reqPath);
      } catch {
        files = [];
      }

      const docFiles = files.filter(
        f => f.endsWith('.md') || f.endsWith('.html') || f.endsWith('.htm') ||
             f.endsWith('.txt') || f.endsWith('.text') || f.endsWith('.markdown')
      );
      const hasMeta = files.includes('.meta.json');

      let metaUpdatedAt = null;
      let meta = null;
      if (hasMeta) {
        try {
          const metaStat = await stat(join(reqPath, '.meta.json'));
          metaUpdatedAt = metaStat.mtime.toISOString();
          const metaContent = await readFile(join(reqPath, '.meta.json'), 'utf8');
          meta = JSON.parse(metaContent);
        } catch { /* ignore */ }
      }

      // Get file modification times
      const fileStats = [];
      for (const f of docFiles) {
        try {
          const s = await stat(join(reqPath, f));
          fileStats.push({ name: f, mtime: s.mtime.toISOString() });
        } catch {
          fileStats.push({ name: f, mtime: null });
        }
      }

      devNode.requirements.push({
        ...parsed,
        developer: entry.name,
        path: relative(docsDir, reqPath),
        files: docFiles.map(f => {
          const statEntry = fileStats.find(s => s.name === f);
          return {
            name: f,
            type: inferDocType(f),
            mtime: statEntry?.mtime || null,
          };
        }),
        fileCount: docFiles.length,
        hasMeta,
        metaUpdatedAt,
        meta,
      });
    }

    devNode.requirements.sort((a, b) => b.date.localeCompare(a.date));
    devNode.requirementCount = devNode.requirements.length;
    tree.developers.push(devNode);
  }

  tree.developers.sort((a, b) => a.name.localeCompare(b.name));
  return tree;
}

/**
 * Count total requirements across all developers.
 * @param {DocumentTree} tree - Document tree
 * @returns {number} Total requirement count
 */
export function countRequirements(tree) {
  return tree.developers.reduce((sum, d) => sum + d.requirementCount, 0);
}

/**
 * Find requirement path by ID.
 * @param {string} docsDir - Document root directory
 * @param {DocumentTree} tree - Document tree
 * @param {string} requirementId - Requirement ID to find
 * @returns {{path: string, req: Requirement}|null} Requirement info or null if not found
 */
export function findRequirementPath(docsDir, tree, requirementId) {
  for (const dev of tree.developers) {
    for (const req of dev.requirements) {
      if (req.id === requirementId) {
        return { path: join(docsDir, req.path), req };
      }
    }
  }
  return null;
}

/** @type {string[]} Supported document file extensions */
export const SUPPORTED_DOC_EXTS = ['.md', '.html', '.htm', '.txt', '.text', '.markdown'];
