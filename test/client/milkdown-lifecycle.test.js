// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { Editor } from '@milkdown/core';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { MilkdownEditor } = require('../../src/client/components/MilkdownEditor.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('finishes and destroys an initializing editor when its page is closed immediately', async () => {
  const make = vi.spyOn(Editor, 'make');
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(React.createElement(MilkdownEditor, { content: '# Draft' })));
  const editor = make.mock.results[0].value;
  act(() => root.unmount());
  root = null;
  await vi.waitFor(() => expect(editor.status).toBe('Destroyed'));
  expect(document.querySelector('.ProseMirror')).toBeNull();
});
