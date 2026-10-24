'use strict';
const React = require('react');
const h = React.createElement;



/**
 * @component EmptyState
 * @description Displays an empty state placeholder with a title, description, and action buttons.
 * Used when there is no content to display in a panel or list.
 * @param {Object} props - Component props.
 * @param {string} props.title - The heading text for the empty state.
 * @param {string} [props.description] - Optional descriptive text below the title.
 * @param {Array<{label: string, variant?: string, onClick: Function}>} [props.actions] - Array of action button configurations.
 * @returns {JSX.Element} The empty state element.
 */
function EmptyState({ title, description, actions }) {
  return h('div', {
    className: 'rh-empty-state',
    role: 'status',
  },
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
