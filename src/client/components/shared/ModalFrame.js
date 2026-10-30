'use strict';
// Plugin-owned modal preserves the host focus, mask and Escape behavior.
const React = require('react');
const { Modal } = require('./controls.js');
/**
 * Apply consistent title, focus and dismissal behavior to modal content.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function ModalFrame({
  children,
  onClick,
  'aria-label': title,
  role = 'dialog',
  surfaceClassName = '',
}) {
  return React.createElement(
    Modal,
    {
      open: true,
      headless: true,
      title,
      role,
      onClose: onClick,
      className: `rh-host-dialog ${surfaceClassName}`.trim(),
      backdropBlur: false,
    },
    children,
  );
}
module.exports = { ModalFrame };
