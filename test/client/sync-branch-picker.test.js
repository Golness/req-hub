// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { SyncBranchPicker } = require('../../src/client/components/SyncBranchPicker.js');
const { act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const first = 'feature/alice/2026-11-02-orders';
const second = 'feature/bob/2026-11-02-orders';
let root, container, select, fetchMock;
const json = (data, ok = true) => ({ ok, json: async () => data });
const options = () => [...document.querySelectorAll('[role="option"]')];
function Fixture({ active = true, disabled = false, ...searchProps }) {
  const [value, setValue] = React.useState('');
  return React.createElement(SyncBranchPicker, {
    ...searchProps,
    workspaceId: 'ws',
    value,
    active,
    disabled,
    onChange: (name) => {
      select(name);
      setValue(name);
    },
  });
}
const render = async (props = {}) =>
  act(async () => root.render(React.createElement(Fixture, props)));
const input = () => container.querySelector('[role="combobox"]');
const search = async (value) =>
  act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input(),
      value,
    );
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
const loaded = async () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
const key = async (name) =>
  act(async () =>
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })),
  );
beforeEach(() => {
  vi.useFakeTimers();
  select = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () =>
    json({ branches: [first, second, 'main', 'feature/bob/2026-11-02-payments'] }),
  );
  vi.stubGlobal('fetch', fetchMock);
});
it('searches requirement files and commits only an explicit choice in reference mode', async () => {
  const pending = vi.fn();
  fetchMock.mockResolvedValue(
    json({ files: ['requirement.md', 'attachments/business.csv', 'design.md'] }),
  );
  await render({ kind: 'reference', requirementId: 'req', onPendingChange: pending });
  await search('business');
  await loaded();
  expect(options().map((node) => node.textContent)).toEqual(['attachments/business.csv']);
  expect(select).toHaveBeenLastCalledWith('');
  expect(pending).toHaveBeenLastCalledWith(true);
  const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
  expect(url.pathname).toBe('/req-hub/sync-design-references');
  expect(url.searchParams.get('workspaceId')).toBe('ws');
  expect(url.searchParams.get('requirementId')).toBe('req');
  await key('Enter');
  expect(select).toHaveBeenLastCalledWith('attachments/business.csv');
  expect(pending).toHaveBeenLastCalledWith(false);
  await search('');
  expect(select).toHaveBeenLastCalledWith('');
  expect(pending).toHaveBeenLastCalledWith(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('filters workspace matches and commits only a selected suggestion, clearing selection on edit', async () => {
  await render();
  await search('orders');
  await loaded();
  expect(options().map((node) => node.textContent)).toEqual([first, second]);
  expect(select).toHaveBeenLastCalledWith('');
  expect(fetchMock.mock.calls[0][0]).toContain('workspaceId=ws');
  await act(async () => options()[1].click());
  expect(select).toHaveBeenLastCalledWith(second);
  expect(input().value).toBe(second);
  expect(input().getAttribute('aria-expanded')).toBe('false');
  await search(first);
  expect(select).toHaveBeenLastCalledWith('');
});
it('keeps focus in the input and supports keyboard selection and dismissal', async () => {
  await render();
  await search('orders');
  await loaded();
  await key('ArrowDown');
  expect(document.activeElement).toBe(input());
  expect(document.getElementById(input().getAttribute('aria-activedescendant')).textContent).toBe(
    second,
  );
  await key('Enter');
  expect(select).toHaveBeenLastCalledWith(second);
  await search('orders');
  await loaded();
  await key('Escape');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(input());
});
it('ignores a stale search response after the query changes', async () => {
  let release;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await render();
  await search('orders');
  await loaded();
  await search('payments');
  await loaded();
  await act(async () => release(json({ branches: [first] })));
  expect(options().map((node) => node.textContent)).toEqual(['feature/bob/2026-11-02-payments']);
});
it('shows empty and failed results and supports retry without selecting text', async () => {
  await render();
  await search('no-such-branch');
  await loaded();
  expect(document.querySelector('[role="status"]').textContent).toBe('没有匹配的功能分支');
  fetchMock.mockImplementationOnce(async () => json({}, false));
  await search('orders');
  await loaded();
  expect(document.querySelector('[role="alert"]').textContent).toContain('分支加载失败');
  await act(async () =>
    [...document.querySelectorAll('button')].find((node) => node.textContent === '重试').click(),
  );
  await loaded();
  expect(options()).toHaveLength(2);
  expect(select).toHaveBeenLastCalledWith('');
});
it('closes the portaled suggestions when leaving the quick-sync tab', async () => {
  await render();
  await search('orders');
  await loaded();
  expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  await render({ active: false });
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});
