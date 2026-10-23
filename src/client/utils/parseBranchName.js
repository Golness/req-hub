'use strict';

/**
 * @module parseBranchName
 * @description Utility for parsing git branch names into structured components
 * (developer, date, title, and requirement ID) following the project's branch naming conventions.
 */

/**
 * Parses a git branch name to extract developer, date, and title components.
 * Supports the following branch name formats:
 * - feature/<developer>/<date>-<title> (e.g., feature/lihanping/2026-10-10-包材报价管理)
 * - <developer>/<date>-<title> (e.g., lihanping/2026-10-10-包材报价管理)
 * - <developer>/<title> (e.g., lihanping/包材报价管理)
 * @param {string} branch - The git branch name to parse.
 * @returns {Object} An object containing the parsed components:
 * @returns {string|null} returns.developer - The developer name extracted from the branch, or null if not found.
 * @returns {string|null} returns.date - The date string (YYYYMMDD format) extracted from the branch, or null if not found.
 * @returns {string} returns.title - The title/description portion of the branch name.
 * @returns {string} [returns.requirementId] - The requirement ID in 'YYYY-MM-DD-title' format, present when a date is found.
 */
function parseBranchName(branch) {
  if (!branch || typeof branch !== 'string') {
    return { developer: null, date: null, title: branch };
  }

  const parts = branch.split('/');

  // Handle feature/<developer>/<date>-<title> format
  if (parts.length >= 3 && parts[0] === 'feature') {
    const developer = parts[1];
    const rest = parts.slice(2).join('/');

    // Try to extract date (YYYY-MM-DD or YYYYMMDD)
    const dateMatch = rest.match(/^(\d{4}-?\d{2}-?\d{2})[-_](.+)$/);
    if (dateMatch) {
      // Normalize date to YYYY-MM-DD format (insert dashes if needed)
      const rawDate = dateMatch[1];
      const date = rawDate.length === 8
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
        : rawDate;
      const title = dateMatch[2];
      // requirementId format: YYYY-MM-DD-title
      const requirementId = `${date}-${title}`;
      return {
        developer,
        date,
        title,
        requirementId,
      };
    }

    return { developer, date: null, title: rest, requirementId: rest };
  }

  // Handle <developer>/<date>-<title> format
  if (parts.length >= 2) {
    const developer = parts[0];
    const rest = parts.slice(1).join('/');

    // Try to extract date (YYYY-MM-DD or YYYYMMDD)
    const dateMatch = rest.match(/^(\d{4}-?\d{2}-?\d{2})[-_](.+)$/);
    if (dateMatch) {
      // Normalize date to YYYY-MM-DD format (insert dashes if needed)
      const rawDate = dateMatch[1];
      const date = rawDate.length === 8
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
        : rawDate;
      const title = dateMatch[2];
      // requirementId format: YYYY-MM-DD-title
      const requirementId = `${date}-${title}`;
      return {
        developer,
        date,
        title,
        requirementId,
      };
    }

    return { developer, date: null, title: rest, requirementId: rest };
  }

  return { developer: null, date: null, title: branch };
}

module.exports = { parseBranchName };
