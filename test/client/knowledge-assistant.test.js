// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { useKnowledgeAssistant } = require('../../src/client/hooks/useKnowledgeAssistant.js');
const { KnowledgeAssistant } = require('../../src/client/components/shared/KnowledgeAssistant.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let container;
let width;
let observers;
const originalWindowWidth = window.innerWidth;
function Page({ active = true }) {
  const assistant = useKnowledgeAssistant(active);
  return React.createElement('main', { ref: assistant.ref },
    React.createElement('textarea', { defaultValue: 'Unsaved document', 'aria-label': 'Document' }),
    !assistant.pinned && React.createElement('button', { onClick: assistant.toggle }, 'Knowledge tools'),
    assistant.visible && React.createElement(KnowledgeAssistant, {
      title: 'Knowledge assistant', open: assistant.open, pinned: assistant.pinned, onClose: assistant.close,
    }, 'Scoped knowledge'),
  );
}
beforeEach(() => {
  width = 1000;
  observers = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600 }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; this.disconnect = vi.fn(); observers.push(this); }
    observe() {}
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWindowWidth });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
const click = node => act(async () => node.click());
const render = active => act(async () => root.render(React.createElement(Page, { active })));
async function resize(nextWidth) {
  width = nextWidth;
  await act(async () => observers.forEach(observer => observer.callback([])));
}
it('opens a drawer only on request in narrow content and restores focus without losing the draft', async () => {
  width = 799;
  await render(true);
  expect(document.querySelector('aside, [role="dialog"]')).toBeNull();
  const draft = container.querySelector('textarea');
  draft.value = 'Local edits';
  const trigger = button('Knowledge tools');
  trigger.focus();
  await click(trigger);
  expect(document.querySelector('[role="dialog"][aria-label="Knowledge assistant"]')).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(draft.value).toBe('Local edits');
});
it('opens and closes an inline sidebar for medium content even in a large window', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
  width = 800;
  await render(true);
  expect(container.querySelector('aside')).not.toBeNull();
  await click(button('Knowledge tools'));
  expect(container.querySelector('aside')).toBeNull();
  await click(button('Knowledge tools'));
  expect(container.querySelector('aside')).not.toBeNull();
  await click(button('收起'));
  expect(container.querySelector('aside')).toBeNull();
  await click(button('Knowledge tools'));
  expect(container.querySelector('aside')).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await resize(1199);
  expect(button('收起')).toBeDefined();
});
it('pins the sidebar at 1200px and switches presentation when its container is resized', async () => {
  width = 600;
  await render(true);
  await click(button('Knowledge tools'));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await resize(800);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('aside')).not.toBeNull();
  await click(button('收起'));
  await resize(1200);
  expect(container.querySelector('aside').dataset.rhAssistantPinned).toBe('true');
  expect(button('收起')).toBeUndefined();
  expect(button('Knowledge tools')).toBeUndefined();
  await resize(799);
  expect(document.querySelector('aside, [role="dialog"]')).toBeNull();
  expect(button('Knowledge tools')).toBeDefined();
});
it('closes inactive page drawers and releases its resize observer on unmount', async () => {
  width = 600;
  await render(true);
  await click(button('Knowledge tools'));
  await render(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await render(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => root.render(null));
  expect(observers.every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true);
});
