'use strict';

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
  return h('div', { className: 'rh-modal-overlay', onClick: onClose, role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择工作区' },
    h('div', { className: 'rh-modal', onClick: e => e.stopPropagation() },
      h('div', { className: 'rh-modal-title', style: { display: 'flex', alignItems: 'center', gap: 6 } },  ' 选择工作区'),
      workspaces.length === 0
        ? h('div', { className: 'rh-empty' }, '暂无工作区')
        : h('div', { className: 'rh-modal-list', role: 'listbox' },
            workspaces.map(ws =>
              h('div', {
                key: ws.id,
                className: `rh-modal-item${selectedId === ws.id ? ' selected' : ''}`,
                role: 'option',
                'aria-selected': selectedId === ws.id ? 'true' : 'false',
                onClick: () => { onSelect(ws); onClose(); },
              },

                h('span', { className: 'rh-modal-item-name' }, ws.title || ws.id)
              )
            )
          ),
      h('div', { className: 'rh-modal-actions' },
        h('button', { className: 'rh-btn', onClick: onClose }, '关闭')
      )
    )
  );
}

module.exports = { WorkspaceModal };
