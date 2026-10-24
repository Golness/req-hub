'use strict';

const React = require('react');
const { createPortal } = require('react-dom');
const { DocsViewerContext } = require('../../context.js');
const h = React.createElement;
const { IconBack } = require('../../icons.js').createIconComponents(h);

// Render navigation in the shell, while keeping each page's return behavior local.
function HeaderBack({ onBack, active = true, label = '返回' }) {
  const { headerBackTarget } = React.useContext(DocsViewerContext);
  if (!active || !headerBackTarget || !onBack) return null;
  return createPortal(h('button', {
    type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm rh-header-back',
    onClick: onBack, 'aria-label': label, title: label,
  }, h(IconBack, { size: 16 }), '返回'), headerBackTarget);
}

module.exports = { HeaderBack };
