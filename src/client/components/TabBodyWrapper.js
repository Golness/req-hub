'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { DocsViewerBody } = require('./DocsViewerBody.js');

/**
 * @component
 * Top-level tab body wrapper that loads workspace list and configuration,
 * then renders the DocsViewerBody with the selected workspace and docs directory.
 * Manages workspace selection state and config loading on mount.
 * @returns {JSX.Element}
 */
function TabBodyWrapper() {
  const [workspaces, setWorkspaces] = useState([]);
  const [docsDir, setDocsDir] = useState('docs');
  const [selectedWs, setSelectedWs] = useState(null);
  const [initialReqId, setInitialReqId] = useState(null);

  // Pass wsList explicitly to avoid stale closure over workspaces state
  const loadConfig = (wsList) => {
    const list = wsList || workspaces;
    return fetch(`${ROUTE}/config?t=${Date.now()}`, { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } })
      .then(res => res.ok ? res.json() : null)
      .then(config => {
        if (config?.docsDir) setDocsDir(config.docsDir);
        setInitialReqId(config?.requirementId || null);
        if (list.length > 0) {
          if (config?.workspaceId) {
            const ws = list.find(w => w.id === config.workspaceId);
            if (ws) {
              setSelectedWs(prev => prev?.id === ws.id ? prev : ws);
              return config;
            }
          }
          setSelectedWs(prev => prev || list[0]);
        }
        return config;
      })
      .catch(() => {
        setSelectedWs(prev => prev || (list.length > 0 ? list[0] : null));
        return null;
      });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${ROUTE}/workspaces`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) {
          setWorkspaces(data);
          // Use plugin's saved config or first workspace
          const config = await loadConfig();
          if (config?.workspaceId) {
            const ws = data.find(w => w.id === config.workspaceId);
            if (ws) {
              setSelectedWs(ws);
              return;
            }
          }
          setSelectedWs(prev => prev || (data.length > 0 ? data[0] : null));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!workspaces.length) {
    return h('div', { className: 'rh-empty' }, 'No workspaces available');
  }

  if (!selectedWs) {
    return h('div', { className: 'rh-empty' }, 'Select a workspace');
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' }, role: 'main' },
    h(DocsViewerBody, {
      key: `${selectedWs.id}:${docsDir}`,
      workspace: selectedWs,
      docsDir,
      onConfigChange: () => loadConfig(workspaces),
      workspaces,
      onSelectWorkspace: setSelectedWs,
      initialReqId,
    })
  );
}

module.exports = { TabBodyWrapper };
