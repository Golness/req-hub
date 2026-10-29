'use strict';
// Plugin-owned controls following DSH ui-primitives behavior and theme tokens.
// Source reference: deepseek-harness/packages/client/ui-primitives/src (MIT).
const React = require('react');
const { createPortal } = require('react-dom');
const css = require('./controls.module.css').default;
const h = React.createElement;
const join = (...names) => names.filter(Boolean).join(' ');

const Button = React.forwardRef(function Button({ variant = 'ghost', size = 'md', icon, children, className, ...props }, ref) {
  return h('button', { type: 'button', ...props, ref, className: join(css.button, css[variant], css[size], className), 'data-rh-button': variant, 'data-rh-size': size }, icon, children);
});
const Input = React.forwardRef(function Input({ icon, className, ...props }, ref) {
  return h('span', { className: join(css.inputWrap, className) }, icon, h('input', { ...props, ref, className: css.input }));
});
function Checkbox({ checked, onChange, label, disabled, title, className, indeterminate = false, 'aria-label': ariaLabel }) {
  return h('label', { className: join(css.checkbox, className), title }, h('input', { type: 'checkbox', checked, disabled, 'aria-label': ariaLabel, 'aria-checked': indeterminate ? 'mixed' : undefined, ref: node => { if (node) node.indeterminate = indeterminate; }, onChange: event => onChange?.(event.target.checked) }), h('span', null, label));
}

const modalStack = [];
const focusables = node => [...(node?.querySelectorAll('button,input,textarea,select,a[href],[tabindex]') || [])].filter(el => !el.disabled && el.tabIndex >= 0 && !el.hidden && !el.closest('[hidden],[inert]'));
function Modal({ open, title, onClose, className, children, role = 'dialog' }) {
  const dialog = React.useRef(null), close = React.useRef(onClose); close.current = onClose;
  React.useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement, owner = {};
    modalStack.push(owner);
    (dialog.current.querySelector('[data-modal-autofocus]') || focusables(dialog.current)[0] || dialog.current).focus();
    const key = event => {
      if (modalStack.at(-1) !== owner || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.(); }
      if (event.key === 'Tab') {
        const all = focusables(dialog.current), first = all[0], last = all.at(-1);
        if (!first) { event.preventDefault(); dialog.current.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); modalStack.splice(modalStack.indexOf(owner), 1); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  return open ? createPortal(h('div', { className: css.modalRoot, role: 'presentation' },
    h('div', { className: css.mask, 'aria-hidden': true, onClick: () => close.current?.() }),
    h('div', { ref: dialog, className: join(css.dialog, className), tabIndex: -1, role, 'aria-modal': true, 'aria-label': title }, children)), document.body) : null;
}

/** Viewport fitting is local; theme materials remain owned by DSH. */
function usePlacement(open, anchor, surface, gap = 4, anchorPoint) {
  const [position, setPosition] = React.useState({});
  React.useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!anchor.current || !surface.current) return;
      const rect = anchorPoint ? { left: anchorPoint.x, top: anchorPoint.y, bottom: anchorPoint.y } : anchor.current.getBoundingClientRect(), box = surface.current.getBoundingClientRect();
      const width = window.innerWidth, height = window.innerHeight;
      const inset = Math.max(12, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-overlay-top')) || 0);
      const top = height - rect.bottom - gap >= Math.min(box.height, 160) ? rect.bottom + gap : Math.max(inset, rect.top - box.height - gap);
      setPosition({ '--rh-overlay-left': Math.max(12, Math.min(rect.left, width - box.width - 12)) + 'px', '--rh-overlay-top': Math.min(top, height - 24) + 'px', '--rh-overlay-height': Math.max(40, height - top - 12) + 'px' });
    };
    update(); window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (surface.current) observer?.observe(surface.current);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); observer?.disconnect(); };
  }, [open, anchor, surface, gap, anchorPoint]);
  return position;
}

function Menu({ anchor, className, listClassName, children, open, items, selectedId, onSelect, onClose, autoFocus = true, anchorPoint, containerTag = 'span' }) {
  const trigger = React.useRef(null), list = React.useRef(null), close = React.useRef(onClose);
  close.current = onClose;
  const position = usePlacement(open, trigger, list, 4, anchorPoint);
  React.useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    if (autoFocus) (list.current.querySelector('[data-selected="true"]:not(:disabled)') || list.current.querySelector('[role="menuitem"]:not(:disabled)'))?.focus();
    const outside = event => { if (!list.current?.contains(event.target) && !trigger.current?.contains(event.target)) close.current?.(); };
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('pointerdown', outside); if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body || list.current?.contains(document.activeElement))) previous.focus(); };
  }, [open, autoFocus]);
  const keyboard = event => {
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.(); trigger.current?.focus(); return; }
    if (event.key === 'Tab') { close.current?.(); return; }
    const rows = [...list.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const inInput = /INPUT|TEXTAREA/.test(event.target.tagName);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !(inInput && ['Home', 'End'].includes(event.key))) {
      event.preventDefault(); event.stopPropagation();
      const index = rows.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus(); rows[next]?.scrollIntoView?.({ block: 'nearest' });
    } else if (!inInput && event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      rows.find(row => row.textContent.trim().toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))?.focus();
    } else if (!inInput && ['ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation();
  };
  return h(containerTag, { className }, React.cloneElement(anchor, { ref: node => { trigger.current = node; const ref = anchor.ref; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node; } }),
    open && createPortal(h('div', { ref: list, role: 'menu', className: join(css.menu, listClassName), style: position, onKeyDown: keyboard }, children,
      items.map(item => h('button', { key: item.id, type: 'button', role: 'menuitem', tabIndex: -1, disabled: item.disabled, 'data-value': item.id, 'data-selected': selectedId === item.id, 'aria-current': selectedId === item.id ? 'true' : undefined, onClick: () => onSelect(item.id) },
        h('span', { className: css.menuLabel }, item.label), selectedId === item.id && h('span', { className: css.selectedMark, 'aria-hidden': true })))), document.body));
}

function Popover({ anchor, open, onClose, label, className, children }) {
  const trigger = React.useRef(null), surface = React.useRef(null), close = React.useRef(onClose);
  close.current = onClose;
  const position = usePlacement(open, trigger, surface);
  React.useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    (surface.current.querySelector('[data-date-focus="true"]') || surface.current.querySelector('button'))?.focus();
    const outside = event => { if (!surface.current?.contains(event.target) && !trigger.current?.contains(event.target)) close.current?.(); };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body || surface.current?.contains(document.activeElement))) previous.focus();
    };
  }, [open]);
  return h('span', { className: css.popoverAnchor }, React.cloneElement(anchor, { ref: node => { trigger.current = node; } }),
    open && createPortal(h('div', { ref: surface, role: 'dialog', 'aria-label': label, className: join(css.popover, className), style: position,
      onKeyDown: event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.(); trigger.current?.focus(); }
        else if (event.key === 'Tab') close.current?.();
      },
    }, children), document.body));
}

function HoverCard({ anchor, content, className }) {
  const [open, setOpen] = React.useState(false), trigger = React.useRef(null), card = React.useRef(null);
  const id = React.useId(), position = usePlacement(open, trigger, card, 8);
  return h('span', { ref: trigger, className: join(css.hoverAnchor, className), onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false), onFocus: () => setOpen(true), onBlur: () => setOpen(false), onKeyDown: event => { if (event.key === 'Escape') setOpen(false); } },
    React.cloneElement(anchor, { 'aria-describedby': open ? id : anchor.props['aria-describedby'] }),
    open && createPortal(h('div', { ref: card, id, role: 'tooltip', className: css.hoverCard, style: position }, content), document.body));
}
function Tooltip({ children, label, className }) { return h(HoverCard, { anchor: children, content: label, className }); }
function Toast({ text, tone, icon, holdMs = 3000, actions, onDone }) {
  const done = React.useRef(onDone); done.current = onDone;
  React.useEffect(() => { const timer = setTimeout(() => done.current?.(), holdMs + 1000); return () => clearTimeout(timer); }, [holdMs]);
  return h('div', { className: css.toast, role: tone === 'error' ? 'alert' : 'status', 'data-rh-toast': true }, icon, h('span', null, text), actions?.map(action => h(Button, { key: action.label, size: 'sm', onClick: action.onClick }, action.label)));
}
module.exports = { Button, Input, Checkbox, Modal, Menu, Popover, HoverCard, Tooltip, Toast };
