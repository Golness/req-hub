'use strict';
const { t } = require('../../locale.js');
const { Button } = require('./Button.js');

const React = require('react');
const { createPortal } = require('react-dom');
const { DocsViewerContext } = require('../../context.js');
const h = React.createElement;
const { IconBack } = require('../../icons.js').createIconComponents(h);

// Render navigation in the shell, while keeping each page's return behavior local.
/**
 * Return from detail content while retaining the parent view.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function HeaderBack({ onBack, active = true, label = t('common.back') }) {
  const { headerBackTarget } = React.useContext(DocsViewerContext);
  if (!active || !headerBackTarget || !onBack) {
    return null;
  }
  return createPortal(
    h(
      Button,
      {
        type: 'button',
        className: 'rh-btn rh-btn-ghost rh-btn-sm rh-header-back',
        onClick: onBack,
        'aria-label': label,
        title: label,
      },
      h(IconBack, { size: 16 }),
      t('common.back'),
    ),
    headerBackTarget,
  );
}

module.exports = { HeaderBack };
