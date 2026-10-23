'use strict';

const React = require('react');
const { createPortal } = require('react-dom');
const h = React.createElement;

function VersionSelect({ label, versions, value, onChange }) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const [position, setPosition] = React.useState(null);
  const triggerRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const searchRef = React.useRef({ text: '', time: 0 });
  const id = React.useId();
  const selected = versions.find(version => version.id === value);
  const versionIds = versions.map(version => version.id).join('\n');
  const versionName = version => (version.commitHash || version.id).slice(0, 8);
  const versionDate = version => {
    const date = new Date(version.completedAt || version.startedAt);
    return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
  };

  const show = (last = false) => {
    const index = versions.findIndex(version => version.id === value);
    setActive(index >= 0 ? index : last ? versions.length - 1 : 0);
    setOpen(true);
  };
  const choose = index => {
    if (!versions[index]) return;
    onChange(versions[index].id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  React.useEffect(() => { setOpen(false); }, [value, versionIds]);

  React.useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      const rect = triggerRef.current.getBoundingClientRect();
      const width = Math.min(rect.width, window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const upwards = below < 180 && above > below;
      setPosition({
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        maxHeight: Math.min(280, Math.max(0, (upwards ? above : below) - 6)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const dismiss = event => {
      if (!triggerRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);

  React.useEffect(() => {
    menuRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, !!position]);

  const onKeyDown = event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show(event.key === 'ArrowUp');
      else setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + versions.length) % versions.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active); else show();
      return;
    }
    if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault(); setActive(event.key === 'Home' ? 0 : versions.length - 1); return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = now - searchRef.current.time < 600 ? searchRef.current.text + event.key : event.key;
      searchRef.current = { text, time: now };
      const index = versions.findIndex(version => `${versionName(version)} ${versionDate(version)}`.toLowerCase().includes(text.toLowerCase()));
      if (index >= 0) { event.preventDefault(); setActive(index); setOpen(true); }
    }
  };

  return h('div', { className: 'rh-version-select' },
    h('span', { className: 'rh-version-label', id: `${id}-label` }, label),
    h('button', {
      ref: triggerRef, type: 'button', className: 'rh-version-trigger', role: 'combobox',
      'aria-labelledby': `${id}-label`, 'aria-expanded': open, 'aria-haspopup': 'listbox',
      'aria-controls': open ? `${id}-list` : undefined,
      'aria-activedescendant': open ? `${id}-option-${active}` : undefined,
      disabled: !versions.length, onClick: () => open ? setOpen(false) : show(), onKeyDown,
    },
      h('span', { className: 'rh-version-value' },
        h('span', { className: 'rh-version-name' }, selected ? versionName(selected) : '选择版本',
          selected === versions[0] && h('span', { className: 'rh-version-latest' }, '最新')
        ),
        selected && h('span', { className: 'rh-version-date' }, versionDate(selected))
      ),
      h('svg', { className: 'rh-version-chevron', width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true }, h('path', { d: 'm6 9 6 6 6-6', strokeLinecap: 'round', strokeLinejoin: 'round' }))
    ),
    open && position && createPortal(h('div', {
      ref: menuRef, id: `${id}-list`, role: 'listbox', 'aria-labelledby': `${id}-label`,
      className: 'rh-version-menu', style: position,
      onPointerDown: event => event.preventDefault(),
    }, versions.map((version, index) => h('div', {
      key: version.id, id: `${id}-option-${index}`, role: 'option',
      'aria-selected': version.id === value, 'data-index': index,
      className: `rh-version-option${index === active ? ' highlighted' : ''}`,
      onMouseMove: () => setActive(index), onClick: () => choose(index),
    },
      h('span', { className: 'rh-version-value' },
        h('span', { className: 'rh-version-name' }, versionName(version), index === 0 && h('span', { className: 'rh-version-latest' }, '最新')),
        h('span', { className: 'rh-version-date' }, versionDate(version))
      ),
      version.id === value && h('svg', { className: 'rh-version-check', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true }, h('path', { d: 'm5 12 4 4L19 6', strokeLinecap: 'round', strokeLinejoin: 'round' }))
    ))), document.body)
  );
}

module.exports = { VersionSelect };
