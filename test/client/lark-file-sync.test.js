// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  React = require('react'),
  { act } = React;
const { createRoot } = require('react-dom/client');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const toastModule = require('../../src/client/components/shared/ToastContainer.js');
const showToast = vi.spyOn(toastModule, 'showToast').mockImplementation(() => {});
const { LarkFileSyncAction } = require('../../src/client/components/LarkFileSyncAction.js');

const PATH = '11-03 需求/requirement.md';
const remotePath = 'docs / 11-03 需求 / requirement.md';
let root;
let container;

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  container?.remove();
  root = null;
  vi.unstubAllGlobals();
  showToast.mockClear();
});

const api = (data, ok = true) => {
  const fetch = vi.fn(async () => ({ ok, json: async () => data }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
};
async function render(props = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(LarkFileSyncAction, {
        workspaceId: 'ws',
        path: PATH,
        name: 'requirement.md',
        ...props,
      }),
    ),
  );
}
const button = () =>
  [...document.querySelectorAll('button')].find((node) => node.textContent.includes('同步'));

it('renders one ghost action in the file header', async () => {
  api({ synced: true });
  await render();
  expect(button().textContent).toBe('同步到飞书');
  expect(button().disabled).toBe(false);
  expect(button().title).toContain('requirement.md');
});

it('posts the workspace and relative path and reports a new remote file', async () => {
  const fetch = api({ synced: true, action: 'created', path: remotePath });
  await render();
  await act(async () => button().click());
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('/req-hub/lark/file-sync');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({ workspaceId: 'ws', path: PATH });
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ tone: 'success', text: expect.stringContaining(remotePath) }),
  );
});

it('reports an overwrite of a same-named remote file', async () => {
  api({ synced: true, action: 'updated', path: remotePath });
  await render();
  await act(async () => button().click());
  expect(showToast.mock.calls[0][0].text).toContain('已更新飞书文件');
});

it('shows the localized reason when the workspace has no binding', async () => {
  api({ ready: false, code: 'LARK_TARGET_NOT_BOUND' }, false);
  await render();
  await act(async () => button().click());
  expect(showToast.mock.calls[0][0]).toMatchObject({
    tone: 'error',
    text: expect.stringContaining('尚未绑定飞书目录'),
  });
});

it('falls back to a generic message for an unknown error code', async () => {
  api({ ready: false, code: 'LARK_SOMETHING_NEW' }, false);
  await render();
  await act(async () => button().click());
  expect(showToast.mock.calls[0][0].text).toContain('同步到飞书失败');
});

it('blocks synchronization while the document is dirty', async () => {
  const fetch = api({ synced: true });
  await render({ dirty: true });
  expect(button().disabled).toBe(true);
  expect(button().title).toContain('请先保存文档');
  await act(async () => button().click());
  expect(fetch).not.toHaveBeenCalled();
});

it('reports a network failure instead of leaving the button busy', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  await render();
  await act(async () => button().click());
  expect(showToast.mock.calls[0][0].tone).toBe('error');
  expect(button().textContent).toBe('同步到飞书');
});
