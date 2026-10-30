// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { Disclosure } = require('../../src/client/components/shared/Disclosure.js');
const { JsonViewer } = require('../../src/client/components/JsonViewer.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let container;
afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  container?.remove();
  root = null;
});
async function render(element) {
  if (!root) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root.render(element));
}
it('defers initial mounting and retains inputs and focus when collapsed', async () => {
  const mounted = vi.fn();
  const disposed = vi.fn();
  function Content() {
    React.useEffect(() => {
      mounted();
      return disposed;
    }, []);
    return React.createElement('input', { defaultValue: 'draft' });
  }
  await render(
    React.createElement(Disclosure, { title: 'Checks', lazy: true }, React.createElement(Content)),
  );
  const trigger = container.querySelector('button');
  const content = container.querySelector('[data-rh-disclosure-content]');
  expect(container.querySelector('details, summary')).toBeNull();
  expect(trigger.type).toBe('button');
  expect(trigger.getAttribute('aria-controls')).toBe(content.id);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(mounted).not.toHaveBeenCalled();
  trigger.focus();
  await act(async () => trigger.click());
  const input = container.querySelector('input');
  input.value = 'unsaved draft';
  await act(async () => trigger.click());
  expect(content.hidden).toBe(true);
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  expect(content.hidden).toBe(false);
  expect(container.querySelector('input')).toBe(input);
  expect(input.value).toBe('unsaved draft');
  expect(mounted).toHaveBeenCalledOnce();
  expect(disposed).not.toHaveBeenCalled();
});
it('supports default-open and externally controlled state', async () => {
  await render(React.createElement(Disclosure, { title: 'History', defaultOpen: true }, 'result'));
  expect(container.querySelector('button').getAttribute('aria-expanded')).toBe('true');
  const onOpenChange = vi.fn();
  const element = (open) =>
    React.createElement(Disclosure, { title: 'History', open, onOpenChange }, 'result');
  await render(element(false));
  await act(async () => container.querySelector('button').click());
  expect(onOpenChange).toHaveBeenCalledWith(true);
  expect(container.querySelector('button').getAttribute('aria-expanded')).toBe('false');
  await render(element(true));
  expect(container.querySelector('[data-rh-disclosure-content]').hidden).toBe(false);
});
it('retains nested JSON expansion when the parent is collapsed', async () => {
  await render(React.createElement(JsonViewer, { data: { entries: [17] } }));
  const parent = container.querySelector('button');
  await act(async () => parent.click());
  const nested = container.querySelectorAll('button')[1];
  expect(nested.getAttribute('aria-expanded')).toBe('false');
  await act(async () => nested.click());
  expect(nested.getAttribute('aria-expanded')).toBe('true');
  await act(async () => parent.click());
  await act(async () => parent.click());
  expect(container.querySelectorAll('button')[1]).toBe(nested);
  expect(nested.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('details, summary, svg')).toBeNull();
});
