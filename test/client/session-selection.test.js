// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const {
  SessionSelectionStoreContext,
  SessionSelectionContext,
} = require('../../src/client/context.js');
const { SkillPreview } = require('../../src/client/components/SkillPreview.js');
const { useRequirementLocator } = require('../../src/client/hooks/useRequirementLocator.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('cancels requirement location when the selected session changes before it resolves', async () => {
  let session = 'first';
  const listeners = new Set();
  const store = {
    getSnapshot: () => session,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let finish;
  const fetch = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const workspaces = [{ id: 'ws', path: '/repo' }];
  let locate;
  function Probe() {
    locate = useRequirementLocator(workspaces);
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        SessionSelectionStoreContext.Provider,
        { value: store },
        React.createElement(
          SessionSelectionContext.Provider,
          { value: store.getSnapshot },
          React.createElement(Probe),
        ),
      ),
    ),
  );
  const result = locate();
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await act(async () => {
    session = 'second';
    listeners.forEach((listener) => listener());
  });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  finish({ ok: true, json: async () => ({ session: { cwd: '/repo' } }) });
  await assertion;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('reloads selected-session resources, aborts stale reads and releases subscriptions', async () => {
  let session = 'first';
  const listeners = new Set();
  const store = {
    getSnapshot: () => session,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  let finishOld;
  const fetch = vi.fn(async (url) => {
    if (url.includes('sessionId=first')) {
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    }
    return { ok: true, json: async () => ({ content: 'new source' }) };
  });
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        SessionSelectionStoreContext.Provider,
        { value: store },
        React.createElement(SkillPreview, { skillName: 'example', workspaceId: 'ws' }),
      ),
    ),
  );
  expect(fetch.mock.calls[0][0]).toContain('sessionId=first');
  expect(document.querySelector('#req-hub-hljs-css')).toBeNull();
  await act(async () => {
    session = 'second';
    listeners.forEach((listener) => listener());
  });
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(fetch.mock.calls[1][0]).toContain('sessionId=second');
  await act(async () => finishOld({ ok: true, json: async () => ({ content: 'old source' }) }));
  await act(async () => root.unmount());
  root = null;
  expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
  expect(listeners.size).toBe(0);
  expect(document.querySelector('#req-hub-hljs-css')).toBeNull();
});
