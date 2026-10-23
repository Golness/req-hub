'use strict';

const React = require('react');
const h = React.createElement;

/**
 * @component ConfirmModal
 * @description A modal dialog for confirming user actions. Displays a title and message
 * with confirm/cancel buttons. Clicking the overlay cancels the action.
 * @param {Object} props - Component props
 * @param {string} props.title - The title displayed in the modal header
 * @param {string} props.message - The confirmation message to display
 * @param {Function} props.onConfirm - Callback invoked when the user confirms the action
 * @param {Function} props.onCancel - Callback invoked when the user cancels the action
 * @returns {JSX.Element} A modal dialog with confirm and cancel buttons
 */
function ConfirmModal({ title, message, onConfirm, onCancel }) {
  return h('div', { className: 'rh-modal-overlay', onClick: onCancel, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { className: 'rh-modal', onClick: e => e.stopPropagation() },
      h('div', { className: 'rh-modal-title', id: 'confirm-modal-title' }, title),
      h('div', { style: { marginBottom: 16, fontSize: '13px', color: 'var(--dsw-alias-label-primary)', lineHeight: '1.5' } }, message),
      h('div', { className: 'rh-modal-actions' },
        h('button', { className: 'rh-btn', onClick: onCancel }, '否'),
        h('button', { className: 'rh-btn rh-btn-primary', onClick: onConfirm }, '是')
      )
    )
  );
}

module.exports = { ConfirmModal };
