// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { FileTreeSidebar } = require('../../src/client/components/FileTreeSidebar.js');
const { act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const req = { id: '2026-10-22-orders', path: 'alice/2026-10-22-orders', title: '订单' };
const tree = [
  {
    type: 'directory',
    name: 'nested',
    path: 'nested',
    children: [
      { type: 'file', name: 'a.md', path: 'nested/a.md' },
      { type: 'file', name: 'b.json', path: 'nested/b.json' },
    ],
  },
];
const response = (data) => ({ ok: true, json: async () => data });
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(node) {
  await act(async () => root.render(node));
}
async function click(node) {
  await act(async () => node.click());
}

it('uses the same tree for preview and controlled multi-selection, including filtered directory selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ tree })));
  const preview = vi.fn();
  let selected = [];
  function App() {
    const [paths, setPaths] = React.useState(['bob/2026-10-22-other/old.md']);
    selected = paths;
    return React.createElement(FileTreeSidebar, {
      workspaceId: 'ws',
      selectedReq: req,
      onSelectFile: preview,
      multiSelect: true,
      selectedPaths: paths,
      onSelectionChange: setPaths,
    });
  }
  await render(React.createElement(App));
  await click(container.querySelector('.rh-tree-dir'));
  const a = container.querySelector('[aria-label="选择文件 nested/a.md"]');
  await click(a);
  expect(preview).not.toHaveBeenCalled();
  expect(selected).toContain(req.path + '/nested/a.md');
  expect(container.querySelector('[aria-label="选择目录 nested"]').indeterminate).toBe(true);
  await click(container.querySelector('.rh-tree-file'));
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({ path: req.path + '/nested/a.md' }),
  );
  expect(a.checked).toBe(true);
  await click(container.querySelector('.rh-filter-toggle'));
  await click(container.querySelector('[aria-label="文件类型"]'));
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'JSON'),
  );
  expect(container.textContent).toContain('不在当前筛选结果');
  await click(container.querySelector('[aria-label="选择目录 nested"]'));
  expect(selected).toEqual(
    expect.arrayContaining([
      req.path + '/nested/a.md',
      req.path + '/nested/b.json',
      'bob/2026-10-22-other/old.md',
    ]),
  );
});

it('leaves the view tree in single-preview mode without checkboxes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ tree })));
  await render(
    React.createElement(FileTreeSidebar, {
      workspaceId: 'ws',
      selectedReq: req,
      onSelectFile: vi.fn(),
    }),
  );
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(container.querySelector('.rh-knowledge-selection')).toBeNull();
});

it('does not apply a previous requirement tree after selection changes', async () => {
  let release;
  vi.stubGlobal(
    'fetch',
    vi.fn((url) =>
      url.includes('requirementId=old')
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(response({ tree })),
    ),
  );
  await render(
    React.createElement(FileTreeSidebar, {
      workspaceId: 'ws',
      selectedReq: { id: 'old', path: 'old' },
      onSelectFile: vi.fn(),
    }),
  );
  await render(
    React.createElement(FileTreeSidebar, {
      workspaceId: 'ws',
      selectedReq: req,
      onSelectFile: vi.fn(),
    }),
  );
  await act(async () =>
    release(response({ tree: [{ type: 'file', name: 'wrong.md', path: 'wrong.md' }] })),
  );
  expect(container.textContent).not.toContain('wrong.md');
  expect(container.textContent).toContain('nested');
});
