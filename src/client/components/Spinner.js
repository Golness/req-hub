'use strict';
// Loading artwork is bundled locally; the page owns its centered placement.
const React = require('react');
const { IconLoading } = require('../icons.js').createIconComponents(React.createElement);
const { t } = require('../locale.js');
/**
 * Expose a loading indicator with a localized accessible label.
 * @returns The rendered component content.
 */
function Spinner() {
  return React.createElement(
    'div',
    { className: 'rh-loading', role: 'status', 'aria-label': t('common.loading') },
    React.createElement(IconLoading, { size: 18, className: 'rh-spin' }),
  );
}
module.exports = { Spinner };
