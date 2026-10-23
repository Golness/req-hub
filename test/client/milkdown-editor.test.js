// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Editor, editorViewCtx } from '@milkdown/core';

const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { MilkdownEditor } = require('../../src/client/components/MilkdownEditor.js');
const { act } = React;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('Milkdown editor integration', () => {
  let container;
  let root;
  let createSpy;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    createSpy = vi.spyOn(Editor, 'make');
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 250));
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(props) {
    await act(async () => root.render(React.createElement(MilkdownEditor, props)));
  }

  async function waitForEditor() {
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('.ProseMirror')).not.toBeNull();
        expect(container.querySelector('.rh-milkdown-loading')).toBeNull();
      });
    });
    return createSpy.mock.results[0].value;
  }

  it('mounts inside its root, reports edits, and applies external content without an echo', async () => {
    const onChange = vi.fn();
    await render({ content: '# Initial', onChange });
    const editor = await waitForEditor();
    expect(container.querySelector('.rh-milkdown-editor .milkdown h1').textContent).toBe('Initial');
    expect(document.querySelectorAll('.milkdown')).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.insertText(' edited', 8));
      });
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('# Initial edited\n'));
    });

    onChange.mockClear();
    await render({ content: '# External\n', onChange });
    expect(container.querySelector('h1').textContent).toBe('External');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses the latest callback and updates the read-only DOM state', async () => {
    const oldCallback = vi.fn();
    const onChange = vi.fn();
    await render({ content: 'Text', onChange: oldCallback, readOnly: true });
    const editor = await waitForEditor();
    expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('false');

    await render({ content: 'Text', onChange, readOnly: false });
    expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');
    await act(async () => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.insertText('!', 5));
      });
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('Text!\n'));
    });
    expect(oldCallback).not.toHaveBeenCalled();
  });

  it('renders GFM tables, tasks and strikethrough while allowing edits inside table cells', async () => {
    const onChange = vi.fn();
    await render({
      content: '# 方案\n\n| 字段 | 类型 |\n| --- | --- |\n| title | string |\n\n- [x] 完成\n\n~~删除线~~',
      onChange,
    });
    const editor = await waitForEditor();
    expect(container.querySelectorAll('table th')).toHaveLength(2);
    expect(container.querySelectorAll('table td')).toHaveLength(2);
    expect(container.querySelector('table td').textContent).toBe('title');
    expect(container.querySelector('li[data-checked="true"]')).not.toBeNull();
    expect(container.querySelector('del, s').textContent).toBe('删除线');
    expect(container.querySelector('.ProseMirror').getAttribute('contenteditable')).toBe('true');

    await act(async () => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.state.doc.descendants((node, pos) => {
          if (node.isText && node.text === 'title') {
            view.dispatch(view.state.tr.insertText('name', pos, pos + node.nodeSize));
          }
        });
      });
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    });
    expect(container.querySelector('table td').textContent).toBe('name');
    const markdown = onChange.mock.lastCall[0];
    expect(markdown).toMatch(/\| name\s*\| string\s*\|/);
    expect(markdown).toContain('[x] 完成');
    expect(markdown).toContain('~~删除线~~');
    expect(markdown).not.toContain('<table');
  });

  it('renders Mermaid as a diagram, updates it from editable source, and saves Markdown fences', async () => {
    const onChange = vi.fn();
    const content = '```mermaid\ngraph LR\nA-->B\n```';
    await render({ content, onChange });
    const editor = await waitForEditor();
    const mermaid = { render: vi.fn(async (_id, code) => ({ svg: `<svg><text>${code}</text></svg>` })) };
    await render({ content, onChange, mermaid });
    await vi.waitFor(() => expect(container.querySelector('.rh-mermaid-preview svg')).not.toBeNull());
    expect(container.querySelector('.rh-editable-mermaid details').open).toBe(false);
    expect(container.querySelector('.rh-editable-mermaid code').textContent).toContain('A-->B');

    await act(async () => {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.state.doc.descendants((node, pos) => {
          if (node.type.name === 'code_block') {
            view.dispatch(view.state.tr.insertText('graph LR\nA-->C', pos + 1, pos + node.nodeSize - 1));
          }
        });
      });
      await vi.waitFor(() => expect(container.querySelector('.rh-mermaid-preview svg').textContent).toContain('A-->C'));
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    });
    expect(onChange.mock.lastCall[0]).toContain('```mermaid\ngraph LR\nA-->C\n```');
    expect(onChange.mock.lastCall[0]).not.toContain('<svg');
  });

  it('destroys an editor that finishes creating after unmount', async () => {
    createSpy.mockRestore();
    const make = Editor.make;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let destroySpy;
    createSpy = vi.spyOn(Editor, 'make').mockImplementation(() => {
      const editor = make();
      const create = editor.create;
      vi.spyOn(editor, 'create').mockImplementation(async () => {
        await pending;
        return create();
      });
      destroySpy = vi.spyOn(editor, 'destroy');
      return editor;
    });
    await render({ content: 'Pending' });
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalled());
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      release();
      await vi.waitFor(() => expect(destroySpy).toHaveBeenCalled());
    });
    expect(document.querySelector('.milkdown')).toBeNull();
  });
});
