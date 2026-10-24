// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { Select } = require('../../src/client/components/shared/Select.js');
const { setupKeyboardShortcuts } = require('../../src/client/utils/keyboardShortcuts.js');
const { menus } = require('../fixtures/host-ui-primitives.cjs');
const h = React.createElement;
let root, container;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const render = async props => act(async () => root.render(h(Select, { id: 'picker', 'aria-label': '类型', value: 'a', ...props },
  h('option', { value: 'a' }, '需求文档'), h('option', { value: 'b', disabled: true }, '不可用'), h('option', { value: '' }, '空白'))));

it('uses host Menu with a selected check, real portal and focus restoration', async () => {
  const onChange = vi.fn(); await render({ onChange });
  const trigger = container.querySelector('button');
  expect(trigger.type).toBe('button'); expect(trigger.getAttribute('aria-label')).toBe('类型');
  expect(container.querySelector('select')).toBeNull();
  await act(async () => trigger.click());
  const host = menus.get('picker');
  expect(host).toMatchObject({ open: true, portal: true, autoFocus: true, selectedId: 'a', align: 'start' });
  expect(host.items[1].disabled).toBe(true);
  expect(document.querySelector('[role="menu"]').parentElement).toBe(document.body);
  await act(async () => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === '空白').click());
  expect(onChange).toHaveBeenCalledWith({ target: { value: '' } });
  expect(document.activeElement).toBe(trigger); expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
it('closes on disabled or changed choices and prevents empty selection menus', async () => {
  await render({});
  await act(async () => container.querySelector('button').click());
  await render({ disabled: true });
  expect(container.querySelector('button').disabled).toBe(true); expect(menus.get('picker').open).toBe(false);
  await render({ options: [] }); expect(container.querySelector('button').disabled).toBe(true);
  await render({ value: 'a' });
  await act(async () => container.querySelector('button').click());
  await render({ value: '' }); expect(menus.get('picker').open).toBe(false);
});
it('opens from arrow keys and leaves menu navigation and dismissal to DSH', async () => {
  await render({});
  const trigger = container.querySelector('button');
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  expect(menus.get('picker').open).toBe(true);
  await act(async () => menus.get('picker').onClose());
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});
it('does not turn a host menu Escape or arrow navigation into a plugin action', async () => {
  const closePanel = vi.fn(), collapseTree = vi.fn();
  const dispose = setupKeyboardShortcuts({ closePanel, collapseTree });
  try {
    await render({}); await act(async () => container.querySelector('button').click());
    const item = document.querySelector('[role="menuitem"]');
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); escape.preventDefault(); document.dispatchEvent(escape);
    expect(closePanel).not.toHaveBeenCalled(); expect(collapseTree).not.toHaveBeenCalled();
  } finally { dispose(); }
});

it('searches long lists case-insensitively, reports empty matches and resets on reopen', async () => {
  const onChange = vi.fn();
  const options = Array.from({ length: 40 }, (_, index) => ({ id: String(index), label: `Skill-${index}` }));
  await render({ options, value: '1', onChange });
  const trigger = container.querySelector('button');
  await act(async () => trigger.click());
  const host = menus.get('picker');
  expect(host).toMatchObject({ dense: true, autoFocus: false, listClassName: 'rh-select-menu rh-select-menu-searchable' });
  const input = document.querySelector('[type="search"]');
  await act(async () => vi.waitFor(() => expect(document.activeElement).toBe(input)));
  const search = async value => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await search('SKILL-39');
  expect(menus.get('picker').items.map(item => item.id)).toEqual(['39']);
  expect(document.querySelector('.rh-select-count').textContent).toBe('1 / 40 项');
  await search('不存在');
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  expect(document.querySelector('.rh-select-empty').textContent).toBe('无匹配选项');
  await search('skill-39');
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(onChange).toHaveBeenCalledWith({ target: { value: '39' } });
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  expect(document.querySelector('[type="search"]').value).toBe('');
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(40);
});

it('does not commit Chinese IME input and preserves input cursor keys', async () => {
  const onChange = vi.fn();
  await render({ searchable: true, onChange });
  await act(async () => container.querySelector('button').click());
  const input = document.querySelector('[type="search"]');
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  expect(onChange).not.toHaveBeenCalled();
  expect(menus.get('picker').open).toBe(true);
  const onHome = vi.fn(); document.addEventListener('keydown', onHome);
  try {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(onHome).not.toHaveBeenCalled();
  } finally { document.removeEventListener('keydown', onHome); }
});
