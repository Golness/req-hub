'use strict';
const React = require('react');
const { useTimeZone, formatDate } = require('../../time.js');
const { Button } = require('./Button.js');
const { Popover } = require('./controls.js');
const { t } = require('../../locale.js');
const css = require('./DatePicker.module.css').default;
const h = React.createElement;
const { IconBack, IconChevronRight } = require('../../icons.js').createIconComponents(h);
const keyOf = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parse = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return keyOf(date) === value ? date : null;
};
/**
 * Select a date using the plugin-owned calendar controls.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function DatePicker({ id, value, onChange, disabled = false, label }) {
  useTimeZone();
  const generatedId = React.useId();
  const pickerId = id || generatedId;
  const today = () => parse(formatDate(new Date()));
  const [open, setOpen] = React.useState(false);
  const [cursor, setCursor] = React.useState(() => parse(value) || today());
  const grid = React.useRef(null);
  const focusPending = React.useRef(false);
  React.useLayoutEffect(() => {
    if (open && focusPending.current) {
      grid.current?.querySelector('[data-date-focus="true"]')?.focus();
      focusPending.current = false;
    }
  }, [open, cursor]);
  const move = (date) => {
    focusPending.current = true;
    setCursor(date);
  };
  const month = (delta) => {
    const target = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
    target.setDate(
      Math.min(
        cursor.getDate(),
        new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate(),
      ),
    );
    move(target);
  };
  const choose = (date) => {
    onChange({ target: { value: keyOf(date) } });
    setOpen(false);
    document.getElementById(pickerId)?.focus();
  };
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((((first.getDay() + 6) % 7) + daysInMonth) / 7);
  const dates = Array.from({ length: weeks * 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  const toggle = () => {
    setCursor(parse(value) || today());
    setOpen((previous) => !previous);
  };
  return h(
    Popover,
    {
      open: open && !disabled,
      onClose: () => setOpen(false),
      label,
      className: css.calendar,
      anchor: h(
        Button,
        {
          id: pickerId,
          className: css.trigger,
          disabled,
          'aria-haspopup': 'dialog',
          'aria-expanded': open && !disabled,
          'aria-label': `${label} ${value || ''}`,
          onClick: toggle,
        },
        value || t('datePicker.choose'),
      ),
    },
    h(
      'div',
      { className: css.header },
      h(
        Button,
        {
          className: css.nav,
          size: 'sm',
          variant: 'ghost',
          'aria-label': t('datePicker.previous'),
          onClick: () => month(-1),
        },
        h(IconBack, { size: 16 }),
      ),
      h(
        'span',
        { className: css.title, 'aria-live': 'polite' },
        t('datePicker.month', { year: cursor.getFullYear(), month: cursor.getMonth() + 1 }),
      ),
      h(
        Button,
        {
          className: css.nav,
          size: 'sm',
          variant: 'ghost',
          'aria-label': t('datePicker.next'),
          onClick: () => month(1),
        },
        h(IconChevronRight, { size: 16 }),
      ),
    ),
    h(
      'div',
      { className: css.week, 'aria-hidden': true },
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) =>
        h('span', { key: day }, t(`datePicker.${day}`)),
      ),
    ),
    h(
      'div',
      {
        ref: grid,
        className: css.days,
        role: 'grid',
        'aria-label': label,
        onKeyDown: (event) => {
          if (event.nativeEvent?.isComposing) {
            return;
          }
          const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
          if (delta !== undefined) {
            event.preventDefault();
            const next = new Date(cursor);
            next.setDate(next.getDate() + delta);
            move(next);
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            const next = new Date(cursor);
            next.setDate(
              next.getDate() - ((next.getDay() + 6) % 7) + (event.key === 'End' ? 6 : 0),
            );
            move(next);
          } else if (event.key === 'PageUp' || event.key === 'PageDown') {
            event.preventDefault();
            month(event.key === 'PageUp' ? -1 : 1);
          }
        },
      },
      Array.from({ length: weeks }, (_, row) =>
        h(
          'div',
          { key: row, role: 'row', className: css.week },
          dates.slice(row * 7, row * 7 + 7).map((date) => {
            if (date.getMonth() !== cursor.getMonth()) {
              return h('span', {
                key: keyOf(date),
                className: css.blank,
                role: 'gridcell',
                'aria-hidden': true,
              });
            }
            return h(
              'button',
              {
                key: keyOf(date),
                type: 'button',
                role: 'gridcell',
                className: css.day,
                tabIndex: keyOf(date) === keyOf(cursor) ? 0 : -1,
                'aria-label': keyOf(date),
                'aria-selected': keyOf(date) === value,
                'aria-current': keyOf(date) === keyOf(today()) ? 'date' : undefined,
                'data-date-focus': keyOf(date) === keyOf(cursor),
                onClick: () => choose(date),
              },
              date.getDate(),
            );
          }),
        ),
      ),
    ),
    h(
      'div',
      { className: css.footer },
      h(
        Button,
        { size: 'sm', variant: 'ghost', onClick: () => choose(today()) },
        t('datePicker.today'),
      ),
    ),
  );
}
module.exports = { DatePicker };
