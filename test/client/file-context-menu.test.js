// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { it, expect, afterEach, vi } from 'vitest';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { FileTreeSidebar } = require('../../src/client/components/FileTreeSidebar.js');
const { ToastContainer } = require('../../src/client/components/shared/ToastContainer.js');
let root, container;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const absolutePath = 'D:\\project\\dms-system\\docs\\lihanping\\2026-10-28-ST-TPM\\requirement.md';
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); });
async function render(writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tree: [{ type: 'file', path: 'requirement.md', name: 'requirement.md', absolutePath }] }) })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const select = vi.fn();
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(FileTreeSidebar, { workspaceId: 'w', selectedReq: { id: '2026-10-28-ST-TPM', path: 'lihanping/2026-10-28-ST-TPM' }, onSelectFile: select }), React.createElement(ToastContainer))));
  return { row: container.querySelector('.rh-tree-file'), select, writeText };
}
it('copies the Host-provided absolute file path through a right-click menu without opening the file', async () => {
  const { row, select, writeText } = await render();
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })));
  const menu = document.querySelector('[role=menu]'); expect(menu.parentElement).toBe(document.body);
  expect(menu.textContent).toContain('复制文件路径');
  await act(async () => menu.querySelector('[role=menuitem]').click());
  expect(writeText).toHaveBeenCalledWith(absolutePath); expect(select).not.toHaveBeenCalled();
  expect(document.querySelector('[role=menu]')).toBeNull(); expect(document.body.textContent).toContain('文件路径已复制');
});
it('supports the keyboard context menu and Escape with focus restored to the file', async () => {
  const { row } = await render();
  await act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })); });
  expect(document.activeElement.getAttribute('role')).toBe('menuitem');
  await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role=menu]')).toBeNull(); expect(document.activeElement).toBe(row);
});
it('reports denied clipboard writes as failures', async () => {
  const { row } = await render(vi.fn().mockRejectedValue(new Error('denied')));
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await act(async () => document.querySelector('[role=menuitem]').click());
  expect(document.body.textContent).toContain('复制失败'); expect(document.body.textContent).not.toContain('文件路径已复制');
});
