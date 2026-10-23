'use strict';
const React = require('react');
const h = React.createElement;
const { createIconComponents } = require('../../icons.js');

const { IconCheck, IconError, IconWarning, IconInfo } = createIconComponents(h);

const ICONS = {
  success: IconCheck,
  error: IconError,
  warning: IconWarning,
  info: IconInfo,
};

/** Fade-out animation duration in milliseconds (aligned with DSH FADE_MS). */
const FADE_MS = 300;

/**
 * @component Toast
 * @description Toast notification component aligned with DSH Toast signature (text/tone/onDone).
 * Extended to support four tone variants: success, error, warning, and info (DSH only supports success).
 * Automatically fades out after the specified hold duration and calls onDone when fully removed.
 * @param {Object} props - Component props.
 * @param {string} props.text - The notification message text.
 * @param {React.ReactNode} [props.icon] - Custom icon element. Defaults to a tone-based icon.
 * @param {'success'|'error'|'warning'|'info'} [props.tone='info'] - The visual tone/severity of the notification.
 * @param {HTMLElement|null} [props.anchor] - Optional anchor element for positioning.
 * @param {number} [props.holdMs=3000] - Duration in milliseconds before fade-out begins (excludes fade animation time).
 * @param {Array<{label: string, prefix?: string, onClick: Function}>} [props.actions] - Array of action button configurations.
 * @param {Function} props.onDone - Required callback invoked after the toast has fully faded out and been removed.
 * @returns {JSX.Element|null} The toast notification element, or null if already removed.
 */
function Toast({ text, icon, tone = 'info', anchor, holdMs = 3000, actions, onDone }) {
  const [fading, setFading] = React.useState(false);
  const [removed, setRemoved] = React.useState(false);
  const latestOnDone = React.useRef(onDone);
  latestOnDone.current = onDone;

  const Icon = ICONS[tone] || ICONS.info;

  // 时序对齐 DSH：holdMs 后开始淡出，淡出完成后调用 onDone
  React.useEffect(() => {
    const fadeTimer = setTimeout(() => {
      setFading(true);
    }, holdMs);
    const removeTimer = setTimeout(() => {
      setRemoved(true);
      if (latestOnDone.current) latestOnDone.current();
    }, holdMs + FADE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, [holdMs]);

  const handleClose = () => {
    setFading(true);
    setTimeout(() => {
      setRemoved(true);
      if (latestOnDone.current) latestOnDone.current();
    }, FADE_MS);
  };

  if (removed) return null;

  return h('div', {
    className: `rh-toast rh-toast-${tone}${fading ? ' rh-toast-fading' : ''}`,
    role: 'alert',
    'aria-atomic': 'true',
  },
    h('div', { className: 'rh-toast-icon' },
      icon || h(Icon, { size: 16 })
    ),
    h('span', { className: 'rh-toast-text' }, text),
    actions && actions.length > 0 && h('div', { className: 'rh-toast-actions' },
      actions.map((action, i) =>
        h('button', {
          key: i,
          className: 'rh-toast-action',
          onClick: action.onClick,
        }, `${action.prefix ? action.prefix + ' ' : ''}${action.label}`)
      )
    ),
    h('button', {
      className: 'rh-toast-close',
      onClick: handleClose,
      'aria-label': '关闭通知',
    }, '×')
  );
}

module.exports = { Toast };
