'use strict';
// Plugin-owned action adapter; navigation retains native semantics.
const React = require('react');
const { Button: HostButton, Tooltip } = require('./controls.js');
/**
 * Adapt action classes to the plugin-owned button and accessible tooltip.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @param ref - The forwarded native-control ref.
 * @returns The rendered component content.
 */
const Button = React.forwardRef(function Button(
  { className = '', variant: requestedVariant, size: requestedSize, ...props },
  ref,
) {
  const compact = /rh-btn-(sm|icon|pill)/.test(className);
  let variant = requestedVariant;
  if (!variant) {
    if (/rh-btn-ghost|rh-modal-item|rh-codex-workspace/.test(className)) {
      variant = 'ghost';
    } else if (/rh-btn-primary/.test(className)) {
      variant = 'primary';
    } else {
      variant = 'outline';
    }
  }
  const label = props['aria-label'] || props.title;
  const iconOnly = /rh-btn-icon/.test(className) && label;
  const button = React.createElement(HostButton, {
    ...props,
    title: iconOnly ? undefined : props.title,
    ref,
    className,
    variant,
    size: requestedSize || (compact ? 'sm' : 'md'),
  });
  return iconOnly
    ? React.createElement(Tooltip, { label, portal: true, side: 'top' }, button)
    : button;
});
module.exports = { Button };
