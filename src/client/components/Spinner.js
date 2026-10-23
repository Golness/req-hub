'use strict';

const React = require('react');
const h = React.createElement;

/**
 * @component
 * A simple loading spinner indicator with "Loading…" text.
 * Displays a centered spinner animation with an accessible status role.
 * @returns {JSX.Element}
 */
function Spinner() {
  return h('div', { className: 'rh-loading', role: 'status', 'aria-label': 'Loading' }, h('div', { className: 'rh-spinner' }), 'Loading…');
}

module.exports = { Spinner };
