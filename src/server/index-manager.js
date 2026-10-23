/**
 * Search index management module.
 * Handles building, loading, and saving of search indices.
 * @module index-manager
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Get the index file path for a document root.
 * @param {string} docsRoot - Document root directory
 * @returns {string} Full path to search-index.json
 */
function getIndexPath(docsRoot) {
  return join(docsRoot, '.index', 'search-index.json');
}

/**
 * @typedef {Object} SearchIndex
 * @property {number} version - Index version
 * @property {string} builtAt - Build timestamp (ISO 8601)
 * @property {Array} requirements - List of requirement entries
 * @property {Object<string, string[]>} featureIndex - Feature to requirement ID mapping
 * @property {Object<string, string[]>} fieldIndex - Field to requirement ID mapping
 * @property {Object<string, string[]>} tagIndex - Tag to requirement ID mapping
 */

/**
 * Load search index from disk.
 * @param {string} docsRoot - Document root directory
 * @returns {Promise<SearchIndex|null>} Index object or null if not found/invalid
 */
export async function loadIndex(docsRoot) {
  const indexPath = getIndexPath(docsRoot);
  if (!existsSync(indexPath)) return null;
  try {
    return JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save search index to disk atomically.
 * @param {string} docsRoot - Document root directory
 * @param {SearchIndex} index - Index object to save
 * @returns {Promise<void>}
 */
export async function saveIndex(docsRoot, index) {
  const indexPath = getIndexPath(docsRoot);
  const indexDir = join(docsRoot, '.index');
  await mkdir(indexDir, { recursive: true });
  // Atomic write
  const tmpPath = indexPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  await rename(tmpPath, indexPath);
}

/**
 * Rebuild search index from document tree.
 * Scans all requirements with .meta.json and builds inverted indices.
 * @param {string} docsRoot - Document root directory
 * @param {Object} tree - Document tree from buildTree()
 * @returns {Promise<SearchIndex>} Newly built index
 */
export async function rebuildIndex(docsRoot, tree) {
  const index = {
    version: 1,
    builtAt: new Date().toISOString(),
    requirements: [],
    featureIndex: {},
    fieldIndex: {},
    tagIndex: {},
  };

  for (const dev of tree.developers) {
    for (const req of dev.requirements) {
      if (!req.hasMeta) continue;

      const metaPath = join(docsRoot, req.path, '.meta.json');
      let meta;
      try {
        meta = JSON.parse(await readFile(metaPath, 'utf8'));
      } catch {
        continue;
      }

      const entry = {
        id: req.id,
        developer: dev.name,
        date: req.date,
        title: req.title,
        type: meta.type || 'unknown',
        summary: meta.summary || '',
        features: meta.features || [],
        fields: meta.fields || [],
        tags: meta.tags || [],
        timeline: meta.timeline || [],
      };

      index.requirements.push(entry);

      // Build inverted indices
      for (const feature of (meta.features || [])) {
        if (!index.featureIndex[feature]) index.featureIndex[feature] = [];
        index.featureIndex[feature].push(req.id);
      }
      for (const field of (meta.fields || [])) {
        if (!index.fieldIndex[field]) index.fieldIndex[field] = [];
        index.fieldIndex[field].push(req.id);
      }
      for (const tag of (meta.tags || [])) {
        if (!index.tagIndex[tag]) index.tagIndex[tag] = [];
        index.tagIndex[tag].push(req.id);
      }
    }
  }

  await saveIndex(docsRoot, index);
  return index;
}
