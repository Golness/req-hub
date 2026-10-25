const { t } = require('../locale.js');
'use strict';
const css = require('./TabTitle.module.css').default;

const React = require('react');
const h = React.createElement;
const { createIconComponents } = require('../icons.js');
const { IconReqHub } = createIconComponents(h);

/**
 * @component
 * Renders the tab title for the Req Hub plugin tab, displaying a requirements hub icon
 * and the text "Req Hub". Used as the tab label in the host application's tab bar.
 * @returns {JSX.Element}
 */
function TabTitle() {
  return h('span', { className: css.row, role: 'tab' },
    h(IconReqHub, { size: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }), t("common.brandLabel")
  );
}

module.exports = { TabTitle };
