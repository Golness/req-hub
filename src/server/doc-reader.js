/**
 * Document reader/writer module.
 * Handles reading and writing of document files.
 * @module doc-reader
 */

import { readdir, readFile, writeFile, stat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './logger.js';

/** @type {number} Maximum document content size (10MB) */
const MAX_DOC_CONTENT = 10000000;

/** @type {string[]} Supported document file extensions */
const SUPPORTED_DOC_EXTS = ['.md', '.html', '.htm', '.txt', '.text', '.markdown'];

/**
 * Check if a filename has a supported document extension.
 * @param {string} filename - File name to check
 * @returns {boolean} True if the file is a supported document type
 */
export function isSupportedDocFile(filename) {
  const lower = filename.toLowerCase();
  return SUPPORTED_DOC_EXTS.some(ext => lower.endsWith(ext));
}

/**
 * Read all documents in a requirement directory.
 * Supports .md, .html, .txt files. HTML files have tags stripped.
 * Content is truncated if it exceeds MAX_DOC_CONTENT.
 * @param {string} reqPath - Requirement directory path
 * @returns {Promise<string>} Merged document content, empty string if no docs found
 */
export async function readRequirementDocs(reqPath) {
  let files;
  try {
    files = await readdir(reqPath);
  } catch {
    return '';
  }

  const docFiles = files.filter(f => isSupportedDocFile(f));
  const parts = [];

  for (const f of docFiles) {
    try {
      const content = await readFile(join(reqPath, f), 'utf8');
      let processedContent = content;
      
      // For HTML files, extract text content
      if (f.toLowerCase().endsWith('.html') || f.toLowerCase().endsWith('.htm')) {
        processedContent = content
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      
      parts.push(`### ${f}\n${processedContent}`);
    } catch { /* skip unreadable */ }
  }

  let docsContent = parts.join('\n\n---\n\n');

  // Truncation protection
  if (docsContent.length > MAX_DOC_CONTENT) {
    docsContent = docsContent.slice(0, MAX_DOC_CONTENT) + '\n\n[内容已截断]';
    log.doc.warn(`文档内容超过 ${MAX_DOC_CONTENT} 字符，已截断`);
  }

  return docsContent;
}

/**
 * Atomically write .meta.json file.
 * Uses temp file + rename for crash safety.
 * @param {string} metaPath - Target file path
 * @param {Object} meta - Meta data object to write
 * @returns {Promise<void>}
 */
export async function writeMetaJson(metaPath, meta) {
  const tmpPath = metaPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(meta, null, 2), 'utf8');
  await rename(tmpPath, metaPath);
}

/**
 * Find a requirement directory by ID.
 * Searches through all developer directories.
 * @param {string} docsRoot - Document root directory
 * @param {string} requirementId - Requirement ID to find
 * @returns {Promise<string|null>} Full path to requirement directory, or null if not found
 */
export async function findRequirementDir(docsRoot, requirementId) {
  try {
    const developers = await readdir(docsRoot, { withFileTypes: true });
    for (const dev of developers) {
      if (!dev.isDirectory() || dev.name.startsWith('.')) continue;
      const devPath = join(docsRoot, dev.name);
      const reqs = await readdir(devPath, { withFileTypes: true });
      for (const req of reqs) {
        if (req.isDirectory() && req.name === requirementId) {
          return join(devPath, req.name);
        }
      }
    }
  } catch (e) {
    log.doc.error(`findRequirementDir error: ${e.message}`);
  }
  return null;
}
