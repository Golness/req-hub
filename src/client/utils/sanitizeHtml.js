'use strict';

/**
 * @module sanitizeHtml
 * @description Utility for sanitizing HTML strings by removing potentially dangerous elements
 * and attributes such as <script> tags, inline event handlers, and javascript:/vbscript: URIs.
 */

/**
 * Sanitizes an HTML string by stripping out potentially dangerous content to prevent XSS attacks.
 * Removes <script> tags, inline event handler attributes (e.g., onclick, onerror),
 * javascript: and vbscript: URIs in href/src/action attributes, and data: URIs in src attributes.
 * @param {string} html - The raw HTML string to sanitize.
 * @returns {string} The sanitized HTML string with dangerous content removed.
 */
function sanitizeHtml(html) {
  let clean = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  clean = clean.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  clean = clean.replace(/(?:href|src|action)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '');
  clean = clean.replace(/(?:href|src|action)\s*=\s*(?:"vbscript:[^"]*"|'vbscript:[^']*'|vbscript:[^\s>]+)/gi, '');
  clean = clean.replace(/\ssrc\s*=\s*(?:"data:[^"]*"|'data:[^']*'|data:[^\s>]+)/gi, '');
  return clean;
}

module.exports = { sanitizeHtml };
