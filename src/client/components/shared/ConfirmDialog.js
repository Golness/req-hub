'use strict';
const { t } = require('../../locale.js');
const { ModalFrame } = require('./ModalFrame.js');
const { Button } = require('./Button.js');
const React = require('react');
const h = React.createElement;
const { createIconComponents } = require('../../icons.js');

const { IconWarning, IconClose } = createIconComponents(h);

/**
 * @component ConfirmDialog
 * @description A modal confirmation dialog with focus trapping and customizable variant styling.
 * @param {Object} props - Component props.
 * @param {string} props.title - The dialog title.
 * @param {string} props.message - The confirmation message body.
 * @param {string} [props.confirmText='确认'] - Label text for the confirm button.
 * @param {string} [props.cancelText='取消'] - Label text for the cancel button.
 * @param {'default'|'warning'|'danger'} [props.variant='default'] - Visual variant that affects button styling and icon display.
 * @param {Function} props.onConfirm - Callback invoked when the user confirms the action.
 * @param {Function} props.onCancel - Callback invoked when the user cancels the action.
 * @returns {JSX.Element} The confirmation dialog element.
 */
function ConfirmDialog({ title, message, confirmText = t("common.confirmAction"), cancelText = t("common.cancel"), variant = 'default', onConfirm, onCancel }) {
  return h(ModalFrame, {
    className: 'rh-confirm-overlay',
    onClick: onCancel,
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-label': title,
  },
    h('div', {
      className: `rh-confirm-dialog rh-confirm-${variant}`,
      onClick: e => e.stopPropagation(),
    },
      h('div', { className: 'rh-confirm-header' },
        variant === 'danger' && h('div', { className: 'rh-confirm-warning-icon' },
          h(IconWarning, { size: 20 })
        ),
        h('h3', { className: 'rh-confirm-title' }, title),
        h(Button, {
          className: 'rh-btn rh-btn-ghost rh-btn-sm rh-btn-icon rh-confirm-close',
          onClick: onCancel,
          'aria-label': t("common.close"),
        }, h(IconClose, { size: 16 }))
      ),
      h('div', { className: 'rh-confirm-body' },
        h('p', { className: 'rh-confirm-message' }, message)
      ),
      h('div', { className: 'rh-confirm-footer' },
        h(Button, {
          className: 'rh-btn rh-btn-ghost',
          onClick: onCancel,
        }, cancelText),
        h(Button, {
          className: `rh-btn ${variant === 'danger' ? 'rh-btn-danger' : variant === 'warning' ? 'rh-btn-warning' : 'rh-btn-primary'}`,
          onClick: onConfirm,
        }, confirmText)
      )
    )
  );
}

// 全局确认对话框管理器
let confirmResolve = null;

/**
 * Displays a confirmation dialog using a Promise-based API.
 * Dispatches a custom event to show the dialog and resolves when the user responds.
 * @param {Object} config - The dialog configuration object.
 * @returns {Promise<boolean>} Resolves to true if the user confirmed, false if cancelled.
 */
function showConfirm(config) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    window.dispatchEvent(new CustomEvent('rh-show-confirm', { detail: config }));
  });
}

/**
 * @component ConfirmDialogContainer
 * @description Container component that manages the global confirmation dialog state.
 * Uses createPortal to render the dialog into document.body, matching DSH Modal portal behavior.
 * Listens for 'rh-show-confirm' custom events and handles ESC key dismissal.
 * @returns {JSX.Element|null} The portal-rendered confirmation dialog, or null when inactive.
 */
function ConfirmDialogContainer() {
  const [config, setConfig] = React.useState(null);

  React.useEffect(() => {
    const handler = (e) => {
      setConfig(e.detail);
    };
    window.addEventListener('rh-show-confirm', handler);
    return () => window.removeEventListener('rh-show-confirm', handler);
  }, []);

  const handleConfirm = React.useCallback(() => {
    setConfig(null);
    if (confirmResolve) {
      confirmResolve(true);
      confirmResolve = null;
    }
  }, []);

  const handleCancel = React.useCallback(() => {
    setConfig(null);
    if (confirmResolve) {
      confirmResolve(false);
      confirmResolve = null;
    }
  }, []);

  if (!config) return null;

  return h(ConfirmDialog, { ...config, onConfirm: handleConfirm, onCancel: handleCancel });
}

module.exports = { ConfirmDialog, ConfirmDialogContainer, showConfirm };
