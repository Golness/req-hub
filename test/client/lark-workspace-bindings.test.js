// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { LarkWorkspaceBindings } = require('../../src/client/components/LarkWorkspaceBindings.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
const response = (data) => ({ ok: true, json: async () => data });
const items = [
  {
    id: 'alpha',
    title: 'Alpha',
    path: '/projects/alpha',
    revision: 'r1',
    bindingCurrent: true,
    binding: { kind: 'wiki', title: 'Alpha node', url: 'https://team.feishu.cn/wiki/Alpha' },
  },
  {
    id: 'beta',
    title: 'Beta',
    path: '/projects/beta',
    revision: 'r2',
    bindingCurrent: true,
    binding: {
      kind: 'folder',
      title: 'Beta folder',
      url: 'https://team.feishu.cn/drive/folder/Beta',
    },
  },
  { id: 'gamma', title: 'Gamma', path: '/projects/gamma', revision: null, binding: null },
];
async function render(fetcher, props = {}) {
  vi.stubGlobal('fetch', fetcher);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(React.createElement(LarkWorkspaceBindings, { revision: 'v1', ...props })),
  );
}
const click = async (node) => act(async () => node.click());

it('shows workspace, local directory, remote type and binding, and removes just one row', async () => {
  const removed = vi.fn();
  const fetcher = vi.fn(async (url) =>
    response(
      url.endsWith('target-list')
        ? { items }
        : {
            saved: true,
            binding: null,
            revision: null,
            defaultRevision: 'v2',
          },
    ),
  );
  await render(fetcher, { onRemoved: removed });
  expect(
    [...document.querySelectorAll('[role="columnheader"]')].map((node) => node.textContent),
  ).toEqual(['工作区', '本地目录', '已绑定的飞书目录', '操作']);
  const rows = [...document.querySelectorAll('[role="row"]')].slice(1);
  expect(rows[0].textContent).toContain('/projects/alpha');
  expect(rows[0].textContent).toContain('知识库 / Alpha node');
  expect(rows[0].textContent).not.toContain(items[0].binding.url);
  expect(rows[0].querySelector('[title="/projects/alpha"]')).not.toBeNull();
  expect(rows[0].querySelector('[title="https://team.feishu.cn/wiki/Alpha"]')).not.toBeNull();
  expect(rows[1].textContent).toContain('文件夹 / Beta folder');
  expect(rows[2].textContent).toContain('未绑定');
  expect(rows[2].querySelector('button')).toBeNull();
  await click(document.querySelector('[aria-label="解除 Beta 的绑定"]'));
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    workspaceId: 'beta',
    expectedRevision: 'r2',
  });
  expect(removed).toHaveBeenCalledWith('beta', expect.objectContaining({ defaultRevision: 'v2' }));
  expect(document.querySelector('[aria-label="解除 Alpha 的绑定"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="解除 Beta 的绑定"]')).toBeNull();
  expect(document.body.textContent).toContain('已解除 Beta 的绑定');
});

it('retains the binding on failure and retries the same removal instead of reloading', async () => {
  let attempt = 0;
  const fetcher = vi.fn(async (url) => {
    if (url.endsWith('target-list')) {
      return response({ items });
    }
    attempt++;
    return response(
      attempt === 1 ? { code: 'LARK_TARGET_FAILED' } : { saved: true, binding: null },
    );
  });
  await render(fetcher);
  await click(document.querySelector('[aria-label="解除 Alpha 的绑定"]'));
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="解除 Alpha 的绑定"]')).not.toBeNull();
  await click([...document.querySelectorAll('button')].find((node) => node.textContent === '重试'));
  expect(attempt).toBe(2);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('target-list'))).toHaveLength(1);
  expect(document.querySelector('[aria-label="解除 Alpha 的绑定"]')).toBeNull();
});

it('cancels row removal on unmount and does not deliver a late success callback', async () => {
  let finish;
  let signal;
  const removed = vi.fn();
  await render(
    vi.fn(async (url, options) => {
      if (url.endsWith('target-list')) {
        return response({ items });
      }
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
    { onRemoved: removed },
  );
  await click(document.querySelector('[aria-label="解除 Alpha 的绑定"]'));
  await act(async () => root.unmount());
  root = null;
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response({ saved: true, binding: null })));
  expect(removed).not.toHaveBeenCalled();
});
