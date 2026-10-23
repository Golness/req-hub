'use strict';

/**
 * @module getMermaidTheme
 * @description Utility for detecting the current color scheme and returning the appropriate
 * Mermaid.js diagram theme ('dark' or 'default').
 */

/**
 * Detects whether the application is currently in dark mode by checking the document's
 * 'dark' CSS class and the system's preferred color scheme media query.
 * @returns {string} The Mermaid theme name: 'dark' if dark mode is active, 'default' otherwise.
 */
function getMermaidTheme() {
  const isDarkMode = document.documentElement.classList.contains('dark') ||
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return isDarkMode ? 'dark' : 'default';
}

module.exports = { getMermaidTheme };
