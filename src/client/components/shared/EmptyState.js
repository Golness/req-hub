'use strict';
const React = require('react');
const h = React.createElement;
const { createIconComponents } = require('../../icons.js');

const { IconFolder, IconFile } = createIconComponents(h);

/**
 * @component EmptyState
 * @description Displays an empty state placeholder with an optional icon, title, description, and action buttons.
 * Used when there is no content to display in a panel or list.
 * @param {Object} props - Component props.
 * @param {React.ReactNode} [props.icon] - Custom icon element to display. Defaults to a file icon.
 * @param {string} props.title - The heading text for the empty state.
 * @param {string} [props.description] - Optional descriptive text below the title.
 * @param {Array<{label: string, variant?: string, onClick: Function}>} [props.actions] - Array of action button configurations.
 * @returns {JSX.Element} The empty state element.
 */
function EmptyState({ icon, title, description, actions }) {
  return h('div', {
    className: 'rh-empty-state',
    role: 'status',
  },
    h('div', { className: 'rh-empty-state-icon' },
      icon || h(IconFile, { size: 48 })
    ),
    h('h3', { className: 'rh-empty-state-title' }, title),
    description && h('p', { className: 'rh-empty-state-desc' }, description),
    actions && actions.length > 0 && h('div', { className: 'rh-empty-state-actions' },
      actions.map((action, i) =>
        h('button', {
          key: i,
          className: `rh-btn ${action.variant === 'primary' ? 'rh-btn-primary' : 'rh-btn-ghost'}`,
          onClick: action.onClick,
        }, action.label)
      )
    )
  );
}

module.exports = { EmptyState };
