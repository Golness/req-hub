'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { getDocIcon } = require('../utils/getDocIcon.js');
const { createIconComponents } = require('../icons.js');

const { IconFile } = createIconComponents(h);

/**
 * @component DocumentDropdown
 * @description A modal dropdown for viewing documents within a selected requirement directory.
 * Fetches the document tree and displays files from the selected requirement with
 * document type labels and metadata.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The unique identifier of the workspace
 * @param {Object|null} props.selectedReq - The currently selected requirement object
 * @param {Function} props.onSelectFile - Callback invoked when a file is selected
 * @param {Function} props.onClose - Callback invoked when the modal is closed
 * @returns {JSX.Element} A modal with a list of documents from the selected requirement
 */
function DocumentDropdown({ workspaceId, selectedReq, onSelectFile, onClose }) {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(workspaceId)}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setTree(data.tree);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Get files from selected requirement only
  const allFiles = [];
  if (tree?.developers && selectedReq) {
    for (const dev of tree.developers) {
      for (const req of dev.requirements) {
        if (req.id === selectedReq.id) {
          for (const file of req.files) {
            allFiles.push({
              ...file,
              reqId: req.id,
              reqTitle: req.title,
              reqDate: req.date,
              developer: dev.name,
              path: req.path,
            });
          }
          break;
        }
      }
      if (allFiles.length > 0) break;
    }
  }

  return h('div', { className: 'rh-modal-overlay', onClick: onClose, role: 'dialog', 'aria-modal': 'true', 'aria-label': '查看文档' },
    h('div', { className: 'rh-modal', onClick: e => e.stopPropagation(), style: { minWidth: 400 } },
      h('div', { className: 'rh-modal-title', style: { display: 'flex', alignItems: 'center', gap: 6 } }, h(IconFile, { size: 16 }), ' 查看文档'),
      loading
        ? h('div', { className: 'rh-empty' }, '加载中...')
        : !selectedReq
          ? h('div', { className: 'rh-empty' }, '请先选择需求目录')
          : allFiles.length === 0
            ? h('div', { className: 'rh-empty' }, '当前需求目录下暂无文档')
            : h('div', { className: 'rh-modal-list', style: { maxHeight: 400 } },
                allFiles.map((file, idx) => {
                  const docTypeLabels = { requirement: '需求', design: '技术方案', cr: 'CR', other: '文档' };
                  return h('div', {
                    key: `${file.reqId}-${file.name}-${idx}`,
                    className: 'rh-modal-item',
                    onClick: () => { onSelectFile(file); onClose(); },
                  },
                    h('span', { className: 'rh-modal-item-icon' }, getDocIcon(file.type)),
                    h('span', { className: 'rh-modal-item-name' },
                      h('span', { style: { fontWeight: 600 } }, file.name),
                      h('span', { className: `rh-doctype-tag ${file.type}` }, docTypeLabels[file.type] || '文档'),
                      h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--rh-font-size-sm)', marginLeft: 8 } },
                        `${file.developer} / ${file.reqDate.slice(5)} ${file.reqTitle}`)
                    )
                  );
                })
              ),
      h('div', { className: 'rh-modal-actions' },
        h('button', { className: 'rh-btn', onClick: onClose }, '关闭')
      )
    )
  );
}

module.exports = { DocumentDropdown };
