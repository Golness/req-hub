// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const clock = require('../../src/client/time.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  root = null;
  clock.setTimeZone('Asia/Shanghai');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('updates already-mounted displays after the saved general clock changes', async () => {
  function Clock() {
    clock.useTimeZone();
    return React.createElement('time', null, clock.formatDateTime('2026-11-06T03:41:54.757Z'));
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(Clock)));
  expect(container.textContent).toBe('2026-11-06 11:41:54');
  await act(async () => clock.setTimeZone('America/New_York'));
  expect(container.textContent).toBe('2026-11-05 22:41:54');
});

it('updates an open snapshot comparison label when the general zone changes', async () => {
  const { DiffReviewPage } = require('../../src/client/components/shared/DiffReviewPage.js');
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(DiffReviewPage, {
        oldContent: '',
        newContent: '',
        oldVersion: { label: 'Version', startedAt: '2026-11-06T03:41:54Z' },
      }),
    ),
  );
  expect(container.textContent).toContain('Version · 2026-11-06 11:41:54');
  await act(async () => clock.setTimeZone('UTC'));
  expect(container.textContent).toContain('Version · 2026-11-06 03:41:54');
});

it('does not overwrite a newly saved clock with a late startup response', async () => {
  let finish;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const dispose = clock.installTimeZone();
  clock.setTimeZone('UTC');
  finish({ ok: true, json: async () => ({ general: { timeZone: 'Asia/Tokyo' } }) });
  await act(async () => {});
  expect(clock.formatTime('2026-11-06T03:41:54Z')).toBe('03:41:54');
  await dispose();
});

it('cancels startup loading on unload and ignores its late result', async () => {
  let finish;
  const fetcher = vi.fn(
    (_url, options) =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const dispose = clock.installTimeZone();
  const disposing = dispose();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  finish({ ok: true, json: async () => ({ general: { timeZone: 'UTC' } }) });
  await act(async () => {});
  await disposing;
  expect(clock.formatTime('2026-11-06T03:41:54Z')).toBe('11:41:54');
});
