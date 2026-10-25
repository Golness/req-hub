'use strict';
// Plugin-owned modal preserves the host focus, mask and Escape behavior.
const React = require('react');
const { Modal } = require('./controls.js');
function ModalFrame({ children, onClick, 'aria-label': title, role = 'dialog' }) {
  return React.createElement(Modal, { open: true, headless: true, title, role, onClose: onClick, className: 'rh-host-dialog', backdropBlur: false }, children);
}
module.exports = { ModalFrame };
