// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { Editor, editorViewCtx } from '@milkdown/core';

const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { FilePreview } = require('../../src/client/components/FilePreview.js');
const { ToastContainer } = require('../../src/client/components/shared/ToastContainer.js');
const { act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('opens Markdown as editable preview, preserves drafts across views, and saves with Ctrl+S', async () => {
  const fetchMock = vi.fn(async (_url, options) => ({
    ok: true,
    json: async () => options?.method === 'POST' ? { success: true } : { text: '# Initial' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const makeSpy = vi.spyOn(Editor, 'make');
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(FilePreview, { workspaceId: 'ws', relPath: 'design.md', name: 'design.md', showToc: false }),
      React.createElement(ToastContainer)));
  });
  await act(async () => vi.waitFor(() => {
    expect(container.querySelector('.ProseMirror h1')?.textContent).toBe('Initial');
    expect(container.querySelector('.rh-milkdown-loading')).toBeNull();
  }));
  expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');
  expect(container.querySelector('[title="保存文件 (Ctrl+S)"]')).not.toBeNull();

  await act(async () => {
    makeSpy.mock.results[0].value.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText(' edited', 8));
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await act(async () => container.querySelector('[title="切换到只读预览"]').click());
  expect(container.querySelector('.ProseMirror')).toBeNull();
  expect(container.querySelector('.rh-preview-body').textContent).toContain('Initial edited');
  await act(async () => container.querySelector('[title="切换到可编辑预览"]').click());
  await act(async () => vi.waitFor(() => {
    expect(container.querySelector('.ProseMirror h1')?.textContent).toBe('Initial edited');
  }));
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })));
  const saveCall = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(JSON.parse(saveCall[1].body)).toEqual({ workspaceId: 'ws', path: 'design.md', content: '# Initial edited\n' });
  expect(container.querySelector('.rh-toast-success')?.textContent).toContain('文件已保存');
});

it('tracks editable Markdown scroll and navigates using the preview container coordinates', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ text: '# 第一章\n\n正文\n\n## 第二章\n\n正文\n\n## 第三章\n\n正文' }) })));
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(FilePreview, {
    workspaceId: 'ws', relPath: 'toc.md', name: 'toc.md', showToc: true,
  })));
  await act(async () => vi.waitFor(() => expect(container.querySelectorAll('.ProseMirror h1, .ProseMirror h2')).toHaveLength(3)));
  const body = container.querySelector('.rh-preview-body');
  Object.defineProperties(body, { clientHeight: { value: 300 }, scrollHeight: { value: 1200 } });
  body.getBoundingClientRect = () => ({ top: 100, bottom: 400 });
  container.querySelectorAll('.ProseMirror h1, .ProseMirror h2').forEach((heading, index) => {
    heading.getBoundingClientRect = () => ({ top: 140 + index * 400 - body.scrollTop });
  });
  const nav = container.querySelector('.rh-toc');
  nav.getBoundingClientRect = () => ({ top: 0, bottom: 200 });
  nav.querySelectorAll('button').forEach((button, index) => {
    button.getBoundingClientRect = () => ({ top: 8 + index * 150 - nav.scrollTop, bottom: 28 + index * 150 - nav.scrollTop });
  });
  const scrollTo = vi.fn(({ top }) => {
    body.scrollTop = top;
    body.dispatchEvent(new Event('scroll'));
  });
  body.scrollTo = scrollTo;
  expect(container.querySelector('.rh-milkdown-editor').style.overflow).toBe('visible');
  await act(async () => {
    body.scrollTop = 400;
    body.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  expect(nav.querySelector('[aria-current="location"]')?.textContent).toBe('第二章');
  await act(async () => {
    nav.querySelectorAll('button')[2].click();
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  expect(nav.querySelector('[aria-current="location"]')?.textContent).toBe('第三章');
  expect(scrollTo).toHaveBeenCalledWith({ top: 820, behavior: 'smooth' });
  expect(nav.scrollTop).toBeGreaterThan(0);
});
