// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { LogPanel } = require('../../src/client/components/LogPanel.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('keeps full structured output in a dismissible detail dialog instead of expanding log rows', async () => {
  const output = '完整日志内容'.repeat(3000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        String(url).endsWith('/meta')
          ? { levels: {}, tags: {} }
          : {
              logs: [
                {
                  timestamp: Date.now(),
                  level: 'info',
                  tag: 'startup',
                  message: 'Task finished',
                  data: { output },
                },
              ],
            },
    })),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(LogPanel)));
  expect(container.textContent).toContain('Task finished');
  expect(container.querySelector('pre')).toBeNull();
  const details = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === '查看完整记录',
  );
  details.focus();
  await act(async () => details.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(JSON.parse(dialog.querySelector('pre').textContent)).toEqual({ output });
  expect(container.contains(dialog)).toBe(false);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(details);
});
