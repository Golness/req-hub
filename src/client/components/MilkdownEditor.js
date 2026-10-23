'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef } = React;
const { createMarkdownCodeBlockView } = require('./MarkdownCodeBlockView.js');

/**
 * @component MilkdownEditor
 * @description WYSIWYG Markdown editor powered by Milkdown.
 * Provides real-time editing with instant preview rendering.
 * @param {Object} props - Component props
 * @param {string} props.content - Initial Markdown content
 * @param {Function} props.onChange - Callback when content changes
 * @param {boolean} [props.readOnly=false] - Whether the editor is read-only
 * @returns {JSX.Element}
 */
function MilkdownEditor({ content, onChange, readOnly = false, mermaid = null }) {
  const editorRef = useRef(null);
  const milkdownRef = useRef(null);
  const propsRef = useRef({ content, onChange, readOnly, mermaid });
  propsRef.current = { content, onChange, readOnly, mermaid };
  const diagramRenderersRef = useRef(new Set());
  const markdownRef = useRef(content || '');
  const replaceAllRef = useRef(null);
  const editorViewCtxRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let editor = null;

    // Bundle official packages locally; no runtime CDN dependencies.
    const loadMilkdown = async () => {
      try {
        const {
          Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx, nodeViewCtx,
          commonmark, gfm, listener, listenerCtx, replaceAll,
        } = require('./MilkdownRuntime.mjs');

        if (cancelled) return;

        // Initialize editor
        replaceAllRef.current = replaceAll;
        editorViewCtxRef.current = editorViewCtx;
        markdownRef.current = propsRef.current.content || '';
        editor = Editor.make()
          .config((ctx) => {
            ctx.set(rootCtx, editorRef.current);
            ctx.set(defaultValueCtx, markdownRef.current);
            ctx.update(editorViewOptionsCtx, (options) => ({
              ...options,
              editable: () => !propsRef.current.readOnly,
            }));
            ctx.update(nodeViewCtx, (views) => views.concat([[
              'code_block',
              createMarkdownCodeBlockView(() => propsRef.current.mermaid, diagramRenderersRef.current),
            ]]));

            ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
              if (cancelled || markdown === markdownRef.current) return;
              markdownRef.current = markdown;
              if (!propsRef.current.readOnly && propsRef.current.onChange) {
                propsRef.current.onChange(markdown);
              }
            });
          })
          .use(commonmark)
          .use(gfm)
          .use(listener);

        await editor.create();

        if (cancelled) {
          await editor.destroy();
          return;
        }
        milkdownRef.current = editor;
        const latestContent = propsRef.current.content;
        if (latestContent !== undefined && latestContent !== markdownRef.current) {
          markdownRef.current = latestContent;
          editor.action(replaceAll(latestContent));
        }
        setLoading(false);
      } catch (e) {
        if (editor) await editor.destroy().catch(() => {});
        console.error('Failed to load Milkdown:', e);
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      }
    };

    loadMilkdown();

    return () => {
      cancelled = true;
      if (milkdownRef.current) {
        milkdownRef.current.destroy();
        milkdownRef.current = null;
      }
    };
  }, []);

  // Update content when prop changes (external updates)
  useEffect(() => {
    if (milkdownRef.current && content !== undefined && content !== markdownRef.current) {
      markdownRef.current = content;
      milkdownRef.current.action(replaceAllRef.current(content));
    }
  }, [content]);

  useEffect(() => {
    if (milkdownRef.current) {
      milkdownRef.current.action((ctx) => {
        ctx.get(editorViewCtxRef.current).setProps({
          editable: () => !propsRef.current.readOnly,
        });
      });
    }
  }, [readOnly]);

  useEffect(() => {
    diagramRenderersRef.current.forEach((render) => render());
  }, [mermaid]);

  // Keep the root mounted while the async editor is being created.
  const status = loading ? h('div', {
      className: 'rh-milkdown-loading',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 'var(--rh-font-size)',
      }
    }, '加载编辑器...') : error ? h('div', {
      className: 'rh-milkdown-error',
      style: {
        padding: 12,
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 'var(--rh-font-size)',
      }
    }, `编辑器加载失败：${error}`) : null;

  return h(React.Fragment, null, status, h('div', {
    ref: editorRef,
    className: 'rh-milkdown-editor',
    style: {
      minHeight: '100%',
      overflow: 'visible',
      display: loading || error ? 'none' : undefined,
    }
  }));
}

module.exports = { MilkdownEditor };
