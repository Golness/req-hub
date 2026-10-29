// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { it, expect, afterEach, vi } from 'vitest';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { DatePicker } = require('../../src/client/components/shared/DatePicker.js');
let root, container;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); });
async function render(value = '2024-02-29', props = {}) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const onChange = vi.fn();
  await act(async () => root.render(React.createElement(DatePicker, { id: 'date', value, label: '日期', onChange, ...props })));
  return onChange;
}
const click = async node => act(async () => node.click());
const key = async value => act(async () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));
it('uses the themed calendar portal and selects an exact leap-day date without a native date input', async () => {
  const onChange = await render(); await click(document.getElementById('date'));
  expect(document.querySelector('input[type=date]')).toBeNull();
  expect(document.querySelector('[role=dialog]').parentElement).toBe(document.body);
  expect(document.activeElement.getAttribute('aria-label')).toBe('2024-02-29');
  await click(document.querySelector('[aria-label="2024-02-28"]'));
  expect(onChange).toHaveBeenCalledWith({ target: { value: '2024-02-28' } });
  expect(document.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement.id).toBe('date');
});
it('moves across months by keyboard, clamps leap dates and restores focus on Escape', async () => {
  await render(); await click(document.getElementById('date')); await key('ArrowRight');
  expect(document.activeElement.getAttribute('aria-label')).toBe('2024-03-01');
  await key('PageUp'); expect(document.activeElement.getAttribute('aria-label')).toBe('2024-02-01');
  await key('Escape'); expect(document.querySelector('[role=dialog]')).toBeNull(); expect(document.activeElement.id).toBe('date');
});
it('dismisses outside and honors disabled controls', async () => {
  await render(); await click(document.getElementById('date'));
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(document.querySelector('[role=dialog]')).toBeNull();
  await act(async () => root.render(React.createElement(DatePicker, { id: 'date', value: '2024-02-29', label: '日期', disabled: true })));
  await click(document.getElementById('date')); expect(document.querySelector('[role=dialog]')).toBeNull();
});
it('preserves uppercase ST and TPM in both the directory title and generated branch', async () => {
  const { CreateDirForm } = require('../../src/client/components/CreateDirForm.js');
  const branch = 'feature/lihanping/2026-10-28-支持ST为0的门店和多个TPM';
  const created = [];
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url.includes('/create-status')) return { ok: true, json: async () => ({ branch, existingRequirement: null }) };
    created.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ path: 'docs/lihanping/2026-10-28-支持ST为0的门店和多个TPM' }) };
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(React.createElement(CreateDirForm, { workspaceId: 'w', docsDir: 'docs', initialCreateBranch: true })));
  await click([...container.querySelectorAll('button')].find(node => node.textContent.trim() === '创建'));
  await click([...document.querySelectorAll('[role=alertdialog] button')].find(node => node.textContent === '确认创建'));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ title: '支持ST为0的门店和多个TPM', branchName: branch, createBranch: true });
});
