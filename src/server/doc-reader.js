/** Requirement directory lookup shared by sync routes. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './logger.js';

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
