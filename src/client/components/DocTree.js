'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect, useCallback } = React;

const { ROUTE } = require('../constants.js');
const { Spinner } = require('./Spinner.js');
const { getDocIcon } = require('../utils/getDocIcon.js');
const { createIconComponents } = require('../icons.js');

const { IconFolder, IconFolderOpen, IconFile, IconChevronRight } = createIconComponents(h);

/**
 * @component DocTree
 * @description A three-level hierarchical tree component displaying developers, requirements, and files.
 * Supports expanding/collapsing nodes, selecting requirements and files, and auto-expanding
 * to show the selected requirement. Covers features 2.1, 2.2, 2.3, 2.7-2.11, 2.14, 2.15.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The unique identifier of the workspace
 * @param {string} props.docsDir - The path to the documents directory
 * @param {string|null} props.selectedReqId - The ID of the currently selected requirement, or null
 * @param {Function} props.onSelectReq - Callback invoked when a requirement is selected or deselected
 * @param {Object|null} props.selectedFile - The currently selected file object, or null
 * @param {Function} props.onSelectFile - Callback invoked when a file is selected
 * @param {Function} [props.onTreeLoaded] - Callback invoked when the tree data is loaded with metadata
 * @param {Function} [props.onRefreshReady] - Callback invoked with a refresh function for external use
 * @returns {JSX.Element} A hierarchical tree view of developers, requirements, and files
 */
function DocTree({ workspaceId, docsDir, selectedReqId, onSelectReq, selectedFile, onSelectFile, onTreeLoaded, onRefreshReady }) {
  const [tree, setTree] = useState(null);
  const [totalReqs, setTotalReqs] = useState(0);
  const [error, setError] = useState(null);
  const [expandedDevs, setExpandedDevs] = useState({});
  const [expandedReqs, setExpandedReqs] = useState({});

  const loadTree = useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = `${ROUTE}/tree?workspaceId=${encodeURIComponent(workspaceId)}&t=${Date.now()}`;
        const res = await fetch(url);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || 'tree failed');
        else {
          setTree(data.tree);
          setTotalReqs(data.totalRequirements || 0);
          // Notify parent of total requirements
          if (onTreeLoaded) {
            onTreeLoaded({ totalReqs: data.totalRequirements || 0 });
          }
          // Default: expand first developer
          if (data.tree?.developers?.length > 0 && Object.keys(expandedDevs).length === 0) {
            setExpandedDevs({ [data.tree.developers[0].name]: true });
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    const cleanup = loadTree();
    return cleanup;
  }, [loadTree]);

  // Expose refresh function to parent via callback
  useEffect(() => {
    if (onRefreshReady) {
      onRefreshReady(loadTree);
    }
  }, [loadTree, onRefreshReady]);

  // Auto-expand tree nodes for selected requirement
  useEffect(() => {
    if (!tree?.developers || !selectedReqId) return;

    // Find the developer and requirement for the selected ID
    for (const dev of tree.developers) {
      for (const req of dev.requirements) {
        if (req.id === selectedReqId) {
          // Expand the developer node if not already expanded
          setExpandedDevs(prev => {
            if (prev[dev.name]) return prev;
            return { ...prev, [dev.name]: true };
          });
          // Expand the requirement node if not already expanded
          setExpandedReqs(prev => {
            if (prev[req.id]) return prev;
            return { ...prev, [req.id]: true };
          });
          return;
        }
      }
    }
  }, [tree, selectedReqId]);

  if (error) return h('div', { className: 'rh-empty' }, h('span', { className: 'rh-error' }, error));
  if (!tree) return h(Spinner, null);

  const toggleDev = (name) => {
    setExpandedDevs(prev => ({ ...prev, [name]: !prev[name] }));
  };
  const toggleReq = (id) => {
    setExpandedReqs(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return h('div', { className: 'rh-doc-tree', role: 'tree', 'aria-label': '文档目录树' },
    tree.developers.length === 0
      ? h('div', { className: 'rh-empty', style: { minHeight: 80 } },
          h('span', { className: 'rh-empty-icon' }, h(IconFolder, { size: 32 })),
          `No ${docsDir}/ directory or no requirements found.`)
      : tree.developers.map(dev => {
          const isDevExpanded = !!expandedDevs[dev.name];
          return h('div', { key: dev.name, className: 'rh-dev-node', role: 'treeitem', 'aria-expanded': isDevExpanded },
            h('div', { className: 'rh-dev-header', onClick: () => toggleDev(dev.name) },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                h('span', { style: { width: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
                  h(IconChevronRight, { size: 10, style: { transform: isDevExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 } })
                ),
                h(IconFolder, { size: 14, style: { flexShrink: 0 } }),
                h('span', null, ` ${dev.name}`)
              ),
              h('span', { className: 'rh-dev-count' }, `(${dev.requirementCount})`)
            ),
            isDevExpanded && dev.requirements.map(req => {
              const isReqSelected = selectedReqId === req.id;
              const isReqExpanded = !!expandedReqs[req.id];
              return h('div', { key: req.id, className: 'rh-req-node', role: 'treeitem', 'aria-expanded': isReqExpanded, 'aria-selected': isReqSelected },
                h('div', {
                  className: `rh-req-header${isReqSelected ? ' selected' : ''}`,
                  onClick: () => {
                    if (isReqSelected) {
                      onSelectReq(null);
                    } else {
                      onSelectReq(req);
                    }
                    toggleReq(req.id);
                  },
                },
                  h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                    h('span', { style: { width: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }),
                    h(IconFolderOpen, { size: 14, style: { flexShrink: 0 } }),
                    h('span', null, ` ${req.date.slice(5)} ${req.title}`)
                  ),
                  req.fileCount > 0 && h('span', { className: 'rh-dev-count', style: { display: 'inline-flex', alignItems: 'center', gap: 2 } }, h(IconFile, { size: 14 }), ` ${req.fileCount}`)
                ),
                isReqExpanded && h('div', null,
                  req.files.length > 0
                    ? req.files.map(file => {
                        const isActive = selectedFile?.name === file.name && selectedFile?.reqId === req.id;
                        return h('div', {
                          key: file.name,
                          className: `rh-file-item${isActive ? ' active' : ''}`,
                          onClick: (e) => {
                            e.stopPropagation();
                            onSelectFile({ ...file, reqId: req.id, reqTitle: req.title, reqDate: req.date, developer: req.developer });
                          },
                        },
                          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, getDocIcon(file.type, 12), ` ${file.name}`));
                      })
                    : h('div', { className: 'rh-empty-hint' }, '（无文档）'),
                  req.hasMeta && h('div', { className: 'rh-meta-item' }, '.meta.json')
                )
              );
            })
          );
        })
  );
}

module.exports = { DocTree };
