'use strict';

const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('./shared/HeaderBack.js');
const { useState, useEffect, useLayoutEffect, useRef } = React;

const { ROUTE, MARKED_SCRIPT_ID, MERMAID_SCRIPT_ID, HIGHLIGHT_SCRIPT_ID } = require('../constants.js');
const { useScript } = require('../hooks/useScript.js');
const { getMermaidTheme } = require('../utils/getMermaidTheme.js');
const { sanitizeHtml } = require('../utils/sanitizeHtml.js');
const { createIconComponents } = require('../icons.js');

const { IconLink } = createIconComponents(h);
const { Spinner } = require('./Spinner.js');

// ─── SkillPreview (Markdown + Mermaid) ───────────────
/**
 * @component
 * Renders a skill's Markdown content with Mermaid diagram and syntax highlighting support.
 * Fetches skill content from the server, parses Markdown using the marked library,
 * renders Mermaid diagrams, and applies code highlighting via highlight.js.
 * Includes a header with a back button and skill name/description.
 * @param {Object} props - Component props
 * @param {string} props.skillName - The name of the skill to load and display
 * @param {string} props.workspaceId - The workspace ID for fetching skill content
 * @param {Function} props.onBack - Callback invoked when the back button is clicked
 * @returns {JSX.Element}
 */
function SkillPreview({ skillName, workspaceId, onBack }) {
  const [text, setText] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState(null);
  const [rendered, setRendered] = useState('');
  const markdownRef = useRef(null);
  const mermaidInitRef = useRef(false);
  const mermaidRenderIdRef = useRef(0);

  const { loaded: markedLoaded } = useScript(
    'https://cdn.jsdelivr.net/npm/marked/marked.min.js', MARKED_SCRIPT_ID, 'marked',
  );
  const { loaded: mermaidLoaded } = useScript(
    'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js', MERMAID_SCRIPT_ID, 'mermaid',
  );
  const { loaded: hljsLoaded } = useScript(
    'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js', HIGHLIGHT_SCRIPT_ID, 'hljs',
  );

  useEffect(() => {
    if (!document.getElementById('req-hub-hljs-css')) {
      const link = document.createElement('link');
      link.id = 'req-hub-hljs-css';
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-dark.min.css';
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 获取 sessionId
        let sessionId = '';
        try {
          const ctx = window.__DSH_CTX__;
          if (ctx) {
            const uiWorkspace = ctx.get?.('uiWorkspace');
            if (uiWorkspace?.selection && typeof uiWorkspace.selection.getSnapshot === 'function') {
              const selection = uiWorkspace.selection.getSnapshot();
              if (selection?.sessionId) {
                sessionId = selection.sessionId;
              }
            }
          }
        } catch (e) {
          // 忽略错误
        }

        const url = sessionId
          ? `${ROUTE}/skill-content?name=${encodeURIComponent(skillName)}&workspaceId=${encodeURIComponent(workspaceId || '')}&sessionId=${encodeURIComponent(sessionId)}`
          : `${ROUTE}/skill-content?name=${encodeURIComponent(skillName)}&workspaceId=${encodeURIComponent(workspaceId || '')}`;

        const res = await fetch(url);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || 'load failed');
        else {
          setText(data.content || '');
          setDescription(data.description || '');
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [skillName, workspaceId]);

  useEffect(() => {
    if (mermaidLoaded && window.mermaid && !mermaidInitRef.current) {
      mermaidInitRef.current = true;
      window.mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme(), securityLevel: 'strict' });
    }
  }, [mermaidLoaded]);

  useEffect(() => {
    if (!mermaidInitRef.current || !window.mermaid || !rendered) return;
    const observer = new MutationObserver(() => {
      const newTheme = getMermaidTheme();
      window.mermaid.initialize({ startOnLoad: false, theme: newTheme, securityLevel: 'strict' });
      if (markdownRef.current) {
        markdownRef.current.querySelectorAll('.mermaid-diagram').forEach(div => {
          const code = div.getAttribute('data-mermaid-code');
          if (code) {
            const id = `mermaid-rerender-${Date.now()}-${Math.random()}`;
            window.mermaid.render(id, code).then(({ svg }) => { div.innerHTML = svg; }).catch(() => {});
          }
        });
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, [rendered]);

  useEffect(() => {
    if (!text) { setRendered(''); return; }
    if (markedLoaded && window.marked) {
      setRendered(sanitizeHtml(window.marked.parse(text)));
    }
  }, [text, markedLoaded]);

  useLayoutEffect(() => {
    if (!mermaidInitRef.current || !rendered || !markdownRef.current) return;
    const mermaidBlocks = markdownRef.current.querySelectorAll('code.language-mermaid');
    if (mermaidBlocks.length === 0) return;
    mermaidRenderIdRef.current++;
    const prefix = `mermaid-skill-${mermaidRenderIdRef.current}`;
    mermaidBlocks.forEach(async (block, index) => {
      const pre = block.parentElement;
      const code = block.textContent;
      const id = `${prefix}-${index}`;
      try {
        const { svg } = await window.mermaid.render(id, code);
        const div = document.createElement('div');
        div.className = 'mermaid-diagram';
        div.setAttribute('data-mermaid-code', code);
        div.innerHTML = svg;
        pre.replaceWith(div);
      } catch (e) { /* keep original */ }
    });
  }, [rendered]);

  useLayoutEffect(() => {
    if (!hljsLoaded || !window.hljs || !rendered || !markdownRef.current) return;
    const codeBlocks = markdownRef.current.querySelectorAll('pre code:not(.language-mermaid)');
    if (codeBlocks.length === 0) return;
    codeBlocks.forEach(block => {
      window.hljs.highlightElement(block);
    });
  }, [rendered, hljsLoaded]);

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--dsw-alias-bg-base)' } },
    // Header with back button
    h('div', { style: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)'
    }},
      h(HeaderBack, { onBack: onBack, label: '返回设置' }),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontWeight: 600, fontSize: 'var(--rh-font-size)', display: 'flex', alignItems: 'center', gap: 4 } }, h(IconLink, { size: 14 }), ` ${skillName}`),
        description && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, description)
      )
    ),
    // Content
    h('div', { className: 'rh-preview-body', style: { flex: 1, overflow: 'auto' } },
      error ? h('span', { className: 'rh-error' }, 'Error: ', error)
        : text
          ? (markedLoaded && rendered)
            ? h('div', { ref: markdownRef, className: 'rh-markdown', dangerouslySetInnerHTML: { __html: rendered } })
            : h(Spinner)
          : h(Spinner)
    )
  );
}

module.exports = { SkillPreview };
