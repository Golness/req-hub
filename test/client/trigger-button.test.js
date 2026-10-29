// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { TriggerButton } = require('../../src/client/components/TriggerButton.js');
let root, container, rect;
const viewport = { width: window.innerWidth, height: window.innerHeight };
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  rect = { left: 24, right: 360, top: 700, bottom: 742, width: 336, height: 42 };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.classList.contains('hoverCard')
      ? { left: 0, right: 240, top: 0, bottom: 200, width: 240, height: 200 }
      : rect;
  });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport.height });
});
async function open(wide = true) {
  await act(async () => root.render(React.createElement(TriggerButton, { wide, onClick: vi.fn() })));
  await act(async () => container.querySelector('button').focus());
  return document.querySelector('[role="tooltip"]');
}
it('anchors the summary to the right of the full footer row and keeps it inside the bottom edge', async () => {
  const card = await open();
  expect(container.querySelector('.row')).not.toBeNull();
  expect(card.parentElement).toBe(document.body);
  expect(card.style.getPropertyValue('--rh-overlay-left')).toBe('370px');
  expect(card.style.getPropertyValue('--rh-overlay-top')).toBe('588px');
  await act(async () => container.querySelector('button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
it('uses the same right-side placement for the collapsed rail', async () => {
  rect = { left: 24, right: 60, top: 700, bottom: 736, width: 36, height: 36 };
  const card = await open(false);
  expect(container.querySelector('.railRow .rail')).not.toBeNull();
  expect(container.querySelector('button').textContent).toBe('');
  expect(card.style.getPropertyValue('--rh-overlay-left')).toBe('70px');
});
it('shows requirement counts and distinguishes empty projects, missing paths and failed statistics', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => [
    { workspaceId: 'one', title: 'Project', projectPath: '/project', exists: true, requirementCount: 2, docCount: 99 },
    { workspaceId: 'empty', title: 'Empty', exists: true, requirementCount: 0 },
    { workspaceId: 'missing', title: 'Missing', exists: false, requirementCount: 0 },
    { workspaceId: 'error', title: 'Error', exists: true, requirementCount: null, errorCode: 'REQUIREMENT_STATS_UNAVAILABLE' },
  ] });
  const card = await open();
  expect(card.textContent).toContain('2 个需求目录');
  expect(card.textContent).toContain('0 个需求目录');
  expect(card.textContent).toContain('项目路径不可用');
  expect(card.textContent).toContain('统计失败');
  expect(card.textContent).not.toContain('99');
  expect(card.querySelector('[title="/project"]')).not.toBeNull();
});
it('flips left when the right side cannot fit and returns right after a viewport resize', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
  rect = { left: 300, right: 600, top: 400, bottom: 442, width: 300, height: 42 };
  const card = await open();
  expect(card.style.getPropertyValue('--rh-overlay-left')).toBe('50px');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  await act(async () => window.dispatchEvent(new Event('resize')));
  expect(card.style.getPropertyValue('--rh-overlay-left')).toBe('610px');
});
