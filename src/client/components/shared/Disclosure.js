'use strict';
const React = require('react');
const { Button } = require('./Button.js');
const { Modal } = require('./controls.js');
const { CompactListContext } = require('./CompactListContext.js');
const { t } = require('../../locale.js');
const css = require('./Disclosure.module.css').default;
const h = React.createElement;
const { IconChevronRight, IconChevronDown } = require('../../icons.js').createIconComponents(h);

/**
 * Keep opened content mounted so collapsing does not reset an active task view.
 * @param props - Title, content, optional controlled state, deferred mounting and compact trigger.
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
  compact = false,
  ...props
}) {
  const [internalOpen, setOpen] = React.useState(defaultOpen);
  const inList = React.useContext(CompactListContext);
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
        className: `${css.trigger} ${compact ? css.compact : ''}`,
        'aria-expanded': open,
        'aria-controls': id,
        'data-rh-disclosure-trigger': '',
        onClick: () => {
          setMounted(true);
          setOpen(!open);
          onOpenChange?.(!open);
        },
      },
      compact && h(open ? IconChevronDown : IconChevronRight, { size: 14 }),
      h('span', { className: css.title }, title),
      !compact &&
        h(
          'span',
          { className: css.action, 'aria-hidden': true },
          t(open ? 'disclosure.collapse' : 'disclosure.expand'),
        ),
    ),
    inList && open
      ? h(
          Modal,
          {
            open: true,
            title,
            className: css.dialog,
            onClose: () => {
              setOpen(false);
              onOpenChange?.(false);
            },
          },
          h(CompactListContext.Provider, { value: false }, h('div', { id }, children)),
        )
      : h(
          'div',
          {
            id,
            hidden: !open,
            className: `${css.content} ${compact ? css.compactContent : ''}`,
            'data-rh-disclosure-content': '',
          },
          (mounted || open) && children,
        ),
  );
}
module.exports = { Disclosure };
