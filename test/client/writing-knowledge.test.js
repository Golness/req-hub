// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  React = require('react'),
  { act } = React;
const { createRoot } = require('react-dom/client');
const { WritingKnowledge } = require('../../src/client/components/WritingKnowledge.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, fetch, select;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  select = vi.fn();
  fetch = vi.fn(async () => ({ ok: true, json: async () => ({ items: [], hasWiki: true }) }));
  vi.stubGlobal('fetch', fetch);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(props = {}) {
  await act(async () =>
    root.render(
      React.createElement(WritingKnowledge, {
        workspaceId: 'ws',
        scopes: [
          { id: 'own', workspaceId: 'ws', title: 'Project' },
          { id: 'other', title: 'Other' },
        ],
        selected: ['own'],
        draft: '# Approval',
        evidence: [],
        onSelect: select,
        onClose() {},
        ...props,
      }),
    ),
  );
}
const button = (text) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === text);
it('keeps scope configuration collapsed and never silently selects another project', async () => {
  await render();
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  await act(async () => button('调整范围').click());
  expect([...container.querySelectorAll('input')].map((node) => node.checked)).toEqual([
    true,
    false,
  ]);
  await act(async () => container.querySelectorAll('input')[1].click());
  expect(select).toHaveBeenCalledWith(['own', 'other']);
  expect(container.textContent).not.toContain('GitNexus');
  expect(container.textContent).not.toContain('影响查询深度');
});
it('uses a button for draft checks without native markers or duplicate headings', async () => {
  await render();
  const toggle = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === '检查草稿展开',
  );
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('details')).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/enhancements/context'))).toBe(
    false,
  );
  await act(async () => toggle.click());
  const panel = document.getElementById(toggle.getAttribute('aria-controls'));
  expect(panel.hidden).toBe(false);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(
    [...panel.querySelectorAll('h3,h4,summary')].some((node) => node.textContent === '检查草稿'),
  ).toBe(false);
  const requests = () =>
    fetch.mock.calls.filter(([url]) => String(url).includes('/enhancements/context')).length;
  const initial = requests();
  expect(initial).toBe(1);
  await act(async () => toggle.click());
  expect(panel.hidden).toBe(true);
  await act(async () => toggle.click());
  expect(requests()).toBe(initial);
});
it('debounces suggestions, preserves scope boundaries and distinguishes unmatched Wiki from missing Wiki', async () => {
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(300));
  const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
  expect(JSON.parse(url.searchParams.get('scopeIds'))).toEqual(['own']);
  expect(container.textContent).toContain('暂无相关主题');
  const signal = fetch.mock.calls[0][1].signal;
  await render({ selected: [] });
  expect(signal.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(300));
  const last = new URL(fetch.mock.calls.at(-1)[0], 'http://localhost');
  expect(JSON.parse(last.searchParams.get('scopeIds'))).toEqual([]);
});
it('renders untrusted content as text and exposes actual citation versions', async () => {
  fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      items: [
        {
          id: 'wiki:page',
          pageId: 'page',
          scopeId: 'own',
          title: 'Approval',
          version: 3,
          summary: '<script>attack()</script>',
        },
      ],
    }),
  });
  await render({
    evidence: [
      {
        id: 'wiki:page',
        title: 'Approval',
        version: 3,
        sources: [{ relativePath: 'wiki/approval.md' }],
      },
    ],
  });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toContain('<script>attack()</script>');
  expect(container.textContent).toContain('本次引用 · 1');
  expect(container.textContent).toContain('wiki/approval.md');
});
