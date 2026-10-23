'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { createIconComponents } = require('../icons.js');

const { IconFolderOpen, IconFile, IconExpand } = createIconComponents(h);

/**
 * @component
 * Modal dialog that displays a tree of requirement directories organized by developer.
 * Allows the user to browse and select a specific requirement directory within a workspace.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The ID of the workspace to load the directory tree from
 * @param {string|null} props.selectedReqId - The currently selected requirement ID, used to highlight the active item
 * @param {Function} props.onSelect - Callback invoked with the selected requirement object when a requirement is clicked
 * @param {Function} props.onClose - Callback invoked to close the modal
 * @returns {JSX.Element}
 */
function RequirementDirModal({ workspaceId, selectedReqId, onSelect, onClose }) {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedDevs, setExpandedDevs] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(workspaceId)}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled && data.tree?.developers) {
            setTree(data.tree);
            // Default: expand first developer
            if (data.tree.developers.length > 0) {
              setExpandedDevs({ [data.tree.developers[0].name]: true });
            }
          }
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  const toggleDev = (devName) => {
    setExpandedDevs(prev => ({ ...prev, [devName]: !prev[devName] }));
  };

  return h('div', { className: 'rh-modal-overlay', onClick: onClose, role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择需求目录' },
    h('div', { className: 'rh-modal', onClick: e => e.stopPropagation(), style: { minWidth: 400 } },
      h('div', { className: 'rh-modal-title', style: { display: 'flex', alignItems: 'center', gap: 6 } }, h(IconFolderOpen, { size: 16 }), ' 选择需求目录'),
      loading
        ? h('div', { className: 'rh-empty' }, '加载中...')
        : !tree || tree.developers.length === 0
          ? h('div', { className: 'rh-empty' }, '暂无需求目录')
          : h('div', { className: 'rh-modal-list', style: { maxHeight: 400 } },
              tree.developers.map(dev =>
                h('div', { key: dev.name },
                  h('div', {
                    className: 'rh-modal-item',
                    onClick: () => toggleDev(dev.name),
                    style: { fontWeight: 600 }
                  },
                    h('span', { className: 'rh-modal-item-icon' }, h(IconExpand, { size: 12, style: { transform: expandedDevs[dev.name] ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' } })),
                    h('span', { className: 'rh-modal-item-name' }, dev.name),
                    h('span', { className: 'rh-modal-item-count' }, `(${dev.requirementCount})`)
                  ),
                  expandedDevs[dev.name] && dev.requirements.map(req =>
                    h('div', {
                      key: req.id,
                      className: `rh-modal-item${selectedReqId === req.id ? ' selected' : ''}`,
                      style: { paddingLeft: 32 },
                      onClick: () => { onSelect(req); onClose(); },
                    },
                      h('span', { className: 'rh-modal-item-icon' }, h(IconFolderOpen, { size: 14 })),
                      h('span', { className: 'rh-modal-item-name' }, `${req.date.slice(5)} ${req.title}`),
                      h('span', { className: 'rh-modal-item-count', style: { display: 'inline-flex', alignItems: 'center', gap: 2 } }, h(IconFile, { size: 11 }), ` ${req.fileCount}`)
                    )
                  )
                )
              )
            ),
      h('div', { className: 'rh-modal-actions' },
        h('button', { className: 'rh-btn', onClick: onClose }, '关闭')
      )
    )
  );
}

module.exports = { RequirementDirModal };
