'use strict';
const { Input } = require('./Input.js');
const { Button } = require('./Button.js');
const { t } = require('../../locale.js');

const React = require('react');
const { Menu } = require('./controls.js');
const h = React.createElement;
const { IconChevronDown } = require('../../icons.js').createIconComponents(h);

function labelText(node) {
  return React.Children.toArray(node).map(child => React.isValidElement(child) ? labelText(child.props.children) : String(child)).join('');
}

/** Plugin Menu follows host placement and keyboard behavior; long lists add search. */
function Select({ children, options, value, onChange, disabled = false, className = '', id, placeholder = t("common.select"), searchable, searchPlaceholder = t("Select.message001"), ...aria }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const triggerRef = React.useRef(null);
  const searchRef = React.useRef(null);
  const generatedId = React.useId();
  const items = options || React.Children.toArray(children).filter(React.isValidElement).map(option => ({
    id: String(option.props.value), label: option.props.children, disabled: !!option.props.disabled, title: option.props.title,
  }));
  const selected = items.find(item => item.id === String(value));
  const canSearch = searchable ?? items.length >= 10;
  const needle = query.trim().toLocaleLowerCase();
  const filtered = canSearch && needle ? items.filter(item => labelText(item.label).toLocaleLowerCase().includes(needle)) : items;
  const itemIds = items.map(item => item.id).join('\n');
  React.useEffect(() => { setOpen(false); }, [value, disabled, itemIds]);
  React.useEffect(() => {
    if (!open || !canSearch) return;
    // Focus the search box after the menu placement layout pass.
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, canSearch]);
  const toggle = () => { setQuery(''); setOpen(previous => !previous); };
  const choose = nextValue => {
    triggerRef.current?.focus({ preventScroll: true });
    setOpen(false);
    onChange?.({ target: { value: nextValue } });
  };
  const anchor = h(Button, {
    ref: triggerRef, id: id || generatedId, type: 'button', className: 'rh-select-trigger',
    disabled: disabled || !items.some(item => !item.disabled),
    'aria-haspopup': 'menu', 'aria-expanded': open && !disabled,
    'aria-label': aria['aria-label'], 'aria-labelledby': aria['aria-labelledby'],
    'aria-describedby': aria['aria-describedby'], 'aria-invalid': aria['aria-invalid'],
    title: selected?.title || (selected && labelText(selected.label)),
    onClick: toggle,
    onKeyDown: event => {
      if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key) && !event.nativeEvent?.isComposing) {
        event.preventDefault(); setQuery(''); setOpen(true);
      }
    },
  }, h('span', { className: 'rh-select-value' }, selected?.label ?? placeholder), h(IconChevronDown, { className: 'rh-select-chevron', 'aria-hidden': true }));
  return h(Menu, {
    open: open && !disabled, onClose: () => setOpen(false),
    anchor, items: filtered.map(({ title, ...item }) => ({ ...item, label: h('span', { title: title || labelText(item.label) }, item.label) })),
    selectedId: String(value ?? ''), onSelect: choose,
    portal: true, autoFocus: !canSearch, dense: true, align: 'start',
    className: `rh-select ${className}`.trim(),
    listClassName: `rh-select-menu${canSearch ? ' rh-select-menu-searchable' : ''}`,
  }, canSearch && h('div', { className: 'rh-select-search', role: 'presentation' },
    h(Input, {
      ref: searchRef, type: 'search', value: query, placeholder: searchPlaceholder,
      'aria-label': t("Select.message003", { value0: aria['aria-label'] || t("Select.message002") }),
      onChange: event => setQuery(event.target.value),
      onKeyDown: event => {
        if (event.nativeEvent?.isComposing) return;
        if (['Home', 'End'].includes(event.key)) event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation();
          const first = filtered.find(item => !item.disabled);
          if (first) choose(first.id);
        }
      },
    }),
    h('span', { className: 'rh-select-count', role: 'status' }, needle ? t("Select.message004", { value0: filtered.length, value1: items.length }) : t("Select.message005", { value0: items.length }))
  ), !filtered.length && h('div', { className: 'rh-select-empty', role: 'status' }, t("Select.message006")));
}

module.exports = { Select };
