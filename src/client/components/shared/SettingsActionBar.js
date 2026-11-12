'use strict';
const React = require('react');
const { createPortal } = require('react-dom');
const { ActionBar } = require('./ActionBar.js');
const h = React.createElement;
const SettingsActionScope = React.createContext({ active: true, target: null });

/**
 * Align section actions or dock page actions in the owning settings panel.
 * @param props - Actions, optional status and page placement; inactive tabs contribute nothing.
 * @returns A shared action bar, inline outside a settings panel and portalled inside one.
 */
function SettingsActionBar({ children, status, placement = 'section', className = '' }) {
  const scope = React.useContext(SettingsActionScope);
  if (!scope.active) {
    return null;
  }
  const content = h(
    ActionBar,
    {
      className,
      placement,
      status,
      'data-settings-actions': placement,
    },
    children,
  );
  return placement === 'page' && scope.target ? createPortal(content, scope.target) : content;
}
module.exports = { SettingsActionBar, SettingsActionScope };
