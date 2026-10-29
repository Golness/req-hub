'use strict';
const { t } = require('../locale.js');
const css = require('./MilkdownEditor.module.css').default;

const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef } = React;
const { imageNodeView } = require('../utils/markdownImages.js');
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
function MilkdownEditor({ content, onChange, readOnly = false, mermaid = null, imageContext = null }) {
  const editorRef = useRef(null);
  const milkdownRef = useRef(null);
  const propsRef = useRef({ content, onChange, readOnly, mermaid, imageContext });
  propsRef.current = { content, onChange, readOnly, mermaid, imageContext };
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
            ], ['image', node => imageNodeView(node, () => propsRef.current.imageContext)]]));

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
      className: ('rh-milkdown-loading') + ' ' + css.row
    }, t("MilkdownEditor.message001")) : error ? h('div', {
      className: ('rh-milkdown-error') + ' ' + css.section
    }, t("MilkdownEditor.message002", { value0: error })) : null;

  return h(React.Fragment, null, status, h('div', {
    ref: editorRef,
    className: ('rh-milkdown-editor') + ' ' + css.pane,
    hidden: loading || !!error,
  }));
}

module.exports = { MilkdownEditor };
