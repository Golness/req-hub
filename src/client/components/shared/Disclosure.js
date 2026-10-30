'use strict';
const React = require('react');
const { Button } = require('./Button.js');
const { t } = require('../../locale.js');
const css = require('./Disclosure.module.css').default;
const h = React.createElement;

/**
 * Keep opened content mounted so collapsing does not reset an active task view.
 * @param props - Title, content, optional controlled state and deferred initial mounting.
 * @returns A keyboard-accessible section with a plugin-owned button.
 */
function Disclosure({
  title,
  children,
  lazy = false,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  className = '',
  ...props
}) {
  const [internalOpen, setOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const [mounted, setMounted] = React.useState(!lazy || open);
  React.useEffect(() => {
    if (open) {
      setMounted(true);
    }
  }, [open]);
  const id = React.useId();
  return h(
    'section',
    { ...props, className: `${css.section} ${className}`, 'data-rh-disclosure': '' },
    h(
      Button,
      {
        variant: 'ghost',
        size: 'sm',
        className: css.trigger,
        'aria-expanded': open,
        'aria-controls': id,
        'data-rh-disclosure-trigger': '',
        onClick: () => {
          setMounted(true);
          setOpen(!open);
          onOpenChange?.(!open);
        },
      },
      h('span', { className: css.title }, title),
      h(
        'span',
        { className: css.action, 'aria-hidden': true },
        t(open ? 'disclosure.collapse' : 'disclosure.expand'),
      ),
    ),
    h(
      'div',
      { id, hidden: !open, className: css.content, 'data-rh-disclosure-content': '' },
      (mounted || open) && children,
    ),
  );
}
module.exports = { Disclosure };
