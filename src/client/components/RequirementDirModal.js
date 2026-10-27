'use strict';
const { t } = require('../locale.js');
const css = require('./RequirementDirModal.module.css').default;
const { cssValue } = require('./shared/presentation.js');
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { createIconComponents } = require('../icons.js');

const { IconFolderOpen, IconChevronRight } = createIconComponents(h);

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

  return h(ModalFrame, { className: 'rh-modal-overlay', onClick: onClose, role: 'dialog', 'aria-modal': 'true', 'aria-label': t("DocsViewerBody.message067") },
    h('div', { className: ('rh-modal') + ' ' + css.size, onClick: e => e.stopPropagation() },
      h('div', { className: ('rh-modal-title') + ' ' + css.row },  t("RequirementDirModal.message001")),
      loading
        ? h('div', { className: 'rh-empty' }, t("common.loading"))
        : !tree || tree.developers.length === 0
          ? h('div', { className: 'rh-empty' }, t("RequirementDirModal.message002"))
          : h('div', { className: ('rh-modal-list') + ' ' + css.size2 },
              tree.developers.map(dev =>
                h('div', { key: dev.name },
                  h(Button, {
                    className: ('rh-modal-item') + ' ' + css.heading,
                    onClick: () => toggleDev(dev.name)
                  },
                    h('span', { className: 'rh-modal-item-icon' }, h(IconChevronRight, { size: 12, className: css.indicator, style: { "--rh-transform-0": cssValue(expandedDevs[dev.name] ? 'rotate(90deg)' : 'none') } })),
                    h('span', { className: 'rh-modal-item-name' }, dev.name),
                    h('span', { className: 'rh-modal-item-count' }, `(${dev.requirementCount})`)
                  ),
                  expandedDevs[dev.name] && dev.requirements.map(req =>
                    h(Button, {
                      key: req.id,
                      className: (`rh-modal-item${selectedReqId === req.id ? ' selected' : ''}`) + ' ' + css.content,
                      onClick: () => { onSelect(req); onClose(); },
                    },
                      h('span', { className: 'rh-modal-item-icon' }, h(IconFolderOpen, { size: 14 })),
                      h('span', { className: 'rh-modal-item-name' }, `${req.date.slice(5)} ${req.title}`),
                      h('span', { className: ('rh-modal-item-count') + ' ' + css.row2 }, t("files.count", { value0: req.fileCount }))
                    )
                  )
                )
              )
            ),
      h('div', { className: 'rh-modal-actions' },
        h(Button, { className: 'rh-btn', onClick: onClose }, t("common.close"))
      )
    )
  );
}

module.exports = { RequirementDirModal };
