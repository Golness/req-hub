'use strict';
const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('./Button.js');
const { Modal } = require('./controls.js');
const css = require('./KnowledgeAssistant.module.css').default;
const h = React.createElement;
const join = (...names) => names.filter(Boolean).join(' ');

/**
 * Keep knowledge tools beside content and use a focus-managed drawer on request.
 * @param props - Assistant title, content, drawer or pinned state and close callback.
 * @returns A responsive sidebar or an accessible modal drawer.
 */
function KnowledgeAssistant({ title, open, pinned = false, fill = false, onClose, children }) {
  const body = h(
    'div',
    { className: join(css.body, fill && css.fillBody) },
    h(
      'div',
      { className: css.heading },
      h('h3', null, title),
      !pinned && h(Button, { size: 'sm', onClick: onClose }, t('writing.hideAssistant')),
    ),
    children,
  );
  if (open) {
    return h(
      Modal,
      {
        open,
        title,
        onClose,
        className: join(css.drawer, fill && css.fillDrawer),
        headless: true,
      },
      body,
    );
  }
  return h(
    'aside',
    {
      className: join(css.aside, fill && css.fillAside),
      'aria-label': title,
      'data-rh-assistant-pinned': pinned,
    },
    body,
  );
}
module.exports = { KnowledgeAssistant };
