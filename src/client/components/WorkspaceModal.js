'use strict';
const { t } = require('../locale.js');
const css = require('./WorkspaceModal.module.css').default;
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const h = React.createElement;



/**
 * @component
 * Modal dialog for selecting a workspace from a list of available workspaces.
 * Displays workspace titles in a selectable list with the currently selected workspace highlighted.
 * @param {Object} props - Component props
 * @param {Array<Object>} props.workspaces - List of workspace objects with id and title properties
 * @param {string} props.selectedId - The ID of the currently selected workspace
 * @param {Function} props.onSelect - Callback invoked with the selected workspace object when a workspace is clicked
 * @param {Function} props.onClose - Callback invoked to close the modal
 * @returns {JSX.Element}
 */
function WorkspaceModal({ workspaces, selectedId, onSelect, onClose }) {
  return h(ModalFrame, { className: 'rh-modal-overlay', onClick: onClose, role: 'dialog', 'aria-modal': 'true', 'aria-label': t("WorkspaceModal.message001") },
    h('div', { className: 'rh-modal', onClick: e => e.stopPropagation() },
      h('div', { className: ('rh-modal-title') + ' ' + css.row },  t("WorkspaceModal.message002")),
      workspaces.length === 0
        ? h('div', { className: 'rh-empty' }, t("WorkspaceModal.message003"))
        : h('div', { className: 'rh-modal-list', role: 'group' },
            workspaces.map(ws =>
              h(Button, {
                key: ws.id,
                className: `rh-modal-item${selectedId === ws.id ? ' selected' : ''}`,
                'aria-pressed': selectedId === ws.id,
                title: ws.title || ws.id,
                onClick: () => { onSelect(ws); onClose(); },
              },

                h('span', { className: `rh-modal-item-name ${css.name}` }, ws.title || ws.id)
              )
            )
          ),
      h('div', { className: 'rh-modal-actions' },
        h(Button, { className: 'rh-btn', onClick: onClose }, t("common.close"))
      )
    )
  );
}

module.exports = { WorkspaceModal };
