/**
 * General utility module.
 * Provides path safety, file traversal, request handling, and branch validation.
 * @module utils
 */

import { readdir, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

/** @type {number} Maximum directory traversal depth */
const MAX_DEPTH = 10;

/** @type {number} Maximum HTTP request body size (1MB) */
const MAX_BODY_SIZE = 1024 * 1024;

/** @type {number} Maximum document content size (10MB) */
const MAX_DOC_CONTENT = 10000000;

/**
 * @typedef {Object} BranchInfo
 * @property {string|null} developer - Developer name extracted from branch
 * @property {string} date - Date in YYYY-MM-DD format
 * @property {string} title - Branch title/description
 * @property {string} requirementId - Requirement ID (date-title format)
 */

/**
 * Parse Git branch name to extract developer, date, title info.
 * Supports three formats:
 * 1. feature/{developer}/{YYYY-MM-DD}-{title} (new format)
 * 2. feature/{developer}-{YYYY-MM-DD}-{title} (old format)
 * 3. {YYYY-MM-DD}-{title} (no developer prefix)
 * @param {string} branch - Branch name
 * @returns {BranchInfo|null} Parsed info or null if no match
 */
export function parseBranchName(branch) {
  if (!branch) return null;

  // 格式 1 & 2: feature/{developer}[/-]{YYYY-MM-DD}-{title}
  const match1 = branch.match(/^(?:feature\/)?([^/-]+)[/-](\d{4}-\d{2}-\d{2})-(.+)$/);
  if (match1) {
    const [, developer, date, title] = match1;
    return { developer, date, title, requirementId: `${date}-${title}` };
  }

  // 格式 3: {YYYY-MM-DD}-{title}  (无开发者前缀)
  const match2 = branch.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (match2) {
    const [, date, title] = match2;
    return { developer: null, date, title, requirementId: `${date}-${title}` };
  }

  return null;
}

/**
 * Validate Git branch name for safety.
 * Supports Unicode characters (including Chinese), rejects dangerous path traversal patterns.
 * @param {string} branchName - Branch name to validate
 * @throws {Error} If branch name is invalid or contains unsafe characters
 * @returns {void}
 */
export function validateBranchName(branchName) {
  if (!branchName || branchName.trim().length === 0) {
    throw new Error('Invalid branch name');
  }
  // Reject path traversal and absolute paths
  if (branchName.includes('..') || branchName.startsWith('/') || branchName.startsWith('\\')) {
    throw new Error('Invalid branch name');
  }
  // Reject control characters and whitespace
  if (/[\x00-\x1f\s]/.test(branchName)) {
    throw new Error('Invalid branch name');
  }
}

/**
 * Check if a child path is safely inside a parent path.
 * Prevents path traversal attacks by resolving both paths.
 * @param {string} parent - Parent directory path
 * @param {string} child - Child path to check
 * @returns {boolean} True if child is safely inside parent
 */
export function isInside(parent, child) {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);

  const normalizedParent = process.platform === 'win32'
    ? resolvedParent.toLowerCase()
    : resolvedParent;
  const normalizedChild = process.platform === 'win32'
    ? resolvedChild.toLowerCase()
    : resolvedChild;

  const rel = relative(normalizedParent, normalizedChild);
  return rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * @typedef {Object} DocFile
 * @property {string} path - Full file path
 * @property {string} relative - Relative path from root
 * @property {string} name - File name
 * @property {number} size - File size in bytes
 */

/**
 * Walk document directory and collect files with specified extension.
 * Performs cycle detection and depth limiting.
 * @param {string} root - Root directory to walk
 * @param {string} ext - File extension filter (e.g., '.md')
 * @param {number} [maxDepth=MAX_DEPTH] - Maximum traversal depth
 * @returns {Promise<DocFile[]>} Array of found files, sorted by relative path
 */
export async function walkDocs(root, ext, maxDepth = MAX_DEPTH) {
  const results = [];
  const visited = new Set();
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;

    let realDir;
    try {
      realDir = await resolve(dir);
    } catch {
      continue;
    }

    if (visited.has(realDir)) continue;
    visited.add(realDir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;

      if (entry.isDirectory()) {
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(ext)) {
        if (!isInside(root, full)) continue;

        const info = await stat(full).catch(() => null);
        results.push({
          path: full,
          relative: full.slice(resolve(root).length + 1),
          name: entry.name,
          size: info?.size ?? 0,
        });
      }
    }
  }

  results.sort((a, b) => a.relative.localeCompare(b.relative));
  return results;
}

/**
 * Send JSON response with proper headers.
 * @param {Object} res - HTTP response object
 * @param {any} data - Data to serialize as JSON
 * @param {number} [status=200] - HTTP status code
 * @returns {void}
 */
export function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Read HTTP request body as string.
 * Enforces size limit to prevent memory issues.
 * @param {Object} req - HTTP request object
 * @param {number} [maxSize=MAX_BODY_SIZE] - Maximum body size in bytes
 * @returns {Promise<string>} Request body string
 * @throws {Error} If body exceeds max size
 */
export function readBody(req, maxSize = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Truncate long text to specified maximum length.
 * Adds Chinese truncation notice if text was cut.
 * @param {string} text - Original text
 * @param {number} [maxLength=MAX_DOC_CONTENT] - Maximum allowed length
 * @returns {string} Truncated text with notice if needed
 */
export function truncateText(text, maxLength = MAX_DOC_CONTENT) {
  if (text.length > maxLength) {
    return text.slice(0, maxLength) + '\n\n[内容已截断]';
  }
  return text;
}
