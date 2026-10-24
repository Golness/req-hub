'use strict';

const React = require('react');
const { createPortal } = require('react-dom');
const h = React.createElement;
const { useState, useEffect, useRef, useMemo } = React;

const { ROUTE, MERMAID_SCRIPT_ID } = require('../constants.js');
const { useScript } = require('../hooks/useScript.js');
const { getMermaidTheme } = require('../utils/getMermaidTheme.js');
const { getDocIcon } = require('../utils/getDocIcon.js');
const { TableOfContents, extractHeadings } = require('./shared/TableOfContents.js');
const { Skeleton } = require('./shared/Skeleton.js');
const { JsonViewer } = require('./JsonViewer.js');
const { MilkdownEditor } = require('./MilkdownEditor.js');
const { showToast } = require('./shared/ToastContainer.js');



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
  const [error, setError] = useState(null);
  const [parseWarnings, setParseWarnings] = useState([]);
  const [activeHeadingId, setActiveHeadingId] = useState(null);
  const [tocWidth, setTocWidth] = useState(200);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const previewBodyRef = useRef(null);
  const mermaidInitRef = useRef(false);
  const isResizingRef = useRef(false);
  const isHtml = /\.html?$/i.test(name);
  const isMd = /\.md$/i.test(name);
  const isJson = /\.json$/i.test(name);
  const isExtracted = /\.(pdf|docx|xlsx)$/i.test(name);
  const isEditable = /\.(md|txt|text|json)$/i.test(name);

  const { loaded: mermaidLoaded } = useScript(
    'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js', MERMAID_SCRIPT_ID, 'mermaid',
  );
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
    if (!isMd && !editMode) return;
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMd, editMode, editContent, workspaceId, relPath]);

  useEffect(() => {
    let cancelled = false;
    setEditMode(false);
    setError(null);
    setParseWarnings([]);
    setLastSaved(null);
    (async () => {
      try {
        const url = `${ROUTE}/read?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(relPath)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || 'read failed');
        else { setText(data.text || ''); setEditContent(data.text || ''); setParseWarnings(data.warnings || []); }
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

  // Extract headings for TOC
  const headings = useMemo(() => isMd ? extractHeadings(editContent) : [], [isMd, editContent]);

  // Scroll spy for active heading
  useEffect(() => {
    if (!isMd || editMode || !previewBodyRef.current || headings.length === 0) return;
    const container = previewBodyRef.current;
    let frame = null;

    const handleScroll = () => {
      const root = container.querySelector('.ProseMirror');
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
  }, [isMd, headings, editMode]);

  // Navigate to heading
  const navigateToHeading = (headingId) => {
    if (!previewBodyRef.current) return;
    const root = previewBodyRef.current.querySelector('.ProseMirror');
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

  // Edit toolbar
  const editToolbar = isEditable && h('div', {
    className: `rh-edit-toolbar${toolbarTarget ? ' rh-edit-toolbar-header' : ''}`,
  },
    isMd ? h('div', { role: 'group', 'aria-label': 'Markdown 查看模式' },
      [['预览', false], ['编辑', true]].map(([label, source]) => h('button', {
        key: label,
        type: 'button',
        className: 'rh-btn rh-btn-ghost rh-btn-sm',
        'aria-pressed': editMode === source,
        onClick: () => setEditMode(source),
        title: source ? '编辑 Markdown 原文' : '预览并编辑渲染后的文档',
      }, label))
    ) : h('button', {
      className: 'rh-btn rh-btn-ghost rh-btn-sm',
      onClick: () => setEditMode(!editMode),
      title: editMode ? '切换到只读预览' : '编辑原文',
    }, editMode ? '预览' : '编辑'),

    (isMd || editMode) && h('button', {
      className: 'rh-btn rh-btn-ghost rh-btn-sm',
      onClick: handleSave,
      disabled: saving,
      title: '保存文件 (Ctrl+S)',
    }, saving ? '保存中...' : '保存'),

    // Last saved time
    lastSaved && h('span', {
      style: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 'var(--rh-font-size-sm)',
      }
    }, `已保存 ${lastSaved.toLocaleTimeString()}`)
  );

  // TOC toggle button (only for markdown with headings)
  const tocToggle = isMd && !editMode && headings.length > 0 && h('button', {
    className: 'rh-btn rh-btn-secondary rh-btn-sm rh-toc-toggle',
    onClick: onToggleToc,
    title: showToc ? '收起 TOC' : '展开 TOC',
    style: {
      right: showToc ? tocWidth + 8 : 8,
    },
  }, showToc ? '收起目录' : '展开目录');

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
          ? h('textarea', {
              className: 'rh-text-editor',
              'aria-label': 'Markdown 原文',
              value: editContent,
              onChange: (event) => setEditContent(event.target.value),
              spellCheck: false,
            })
          : h(MilkdownEditor, {
              content: editContent,
              onChange: setEditContent,
              mermaid: mermaidLoaded ? window.mermaid : null,
            })
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
  const tocSidebar = isMd && !editMode && headings.length > 0 && showToc && h('div', {
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
        isExtracted && h('div', { className: 'rh-op-info', role: 'status' }, '提取正文预览（只读）', parseWarnings.length > 0 && h('div', null, parseWarnings.join('；'))),
        mainContent
      ),
      tocSidebar
    )
  );
}

module.exports = { FilePreview };
