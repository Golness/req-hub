'use strict';
const { t } = require('../locale.js');
const css = require('./FilePreview.module.css').default;
const { cssValue } = require('./shared/presentation.js');
const { Button } = require('./shared/Button.js');

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
function FilePreview({ workspaceId, relPath, name, requirement, onBack, showToc, onToggleToc, toolbarTarget, onSaved, onDirtyChange, active = true, sourceUrl, readOnly = false, assist }) {
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
  const isEditable = !readOnly && /\.(md|txt|text|json)$/i.test(name);
  useEffect(() => { onDirtyChange?.(editContent !== text); }, [editContent, text, workspaceId, relPath]);

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
        onSaved?.();
        showToast({ tone: 'success', text: t("FilePreview.message001"), holdMs: 2000 });
      } else {
        showToast({ tone: 'error', text: data.error || t("FilePreview.message002"), holdMs: 3000 });
      }
    } catch (e) {
      showToast({ tone: 'error', text: t("FilePreview.message003"), holdMs: 3000 });
    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcut: Ctrl+S to save
  useEffect(() => {
    if (!active || readOnly || !isMd && !editMode) return;
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, isMd, editMode, editContent, workspaceId, relPath, readOnly]);

  useEffect(() => {
    let cancelled = false;
    setEditMode(false);
    setText(''); setEditContent('');
    setError(null);
    setParseWarnings([]);
    setLastSaved(null);
    (async () => {
      try {
        const url = sourceUrl || `${ROUTE}/read?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(relPath)}`;
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
  }, [workspaceId, relPath, isMd, sourceUrl]);

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
    isMd ? h('div', { role: 'group', 'aria-label': t("FilePreview.message004") },
      [[t("FilePreview.message005"), false], [t("FilePreview.message006"), true]].map(([label, source]) => h(Button, {
        key: label,
        type: 'button',
        className: 'rh-btn rh-btn-ghost rh-btn-sm',
        'aria-pressed': editMode === source,
        onClick: () => setEditMode(source),
        title: source ? t("FilePreview.message007") : t("FilePreview.message008"),
      }, label))
    ) : h(Button, {
      className: 'rh-btn rh-btn-ghost rh-btn-sm',
      onClick: () => setEditMode(!editMode),
      title: editMode ? t("FilePreview.message009") : t("FilePreview.message010"),
    }, editMode ? t("FilePreview.message005") : t("FilePreview.message006")),

    (isMd || editMode) && h(Button, {
      className: 'rh-btn rh-btn-ghost rh-btn-sm',
      onClick: handleSave,
      disabled: saving,
      title: t("FilePreview.message011"),
    }, saving ? t("FilePreview.message012") : t("common.save")),

    // Last saved time
    lastSaved && h('span', {
      className: css.mutedText
    }, t("FilePreview.message014", { value0: lastSaved.toLocaleTimeString() }))
  );

  // TOC toggle button (only for markdown with headings)
  const tocToggle = isMd && !editMode && headings.length > 0 && h(Button, {
    className: ('rh-btn rh-btn-secondary rh-btn-sm rh-toc-toggle') + ' ' + css.content,
    onClick: onToggleToc,
    title: showToc ? t("FilePreview.message015") : t("FilePreview.message016"),
    style: { "--rh-right-0": cssValue(showToc ? tocWidth + 8 : 8) },
  }, showToc ? t("FilePreview.message017") : t("FilePreview.message018"));

  // Main content
  const mainContent = error ? h('span', { className: 'rh-error' }, t("FilePreview.message019"), error)
    : isHtml
      ? h('iframe', {
          title: name,
          className: 'rh-preview-iframe',
          sandbox: 'allow-scripts',
          referrerPolicy: 'no-referrer',
          // Opaque origin plus CSP: diagrams can run, but cannot call Host APIs.
          srcDoc: '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;unsafe-inline&apos; https://cdn.jsdelivr.net; style-src &apos;unsafe-inline&apos;; img-src data: https:; font-src data:; connect-src &apos;none&apos;; form-action &apos;none&apos;; base-uri &apos;none&apos;">' + text
        })
      : isMd
        ? editMode
          ? h('textarea', {
              className: 'rh-text-editor',
              'aria-label': t("FilePreview.message020"),
              value: editContent,
              onChange: (event) => setEditContent(event.target.value),
              spellCheck: false,
            })
          : h(MilkdownEditor, {
              readOnly,
              content: editContent,
              onChange: setEditContent,
              imageContext: relPath ? { workspaceId, requirementPath: relPath.split('/').slice(0, 2).join('/') } : undefined,
              mermaid: mermaidLoaded ? window.mermaid : null,
            })
        : isJson
          ? editMode
            ? h('textarea', {
                className: ('rh-json-editor') + ' ' + css.section,
                value: editContent,
                onChange: (e) => setEditContent(e.target.value),
                spellCheck: false,
              })
            : (() => {
                try {
                  const parsed = JSON.parse(text);
                  return h(JsonViewer, { data: parsed, initialExpandLevel: 2 });
                } catch {
                  return h('pre', { className: ('rh-error') + ' ' + css.content2 }, t('common.invalidJson') + text);
                }
              })()
          : editMode
            ? h('textarea', {
                className: ('rh-text-editor') + ' ' + css.section,
                value: editContent,
                onChange: (e) => setEditContent(e.target.value),
                spellCheck: false,
              })
            : !text
              ? h(Skeleton, { lines: 6, height: '1.2em' })
              : h('pre', { className: css.content2 }, text);

  // TOC sidebar (only for markdown with headings, resizable)
  const tocSidebar = isMd && !editMode && headings.length > 0 && showToc && h('div', {
    className: css.pane, style: { "--rh-width-0": cssValue(tocWidth) }
  },
    h('div', {
      onMouseDown: handleMouseDown,
      className: css.size
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
      h('div', { ref: previewBodyRef, className: ('rh-preview-body') + ' ' + css.pane2 },
        isExtracted && h('div', { className: 'rh-op-info', role: 'status' }, t("FilePreview.message021"), parseWarnings.length > 0 && h('div', null, parseWarnings.join('；'))),
        mainContent,
        assist
      ),
      tocSidebar
    )
  );
}

module.exports = { FilePreview };
