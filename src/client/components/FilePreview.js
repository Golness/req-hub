'use strict';

const React = require('react');
const { createPortal } = require('react-dom');
const h = React.createElement;
const { useState, useEffect, useLayoutEffect, useRef, useMemo } = React;

const { ROUTE, MARKED_SCRIPT_ID, MERMAID_SCRIPT_ID, HIGHLIGHT_SCRIPT_ID } = require('../constants.js');
const { useScript } = require('../hooks/useScript.js');
const { getMermaidTheme } = require('../utils/getMermaidTheme.js');
const { sanitizeHtml } = require('../utils/sanitizeHtml.js');
const { getDocIcon } = require('../utils/getDocIcon.js');
const { createIconComponents } = require('../icons.js');
const { TableOfContents, extractHeadings } = require('./shared/TableOfContents.js');
const { Skeleton } = require('./shared/Skeleton.js');
const { JsonViewer } = require('./JsonViewer.js');
const { MilkdownEditor } = require('./MilkdownEditor.js');
const { showToast } = require('./shared/ToastContainer.js');

const { IconClipboard, IconDesign, IconSearch, IconFile, IconEye, IconEdit, IconSave } = createIconComponents(h);

/**
 * @component FilePreview
 * @description Component for previewing document files including Markdown (with Mermaid diagrams and
 * syntax highlighting), HTML (in iframe), and plain text. Features breadcrumb navigation,
 * table of contents sidebar for Markdown files, and scroll spy for active heading tracking.
 * Covers features 2.4, 2.5, 2.12, 2.13.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The unique identifier of the workspace
 * @param {string} props.relPath - The relative path to the file within the workspace
 * @param {string} props.name - The filename being previewed
 * @param {Object|null} props.requirement - The requirement object containing title, date, and type
 * @param {Function} props.onBack - Callback invoked to navigate back from the preview
 * @param {boolean} props.showToc - Whether to show table of contents
 * @param {Function} props.onToggleToc - Callback to toggle table of contents visibility
 * @param {HTMLElement|null} [props.toolbarTarget] - Header container following the breadcrumb
 * @returns {JSX.Element} A file preview with header, content area, and optional TOC sidebar
 */
function FilePreview({ workspaceId, relPath, name, requirement, onBack, showToc, onToggleToc, toolbarTarget }) {
  const [text, setText] = useState('');
  const [formattedText, setFormattedText] = useState('');
  const [error, setError] = useState(null);
  const [rendered, setRendered] = useState('');
  const [activeHeadingId, setActiveHeadingId] = useState(null);
  const [tocWidth, setTocWidth] = useState(200);
  const [editMode, setEditMode] = useState(() => /\.md$/i.test(name));
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const markdownRef = useRef(null);
  const previewBodyRef = useRef(null);
  const mermaidInitRef = useRef(false);
  const mermaidRenderIdRef = useRef(0);
  const isResizingRef = useRef(false);
  const isHtml = /\.html?$/i.test(name);
  const isMd = /\.md$/i.test(name);
  const isJson = /\.json$/i.test(name);
  const isEditable = /\.(md|txt|text|json)$/i.test(name);

  const { loaded: markedLoaded } = useScript(
    'https://cdn.jsdelivr.net/npm/marked/marked.min.js', MARKED_SCRIPT_ID, 'marked',
  );
  const { loaded: mermaidLoaded } = useScript(
    'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js', MERMAID_SCRIPT_ID, 'mermaid',
  );
  // 2.13: Code syntax highlighting via highlight.js
  const { loaded: hljsLoaded } = useScript(
    'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js', HIGHLIGHT_SCRIPT_ID, 'hljs',
  );
  // Load highlight.js CSS
  useEffect(() => {
    if (!document.getElementById('req-hub-hljs-css')) {
      const link = document.createElement('link');
      link.id = 'req-hub-hljs-css';
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-dark.min.css';
      document.head.appendChild(link);
    }
  }, []);

  // Initialize the draft from file content; switching views must preserve edits.
  useEffect(() => {
    setEditContent(text);
  }, [text]);

  // Save handler
  const handleSave = async () => {
    if (!isEditable) return;

    setSaving(true);
    try {
      const res = await fetch(`${ROUTE}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          path: relPath,
          content: editContent,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setText(editContent);
        setLastSaved(new Date());
        showToast({ tone: 'success', text: '文件已保存', holdMs: 2000 });
      } else {
        showToast({ tone: 'error', text: data.error || '保存失败', holdMs: 3000 });
      }
    } catch (e) {
      showToast({ tone: 'error', text: '保存请求失败', holdMs: 3000 });
    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcut: Ctrl+S to save
  useEffect(() => {
    if (!editMode) return;
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [editMode, editContent]);

  useEffect(() => {
    if (!isJson || !text) { setFormattedText(''); return; }
    try {
      const parsed = JSON.parse(text);
      setFormattedText(JSON.stringify(parsed, null, 2));
    } catch {
      setFormattedText(text);
    }
  }, [text, isJson]);

  useEffect(() => {
    let cancelled = false;
    setEditMode(isMd);
    setError(null);
    setLastSaved(null);
    (async () => {
      try {
        const url = `${ROUTE}/read?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(relPath)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || 'read failed');
        else setText(data.text || '');
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, relPath, isMd]);

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
    if (!isMd || !editContent) { setRendered(''); return; }
    if (markedLoaded && window.marked) {
      // Parse markdown and add IDs to headings for TOC navigation
      const html = window.marked.parse(editContent);
      // Add IDs to heading elements (use heading index as stable fallback)
      let headingIndex = 0;
      const withIds = html.replace(/<h([1-6])>(.*?)<\/h[1-6]>/g, (match, level, content) => {
        const plainText = content.replace(/<[^>]+>/g, '').trim();
        const lineIndex = editContent.split('\n').findIndex(l => l.trim() === plainText || l.includes(plainText));
        // 使用行号或递增索引作为稳定 ID（避免 Math.random 导致重渲染时 ID 变化）
        const stableId = lineIndex >= 0 ? lineIndex : headingIndex;
        const id = `heading-${stableId}-${plainText.toLowerCase().replace(/[^a-z0-9一-龥]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;
        headingIndex++;
        return `<h${level} id="${id}">${content}</h${level}>`;
      });
      setRendered(sanitizeHtml(withIds));
    }
  }, [editContent, isMd, markedLoaded]);

  useLayoutEffect(() => {
    if (editMode || !mermaidInitRef.current || !rendered || !markdownRef.current) return;
    const mermaidBlocks = markdownRef.current.querySelectorAll('code.language-mermaid');
    if (mermaidBlocks.length === 0) return;
    mermaidRenderIdRef.current++;
    const prefix = `mermaid-${mermaidRenderIdRef.current}`;
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
  }, [rendered, editMode, mermaidLoaded]);

  // 2.13: Apply syntax highlighting to code blocks
  useLayoutEffect(() => {
    if (editMode || !hljsLoaded || !window.hljs || !rendered || !markdownRef.current) return;
    const codeBlocks = markdownRef.current.querySelectorAll('pre code:not(.language-mermaid)');
    if (codeBlocks.length === 0) return;
    codeBlocks.forEach(block => {
      window.hljs.highlightElement(block);
    });
  }, [rendered, hljsLoaded, editMode]);

  // Extract headings for TOC
  const headings = useMemo(() => isMd ? extractHeadings(editContent) : [], [isMd, editContent]);

  // Scroll spy for active heading
  useEffect(() => {
    if (!isMd || !previewBodyRef.current || headings.length === 0) return;
    const container = previewBodyRef.current;
    let frame = null;

    const handleScroll = () => {
      const root = container.querySelector(editMode ? '.ProseMirror' : '.rh-markdown');
      if (!root) return;
      const elements = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const headingElements = headings.map((h, index) => ({
        id: h.id,
        element: elements[index]
      })).filter(h => h.element);

      const threshold = container.getBoundingClientRect().top + 100;
      let activeId = headingElements[0]?.id || null;
      for (const { id, element } of headingElements) {
        if (element.getBoundingClientRect().top <= threshold) {
          activeId = id;
        }
      }
      if (container.scrollHeight > container.clientHeight + 1 &&
          container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
        activeId = headingElements[headingElements.length - 1]?.id || activeId;
      }
      setActiveHeadingId(activeId);
    };

    const scheduleUpdate = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        handleScroll();
      });
    };
    container.addEventListener('scroll', scheduleUpdate);
    // The editor mounts asynchronously and diagrams can change heading positions.
    const observer = new MutationObserver(scheduleUpdate);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(container);
    handleScroll(); // Initial check

    return () => {
      container.removeEventListener('scroll', scheduleUpdate);
      observer.disconnect();
      resizeObserver?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [isMd, rendered, headings, editMode]);

  // Navigate to heading
  const navigateToHeading = (headingId) => {
    if (!previewBodyRef.current) return;
    const root = previewBodyRef.current.querySelector(editMode ? '.ProseMirror' : '.rh-markdown');
    const index = headings.findIndex(heading => heading.id === headingId);
    const element = root?.querySelectorAll('h1, h2, h3, h4, h5, h6')[index];
    if (element) {
      previewBodyRef.current.scrollTo({
        top: previewBodyRef.current.scrollTop + element.getBoundingClientRect().top -
          previewBodyRef.current.getBoundingClientRect().top - 20,
        behavior: 'smooth'
      });
    }
  };

  // TOC resize handlers
  const handleMouseDown = (e) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseMove = (e) => {
    if (!isResizingRef.current) return;
    const newWidth = window.innerWidth - e.clientX;
    if (newWidth >= 150 && newWidth <= 400) {
      setTocWidth(newWidth);
    }
  };

  const handleMouseUp = () => {
    isResizingRef.current = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // TOC toggle button SVG arrows (< when open to collapse, > when closed to expand)
  const TocToggleIcon = showToc
    ? h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('polyline', { points: '9 18 15 12 9 6' }))
    : h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('polyline', { points: '15 18 9 12 15 6' }));

  // Edit toolbar
  const editToolbar = isEditable && h('div', {
    className: `rh-edit-toolbar${toolbarTarget ? ' rh-edit-toolbar-header' : ''}`,
  },
    // Mode toggle button
    h('button', {
      className: 'rh-btn rh-btn-ghost rh-btn-xs',
      onClick: () => setEditMode(!editMode),
      title: editMode ? '切换到只读预览' : '切换到可编辑预览',
    }, h(editMode ? IconEye : IconEdit, { size: 12 }), editMode ? '预览' : '编辑'),

    // Save button (only in edit mode)
    editMode && h('button', {
      className: 'rh-btn rh-btn-ghost rh-btn-xs',
      onClick: handleSave,
      disabled: saving,
      title: '保存文件 (Ctrl+S)',
    }, h(IconSave, { size: 12 }), saving ? '保存中...' : '保存'),

    // Last saved time
    lastSaved && h('span', {
      style: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 'var(--rh-font-size-sm)',
      }
    }, `已保存 ${lastSaved.toLocaleTimeString()}`)
  );

  // TOC toggle button (only for markdown with headings)
  const tocToggle = isMd && headings.length > 0 && h('button', {
    className: 'rh-btn rh-btn-secondary rh-btn-xs rh-toc-toggle',
    onClick: onToggleToc,
    title: showToc ? '收起 TOC' : '展开 TOC',
    style: {
      right: showToc ? tocWidth + 8 : 8,
    },
  }, TocToggleIcon, ' TOC');

  // Main content
  const mainContent = error ? h('span', { className: 'rh-error' }, 'Error: ', error)
    : isHtml
      ? h('iframe', {
          srcDoc: text,
          title: name,
          className: 'rh-preview-iframe',
          sandbox: 'allow-scripts allow-same-origin'
        })
      : isMd
        ? editMode
          ? h(MilkdownEditor, {
              content: editContent,
              onChange: setEditContent,
              mermaid: mermaidLoaded ? window.mermaid : null,
            })
          : (markedLoaded && rendered)
            ? h('div', { ref: markdownRef, className: 'rh-markdown', dangerouslySetInnerHTML: { __html: rendered } })
            : !editContent
              ? h(Skeleton, { lines: 8, height: '1.2em' })
              : h('pre', { style: { whiteSpace: 'pre-wrap', fontFamily: 'var(--rh-font-code)', fontSize: 'var(--rh-font-size)' } }, editContent)
        : isJson
          ? editMode
            ? h('textarea', {
                className: 'rh-json-editor',
                value: editContent,
                onChange: (e) => setEditContent(e.target.value),
                style: {
                  width: '100%',
                  height: '100%',
                  fontFamily: 'var(--rh-font-code)',
                  fontSize: 'var(--rh-font-size)',
                  lineHeight: 1.6,
                  padding: 12,
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                },
                spellCheck: false,
              })
            : (() => {
                try {
                  const parsed = JSON.parse(text);
                  return h(JsonViewer, { data: parsed, initialExpandLevel: 2 });
                } catch {
                  return h('pre', { className: 'rh-error', style: { whiteSpace: 'pre-wrap', fontFamily: 'var(--rh-font-code)', fontSize: 'var(--rh-font-size)' } }, 'Invalid JSON:\n' + text);
                }
              })()
          : editMode
            ? h('textarea', {
                className: 'rh-text-editor',
                value: editContent,
                onChange: (e) => setEditContent(e.target.value),
                style: {
                  width: '100%',
                  height: '100%',
                  fontFamily: 'var(--rh-font-code)',
                  fontSize: 'var(--rh-font-size)',
                  lineHeight: 1.6,
                  padding: 12,
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                },
                spellCheck: false,
              })
            : !text
              ? h(Skeleton, { lines: 6, height: '1.2em' })
              : h('pre', { style: { whiteSpace: 'pre-wrap', fontFamily: 'var(--rh-font-code)', fontSize: 'var(--rh-font-size)' } }, text);

  // TOC sidebar (only for markdown with headings, resizable)
  const tocSidebar = isMd && headings.length > 0 && showToc && h('div', {
    style: {
      width: tocWidth,
      minWidth: 150,
      maxWidth: 400,
      borderLeft: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      position: 'relative',
      overflow: 'hidden',
      flexShrink: 0,
    }
  },
    h('div', {
      onMouseDown: handleMouseDown,
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: 4,
        cursor: 'col-resize',
        background: 'transparent',
        zIndex: 5,
      }
    }),
    h(TableOfContents, {
      headings,
      activeId: activeHeadingId,
      onNavigate: navigateToHeading,
      width: tocWidth,
    })
  );

  // Keep local tools in a real row so they never cover document contents.
  return h('div', { className: 'rh-file-preview' },
    toolbarTarget ? createPortal(editToolbar, toolbarTarget) : editToolbar,
    tocToggle,
    h('div', { className: 'rh-file-preview-content' },
      h('div', { ref: previewBodyRef, className: 'rh-preview-body', style: { flex: 1, overflow: 'auto', minWidth: 0 } },
        mainContent
      ),
      tocSidebar
    )
  );
}

module.exports = { FilePreview };
