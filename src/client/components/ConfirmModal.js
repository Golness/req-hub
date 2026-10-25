'use strict';
const { t } = require('../locale.js');
const css = require('./ConfirmModal.module.css').default;
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Button } = require('./shared/Button.js');

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
  return h(ModalFrame, { className: 'rh-modal-overlay', onClick: onCancel, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { className: 'rh-modal', onClick: e => e.stopPropagation() },
      h('div', { className: 'rh-modal-title', id: 'confirm-modal-title' }, title),
      h('div', { className: css.spacing }, message),
      h('div', { className: 'rh-modal-actions' },
        h(Button, { className: 'rh-btn', onClick: onCancel }, t("common.no")),
        h(Button, { className: 'rh-btn rh-btn-primary', onClick: onConfirm }, t("common.yes"))
      )
    )
  );
}

module.exports = { ConfirmModal };
