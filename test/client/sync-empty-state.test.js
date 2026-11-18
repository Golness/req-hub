// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { SyncPanel } = require('../../src/client/components/SyncPanel.js');
const { DocsViewerContext } = require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('uses the same neutral empty state and a single header close action across custom and history tabs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ branches: [] }) })),
  );
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        DocsViewerContext.Provider,
        { value: {} },
        React.createElement(SyncPanel, { workspaceId: 'ws', selectedReq: null, onClose }),
      ),
    ),
  );
  let emptyMarkup;
  for (const id of ['custom', 'history']) {
    await act(async () => container.querySelector(`#sync-tab-${id}`).click());
    const panel = container.querySelector('[role="tabpanel"]:not([hidden])');
    const empty = panel.querySelector('.rh-empty-state');
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain('请选择需求目录');
    expect(empty.textContent).toContain('顶部');
    expect(panel.querySelector('[role="alert"], button')).toBeNull();
    if (emptyMarkup) {
      expect(empty.outerHTML).toBe(emptyMarkup);
    }
    emptyMarkup = empty.outerHTML;
    const close = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent.trim() === '关闭',
    );
    expect(close).toHaveLength(1);
    expect(close[0].closest('[role="tabpanel"]')).toBeNull();
    expect(close[0].dataset.rhButton).toBe('ghost');
  }
  const close = [...container.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === '关闭',
  );
  await act(async () => close.click());
  expect(onClose).toHaveBeenCalledOnce();
});
