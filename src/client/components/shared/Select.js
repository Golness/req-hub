'use strict';

const React = require('react');
const { Menu, IconChevronDownOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
const h = React.createElement;

function labelText(node) {
  return React.Children.toArray(node).map(child => React.isValidElement(child) ? labelText(child.props.children) : String(child)).join('');
}

/** Host Menu supplies placement and keyboard navigation; long lists add local search. */
function Select({ children, options, value, onChange, disabled = false, className = '', id, placeholder = '请选择', searchable, searchPlaceholder = '搜索选项…', ...aria }) {
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
    // A portal first mounts hidden for host placement; focus after that layout pass.
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, canSearch]);
  const toggle = () => { setQuery(''); setOpen(previous => !previous); };
  const choose = nextValue => {
    triggerRef.current?.focus({ preventScroll: true });
    setOpen(false);
    onChange?.({ target: { value: nextValue } });
  };
  const anchor = h('button', {
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
  }, h('span', { className: 'rh-select-value' }, selected?.label ?? placeholder), h(IconChevronDownOutlineRegular, { className: 'rh-select-chevron', 'aria-hidden': true }));
  return h(Menu, {
    open: open && !disabled, onClose: () => setOpen(false),
    anchor, items: filtered.map(({ title, ...item }) => ({ ...item, label: h('span', { title: title || labelText(item.label) }, item.label) })),
    selectedId: String(value ?? ''), onSelect: choose,
    portal: true, autoFocus: !canSearch, dense: true, align: 'start',
    className: `rh-select ${className}`.trim(),
    listClassName: `rh-select-menu${canSearch ? ' rh-select-menu-searchable' : ''}`,
  }, canSearch && h('div', { className: 'rh-select-search', role: 'presentation' },
    h('input', {
      ref: searchRef, type: 'search', value: query, placeholder: searchPlaceholder,
      'aria-label': `搜索${aria['aria-label'] || '选项'}`,
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
    h('span', { className: 'rh-select-count', role: 'status' }, needle ? `${filtered.length} / ${items.length} 项` : `共 ${items.length} 项`)
  ), !filtered.length && h('div', { className: 'rh-select-empty', role: 'status' }, '无匹配选项'));
}

module.exports = { Select };
