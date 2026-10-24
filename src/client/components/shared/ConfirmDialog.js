'use strict';
const React = require('react');
const h = React.createElement;
const { createPortal } = require('react-dom');
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
function ConfirmDialog({ title, message, confirmText = '确认', cancelText = '取消', variant = 'default', onConfirm, onCancel }) {
  const dialogRef = React.useRef(null);

  // 焦点陷阱（对齐 DSH Modal 的 useModalLayer 行为）
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // 聚焦到对话框内第一个可聚焦元素
    const focusable = dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (first) first.focus();

    const handleTab = (e) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    dialog.addEventListener('keydown', handleTab);
    return () => dialog.removeEventListener('keydown', handleTab);
  }, []);

  return h('div', {
    className: 'rh-confirm-overlay',
    onClick: onCancel,
    role: 'alertdialog',
    'aria-modal': 'true',
    'aria-label': title,
  },
    h('div', {
      ref: dialogRef,
      className: `rh-confirm-dialog rh-confirm-${variant}`,
      onClick: e => e.stopPropagation(),
    },
      h('div', { className: 'rh-confirm-header' },
        variant === 'danger' && h('div', { className: 'rh-confirm-warning-icon' },
          h(IconWarning, { size: 20 })
        ),
        h('h3', { className: 'rh-confirm-title' }, title),
        h('button', {
          className: 'rh-btn rh-btn-ghost rh-btn-sm rh-btn-icon rh-confirm-close',
          onClick: onCancel,
          'aria-label': '关闭',
        }, h(IconClose, { size: 16 }))
      ),
      h('div', { className: 'rh-confirm-body' },
        h('p', { className: 'rh-confirm-message' }, message)
      ),
      h('div', { className: 'rh-confirm-footer' },
        h('button', {
          className: 'rh-btn rh-btn-ghost',
          onClick: onCancel,
        }, cancelText),
        h('button', {
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

  // ESC 键关闭（对齐 DSH Modal 的 useModalLayer）
  React.useEffect(() => {
    if (!config) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [config, handleCancel]);

  if (!config) return null;

  // 使用 createPortal 渲染到 body，避免被祖先元素的 transform/overflow 裁剪
  return createPortal(
    h(ConfirmDialog, {
      title: config.title,
      message: config.message,
      confirmText: config.confirmText,
      cancelText: config.cancelText,
      variant: config.variant,
      onConfirm: handleConfirm,
      onCancel: handleCancel,
    }),
    document.body
  );
}

module.exports = { ConfirmDialog, ConfirmDialogContainer, showConfirm };
