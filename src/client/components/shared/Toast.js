'use strict';
// Plugin-owned notification with host theme tokens and lifecycle cleanup.
const React = require('react');
const { Toast: HostToast } = require('./controls.js');
const { createIconComponents } = require('../../icons.js');
const { IconError, IconWarning, IconInfo, IconCheck } = createIconComponents(React.createElement);
const icons = { success: IconCheck, error: IconError, warning: IconWarning, info: IconInfo };
function Toast({ tone, icon, ...props }) {
  return React.createElement(HostToast, { ...props, tone,
    icon: icon || (icons[tone] ? React.createElement(icons[tone]) : undefined) });
}
module.exports = { Toast };
