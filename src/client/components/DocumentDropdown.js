'use strict';
const { t } = require('../locale.js');
const css = require('./DocumentDropdown.module.css').default;
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { getDocIcon } = require('../utils/getDocIcon.js');



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

  return h(ModalFrame, { className: 'rh-modal-overlay', onClick: onClose, role: 'dialog', 'aria-modal': 'true', 'aria-label': t("DocumentDropdown.message001") },
    h('div', { className: ('rh-modal') + ' ' + css.size, onClick: e => e.stopPropagation() },
      h('div', { className: ('rh-modal-title') + ' ' + css.row },  t("DocumentDropdown.message002")),
      loading
        ? h('div', { className: 'rh-empty' }, t("common.loading"))
        : !selectedReq
          ? h('div', { className: 'rh-empty' }, t("DocumentDropdown.message003"))
          : allFiles.length === 0
            ? h('div', { className: 'rh-empty' }, t("DocumentDropdown.message004"))
            : h('div', { className: ('rh-modal-list') + ' ' + css.size2 },
                allFiles.map((file, idx) => {
                  const docTypeLabels = { requirement: t("DocsViewerBody.message072"), design: t("DocumentDropdown.message005"), cr: 'CR', other: t("DocumentDropdown.message006") };
                  return h(Button, {
                    key: `${file.reqId}-${file.name}-${idx}`,
                    className: 'rh-modal-item',
                    onClick: () => { onSelectFile(file); onClose(); },
                  },

                    h('span', { className: 'rh-modal-item-name' },
                      h('span', { className: css.heading }, file.name),
                      h('span', { className: `rh-doctype-tag ${file.type}` }, docTypeLabels[file.type] || t("DocumentDropdown.message006")),
                      h('span', { className: css.mutedText },
                        `${file.developer} / ${file.reqDate.slice(5)} ${file.reqTitle}`)
                    )
                  );
                })
              ),
      h('div', { className: 'rh-modal-actions' },
        h(Button, { className: 'rh-btn', onClick: onClose }, t("common.close"))
      )
    )
  );
}

module.exports = { DocumentDropdown };
