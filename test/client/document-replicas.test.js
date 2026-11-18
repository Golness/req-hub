// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const {
  DocumentReplicaSettings,
} = require('../../src/client/components/DocumentReplicaSettings.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
const response = (data, ok = true) => ({ ok, json: async () => data });
const button = (name) =>
  [...document.querySelectorAll('button')].find((item) => item.textContent === name);

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function render(fetcher) {
  vi.stubGlobal('fetch', fetcher);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(React.createElement(DocumentReplicaSettings, { workspaceId: 'ws' })),
  );
}

it('requires a user save for automatic publication and preserves the draft after failure', async () => {
  const fetcher = vi.fn(async (url, options) => {
    if (String(url).includes('/documents/status')) {
      return response({ items: [], nextOffset: null });
    }
    if (options?.method === 'POST') {
      return response({ error: 'CONFIG_CONFLICT' }, false);
    }
    return response({ _revision: 'revision', documents: { larkSyncEnabled: false } });
  });
  await render(fetcher);
  const input = document.querySelector('input[type=checkbox]');
  await act(async () => input.click());
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  await act(async () => button('保存').click());
  expect(input.checked).toBe(true);
  expect(document.querySelector('[role=alert]').textContent).toContain('CONFIG_CONFLICT');
  expect(
    JSON.parse(fetcher.mock.calls.find(([, options]) => options?.method === 'POST')[1].body),
  ).toEqual({ _revision: 'revision', documents: { larkSyncEnabled: true } });
});

it('retries only the failed target and never calls generation or conversation refresh', async () => {
  const fetcher = vi.fn(async (url) => {
    if (String(url).endsWith('/config')) {
      return response({ documents: { larkSyncEnabled: true } });
    }
    if (String(url).endsWith('/documents/retry')) {
      return response({ queued: true });
    }
    return response({
      items: [
        { path: 'failed.bin', status: 'failed', error: 'LARK_TARGET_NOT_BOUND' },
        { path: 'uncertain.md', status: 'uncertain' },
      ],
      nextOffset: null,
    });
  });
  await render(fetcher);
  expect(document.body.textContent).toContain('待核实');
  expect(
    [...document.querySelectorAll('button')].filter((item) => item.textContent === '重试飞书同步'),
  ).toHaveLength(1);
  await act(async () => button('重试飞书同步').click());
  const writes = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(String(writes[0][0])).toContain('/documents/retry');
  expect(JSON.parse(writes[0][1].body)).toEqual({ workspaceId: 'ws', path: 'failed.bin' });
});
