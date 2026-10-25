'use strict';
const { t } = require('../locale.js');
const css = require('./InputModal.module.css').default;
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Input } = require('./shared/Input.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;

/**
 * @component InputModal
 * @description A modal dialog with a text input field for capturing user input. Supports Enter key
 * to confirm and Escape key to cancel. The input is auto-focused on mount.
 * @param {Object} props - Component props
 * @param {string} props.title - The title displayed in the modal header and used as aria-label
 * @param {string} [props.value=''] - The initial value for the input field
 * @param {string} [props.placeholder='请输入...'] - Placeholder text for the input field
 * @param {Function} props.onConfirm - Callback invoked with the trimmed input value when confirmed
 * @param {Function} props.onCancel - Callback invoked when the modal is cancelled
 * @returns {JSX.Element} A modal dialog with a text input and confirm/cancel buttons
 */
function InputModal({ title, value, placeholder, onConfirm, onCancel }) {
  const [inputValue, setInputValue] = useState(value || '');

  useEffect(() => {
    setInputValue(value || '');
  }, [value]);

  const handleConfirm = () => {
    onConfirm(inputValue.trim());
  };

  return h(ModalFrame, { className: 'rh-modal-overlay', onClick: onCancel, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { className: 'rh-modal', onClick: e => e.stopPropagation() },
      h('div', { className: 'rh-modal-title' }, title),
      h('div', { className: css.spacing },
        h(Input, {
          type: 'text',
          value: inputValue,
          onChange: e => setInputValue(e.target.value),
          onKeyDown: e => {
            if (e.key === 'Enter' && !e.nativeEvent?.isComposing) handleConfirm();

          },
          placeholder: placeholder || t("InputModal.message001"),
          'aria-label': title,
          'data-modal-autofocus': true,
          className: css.size
        })
      ),
      h('div', { className: 'rh-modal-actions' },
        h(Button, { className: 'rh-btn', onClick: onCancel }, t("common.cancel")),
        h(Button, { className: 'rh-btn rh-btn-primary', onClick: handleConfirm }, t("common.confirm"))
      )
    )
  );
}

module.exports = { InputModal };
