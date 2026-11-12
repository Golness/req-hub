'use strict';
const React = require('react');
const css = require('./SettingsActionBar.module.css').default;
const h = React.createElement;

/**
 * Keep contextual actions on the right and status or destructive actions on the left.
 * @param props - Actions, optional leading content, status and page or section placement.
 * @returns The shared wrapping action layout used by settings and feature pages.
 */
function ActionBar({ children, leading, status, placement = 'section', className = '', ...props }) {
  return h(
    placement === 'page' ? 'footer' : 'div',
    {
      ...props,
      className: `${css.bar} ${placement === 'page' ? css.page : ''} ${className}`,
      'data-rh-action-bar': placement,
    },
    (leading || status) &&
      h(
        'div',
        { className: css.leading },
        leading,
        status && h('div', { className: css.status }, status),
      ),
    h('div', { className: css.actions }, children),
  );
}
module.exports = { ActionBar };
