'use strict';

const React = require('react');
const h = React.createElement;

/** The workbench retains requirement-index maintenance only. */
function WorkbenchPanel({ workspaceId, indexStatus, onRefreshIndex, onClose, IndexPanel }) {
  return h('div', { className: 'rh-op-panel', id: 'rh-workbench-panel', role: 'region', 'aria-label': '需求索引', tabIndex: 0 },
    h(IndexPanel, { workspaceId, indexStatus, onRefresh: onRefreshIndex, onClose }));
}
module.exports = { WorkbenchPanel };
