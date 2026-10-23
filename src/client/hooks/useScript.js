'use strict';

/**
 * @module useScript
 * @description Custom React hook for lazy-loading external scripts (e.g., mermaid, hljs) into the document.
 * Handles script injection, load detection, error states, and deduplication of already-loaded scripts.
 */

const React = require('react');
const { useState, useEffect } = React;

/**
 * @hook useScript
 * @description Lazy-loads an external JavaScript file by injecting a <script> tag into the document head.
 * Tracks loading state and errors. If the script is already loaded (detected via a global variable),
 * it skips injection. If a script element with the same ID already exists, it polls for the global variable.
 * @param {string} src - The URL of the external script to load.
 * @param {string} id - The DOM element ID to assign to the <script> tag, used for deduplication.
 * @param {string} globalName - The name of the global variable exposed by the script (e.g., 'mermaid', 'hljs'), used to detect load completion.
 * @returns {Object} An object containing the loading state:
 * @returns {boolean} returns.loaded - Whether the script has been successfully loaded and is ready to use.
 * @returns {boolean} returns.error - Whether the script failed to load (timed out after 5 seconds).
 */
function useScript(src, id, globalName) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (window[globalName]) { setLoaded(true); return; }
    let script = document.getElementById(id);
    if (script) {
      const checkInterval = setInterval(() => {
        if (window[globalName]) { clearInterval(checkInterval); setLoaded(true); }
      }, 100);
      const timeout = setTimeout(() => { clearInterval(checkInterval); setError(true); }, 5000);
      return () => { clearInterval(checkInterval); clearTimeout(timeout); };
    }
    script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.onload = () => setLoaded(true);
    script.onerror = () => setError(true);
    document.head.appendChild(script);
  }, [src, id, globalName]);

  return { loaded, error };
}

module.exports = { useScript };
