'use strict';
const { t } = require('../locale.js');
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
  return h('span', { className: css.row }, h(IconReqHub, { size: 18 }), t('common.brandLabel'));
}

module.exports = { TabTitle };
