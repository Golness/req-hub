'use strict';

const React = require('react');
const { createPortal } = require('react-dom');
const { DocsViewerContext } = require('../../context.js');
const h = React.createElement;

// Render navigation in the shell, while keeping each page's return behavior local.
function HeaderBack({ onBack, active = true, label = '返回' }) {
  const { headerBackTarget } = React.useContext(DocsViewerContext);
  if (!active || !headerBackTarget || !onBack) return null;
  return createPortal(h('button', {
    type: 'button', className: 'rh-btn rh-btn-ghost rh-header-back',
    onClick: onBack, 'aria-label': label, title: label,
  }, h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true },
    h('path', { d: 'm14 6-6 6 6 6', strokeLinecap: 'round', strokeLinejoin: 'round' })), '返回'), headerBackTarget);
}

module.exports = { HeaderBack };
