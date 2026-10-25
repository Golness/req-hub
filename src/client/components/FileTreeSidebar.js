'use strict';
const { DOCUMENT_NAME_HINTS } = require('../document-name-hints.js');
const { t } = require('../locale.js');
const css = require('./FileTreeSidebar.module.css').default;
const { cssValue } = require('./shared/presentation.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const { Select } = require('./shared/Select.js');
const h = React.createElement;
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const { ROUTE } = require('../constants.js');
const { getDocIcon } = require('../utils/getDocIcon.js');
const { createIconComponents } = require('../icons.js');

const { IconFolder, IconFolderOpen, IconChevronRight, IconChevronDown } = createIconComponents(h);

const MIN_WIDTH = 180;
const MAX_WIDTH = 400;
const DEFAULT_WIDTH = 220;

function formatTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getFileExt(name) {
  const m = name.toLowerCase().match(/\.[^.]+$/);
  return m ? m[0] : '';
}

function inferDocType(filename) {
  const lower = filename.toLowerCase();
  if (/\bcr\b/.test(lower) || lower.includes('code review') || lower.includes('codereview')) return 'cr';
  if (lower.includes(DOCUMENT_NAME_HINTS.design) || lower.includes('design') || lower.includes('tech') || lower.includes('technical')) return 'design';
  if (lower.includes(DOCUMENT_NAME_HINTS.requirement) || lower.includes('require') || lower.includes('prd')) return 'requirement';
  return 'other';
}

const docTypeLabels = { requirement: t("DocsViewerBody.message072"), design: t("DocumentDropdown.message005"), cr: 'CR', other: t("DocumentDropdown.message006") };

/**
 * @component TreeNode
 * @description Recursive tree node component. Directories are expandable/collapsible,
 * files are clickable for selection.
 */
function leafPaths(node) {
  return node.type === 'file' ? [node.path] : (node.children || []).flatMap(leafPaths);
}

function TreeCheckbox({ paths, selectedPaths, onTogglePaths, label }) {
  const ref = useRef(null);
  const count = paths.filter(path => selectedPaths.has(path)).length;
  const mixed = count > 0 && count < paths.length;
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return h('input', { ref, type: 'checkbox', className: 'rh-tree-checkbox', 'aria-label': label,
    'aria-checked': mixed ? 'mixed' : count === paths.length && paths.length > 0,
    checked: count === paths.length && paths.length > 0, disabled: !paths.length,
    onClick: event => event.stopPropagation(), onChange: event => onTogglePaths(paths, event.target.checked) });
}

function TreeNode({ node, depth, expandedDirs, toggleDir, activeFilePath, onFileClick, selection }) {
  if (node.type === 'directory') {
    const isExpanded = expandedDirs.has(node.path);
    return h('div', { className: 'rh-tree-node' },
      h('div', {
        className: ('rh-tree-dir') + ' ' + css.row,
        style: { "--rh-padding-3": cssValue(`4px 8px 4px ${depth * 14 + 8}px`) },
        onClick: () => toggleDir(node.path),
        role: 'treeitem', tabIndex: 0, 'aria-expanded': isExpanded,
        onKeyDown: event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight' && !isExpanded || event.key === 'ArrowLeft' && isExpanded) { event.preventDefault(); toggleDir(node.path); } },
      },
        selection && h(TreeCheckbox, { paths: leafPaths(node), ...selection, label: t("FileTreeSidebar.message002", { value0: node.path }) }),
        h('span', {
          className: css.mutedText, style: { "--rh-transform-3": cssValue(isExpanded ? 'rotate(90deg)' : 'rotate(0deg)') }
        }, h(IconChevronRight, { size: 10 })),
        isExpanded ? h(IconFolderOpen, { size: 14 }) : h(IconFolder, { size: 14 }),
        h('span', {
          className: css.heading
        }, node.name),
        node.children && h('span', {
          className: css.spacing
        }, `${node.children.length}`)
      ),
      isExpanded && node.children && node.children.map((child, idx) =>
        h(TreeNode, {
          key: child.path || idx,
          node: child,
          depth: depth + 1,
          expandedDirs,
          toggleDir,
          activeFilePath,
          onFileClick,
          selection,
        })
      )
    );
  }

  // File node
  const isActive = activeFilePath === node.path;
  const docType = inferDocType(node.name);
  return h('div', {
    className: (`rh-tree-file${isActive ? ' active' : ''}`) + ' ' + css.row2,
    style: { "--rh-padding-3": cssValue(`4px 8px 4px ${depth * 14 + 22}px`), "--rh-background-7": cssValue(isActive ? 'var(--rh-accent-bg)' : 'transparent'), "--rh-color-8": cssValue(isActive ? 'var(--rh-accent)' : 'var(--dsw-alias-label-primary)') },
    onClick: () => onFileClick(node),
    role: 'treeitem', tabIndex: 0, 'aria-selected': isActive,
    onKeyDown: event => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); onFileClick(node); } },
    title: node.path,
  },
    selection && h(TreeCheckbox, { paths: [node.path], ...selection, label: t("FileTreeSidebar.message003", { value0: node.path }) }),
    getDocIcon(docType, 14),
    h('div', { className: css.pane },
      h('div', { className: css.pane2 }, node.name),
      node.mtime && h('div', { className: css.mutedText2 }, formatTime(node.mtime))
    ),
    h('span', {
      className: ('rh-doctype-tag') + ' ' + css.content,
    }, docTypeLabels[docType] || t("DocumentDropdown.message006"))
  );
}

/**
 * @component FileTreeSidebar
 * @description A resizable sidebar component displaying a hierarchical file tree
 * from the selected requirement directory. Supports filtering, sorting, and
 * expandable/collapsible directories.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The unique identifier of the workspace
 * @param {Object|null} props.selectedReq - The currently selected requirement object
 * @param {Function} props.onSelectFile - Callback invoked when a file is selected
 * @returns {JSX.Element} A resizable sidebar with a hierarchical file tree
 */
function FileTreeSidebar({ workspaceId, selectedReq, onSelectFile, multiSelect = false, selectedPaths = [], onSelectionChange }) {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [activeFile, setActiveFile] = useState(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [filterExt, setFilterExt] = useState('all'); // all, .md, .html, .txt, .json
  const [filterType, setFilterType] = useState('all'); // all, requirement, design, cr, other
  const [sortBy, setSortBy] = useState('none'); // none, mtime-asc, mtime-desc
  const [showFilters, setShowFilters] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [expandedDirs, setExpandedDirs] = useState(new Set());
  const sidebarRef = useRef(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    setLoadError(null);
    if (!selectedReq || !workspaceId) {
      setTree([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true); setActiveFile(null); setTree([]);
    (async () => {
      try {
        const res = await fetch(`${ROUTE}/file-tree?workspaceId=${encodeURIComponent(workspaceId)}&requirementId=${encodeURIComponent(selectedReq.id)}&requirementPath=${encodeURIComponent(selectedReq.path || "")}`);
        if (!res.ok) throw new Error(t("FileTreeSidebar.message004"));
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setTree(data.tree || []);
            setExpandedDirs(new Set()); // Reset expanded state on requirement change
          }
        }
      } catch (error) { if (!cancelled) setLoadError(error.message); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [workspaceId, selectedReq?.id, selectedReq?.path]);

  const toggleDir = (path) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleFileClick = (fileNode) => {
    setActiveFile(fileNode);
    // Construct full path from docs root: requirement path + file path
    const fullPath = selectedReq.path
      ? `${selectedReq.path}/${fileNode.path}`
      : fileNode.path;
    onSelectFile({
      name: fileNode.name,
      path: fullPath.replaceAll('\\', '/'),
      mtime: fileNode.mtime,
      type: inferDocType(fileNode.name),
    });
  };

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;

    const onMove = (ev) => {
      const deltaX = ev.clientX - startXRef.current;
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidthRef.current + deltaX));
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${newWidth}px`;
        sidebarRef.current.style.minWidth = `${newWidth}px`;
      }
    };

    const onUp = () => {
      setIsResizing(false);
      if (sidebarRef.current) {
        const w = parseInt(sidebarRef.current.style.width, 10);
        if (w) setWidth(w);
      }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width]);

  // Filter and sort the tree
  const filteredTree = useMemo(() => {
    if (filterExt === 'all' && filterType === 'all' && sortBy === 'none') {
      return tree;
    }

    const filterNode = (node) => {
      if (node.type === 'file') {
        // Check extension filter
        if (filterExt !== 'all') {
          const ext = getFileExt(node.name);
          if (filterExt === '.txt') {
            if (ext !== '.txt' && ext !== '.text') return null;
          } else if (ext !== filterExt) {
            return null;
          }
        }
        // Check doc type filter
        if (filterType !== 'all') {
          const docType = inferDocType(node.name);
          if (docType !== filterType) return null;
        }
        return node;
      }
      // Directory: filter children recursively, but always keep the directory
      if (node.children) {
        const filteredChildren = node.children.map(filterNode).filter(Boolean);
        // Always show directories, even if they have no matching children
        return { ...node, children: filteredChildren };
      }
      return node;
    };

    let result = tree.map(filterNode).filter(Boolean);

    // Sort files within each directory
    if (sortBy === 'mtime-asc' || sortBy === 'mtime-desc') {
      const sortNodes = (nodes) => {
        return nodes.map(node => {
          if (node.type === 'directory' && node.children) {
            return { ...node, children: sortNodes(node.children) };
          }
          return node;
        }).sort((a, b) => {
          // Directories first
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          // Sort files by mtime
          if (a.type === 'file' && b.type === 'file') {
            if (!a.mtime && !b.mtime) return 0;
            if (!a.mtime) return 1;
            if (!b.mtime) return -1;
            return sortBy === 'mtime-asc'
              ? new Date(a.mtime) - new Date(b.mtime)
              : new Date(b.mtime) - new Date(a.mtime);
          }
          return 0;
        });
      };
      result = sortNodes(result);
    }

    return result;
  }, [tree, filterExt, filterType, sortBy]);

  const prefix = (selectedReq?.path || '').replaceAll('\\', '/');
  const fullPath = path => [prefix, path.replaceAll('\\', '/')].filter(Boolean).join('/');
  const localSelected = new Set(selectedPaths.filter(path => path.startsWith(prefix + '/')).map(path => path.slice(prefix.length + 1)));
  const togglePaths = (paths, checked) => {
    const next = new Set(selectedPaths);
    for (const path of paths) { if (checked) next.add(fullPath(path)); else next.delete(fullPath(path)); }
    onSelectionChange?.([...next]);
  };
  const visiblePaths = filteredTree.flatMap(leafPaths);
  const visibleSelected = visiblePaths.filter(path => localSelected.has(path.replaceAll('\\', '/'))).length;
  const selection = multiSelect ? { selectedPaths: new Set(visiblePaths.filter(path => localSelected.has(path.replaceAll('\\', '/')))), onTogglePaths: togglePaths } : null;

  const countFiles = (nodes) => {
    let count = 0;
    for (const n of nodes) {
      if (n.type === 'file') count++;
      else if (n.children) count += countFiles(n.children);
    }
    return count;
  };

  return h('div', {
    ref: sidebarRef,
    className: (`rh-file-tree-sidebar${!expanded ? ' collapsed' : ''}${isResizing ? ' resizing' : ''}`) + ' ' + css.size,
    style: { "--rh-width-0": cssValue(`${width}px`), "--rh-min-width-1": cssValue(`${width}px`) },
  },
    // Resize handle
    expanded && h('div', {
      className: `rh-resize-handle${isResizing ? ' dragging' : ''}`,
      onMouseDown: handleMouseDown,
      title: t("FileTreeSidebar.message005"),
    }),

    // Toggle button
    h('button', {
      className: 'rh-file-tree-toggle',
      onClick: () => setExpanded(!expanded),
      'aria-label': expanded ? t("FileTreeSidebar.message006") : t("FileTreeSidebar.message007"),
      title: expanded ? t("FileTreeSidebar.message008") : t("FileTreeSidebar.message009"),
    }, h(IconChevronRight, { size: 16, className: css.indicator, style: { "--rh-transform-0": cssValue(expanded ? 'rotate(180deg)' : undefined) } })),

    // Content
    expanded && h('div', { className: 'rh-file-tree-content' },
      multiSelect && h('div', { className: 'rh-knowledge-selection' },
        h('span', { role: 'status' }, t("FileTreeSidebar.message011", { value0: selectedPaths.length, value1: selectedPaths.length > visibleSelected ? t("FileTreeSidebar.message010", { value0: selectedPaths.length - visibleSelected }) : '' })),
        h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !visiblePaths.length, onClick: () => togglePaths(visiblePaths, true) }, t("FileTreeSidebar.message012")),
        h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !selectedPaths.length, onClick: () => onSelectionChange?.([]) }, t("FileTreeSidebar.message013"))),
      // Filters (collapsible, default collapsed)
      h('div', { className: 'rh-file-tree-filters' },
        h(Button, {
          type: 'button',
          className: 'rh-btn rh-btn-ghost rh-btn-sm rh-filter-toggle',
          onClick: () => setShowFilters(!showFilters),
          'aria-expanded': showFilters,
        },
          h('span', null, t("FileTreeSidebar.message014")),
          h(IconChevronDown, { size: 16, className: `rh-filter-arrow${showFilters ? ' expanded' : ''}` })
        ),
        showFilters && h('div', { className: 'rh-filter-content' },
          // Extension filter
          h('div', { className: 'rh-filter-group' },
            h('label', { className: 'rh-filter-label' }, t("FileTreeSidebar.message015")),
            h(Select, {
              className: 'rh-filter-select', 'aria-label': t("FileTreeSidebar.message016"),
              value: filterExt,
              onChange: (e) => setFilterExt(e.target.value),
            },
              h('option', { value: 'all' }, t("FileTreeSidebar.message017")),
              h('option', { value: '.md' }, 'Markdown'),
              h('option', { value: '.html' }, 'HTML'),
              h('option', { value: '.txt' }, t("FileTreeSidebar.message018")),
              h('option', { value: '.json' }, 'JSON'),
              h('option', { value: '.pdf' }, 'PDF'),
              h('option', { value: '.docx' }, 'Word'),
              h('option', { value: '.xlsx' }, 'Excel')
            )
          ),
          // Document type filter
          h('div', { className: 'rh-filter-group' },
            h('label', { className: 'rh-filter-label' }, t("FileTreeSidebar.message019")),
            h(Select, {
              className: 'rh-filter-select', 'aria-label': t("FileTreeSidebar.message020"),
              value: filterType,
              onChange: (e) => setFilterType(e.target.value),
            },
              h('option', { value: 'all' }, t("FileTreeSidebar.message017")),
              h('option', { value: 'requirement' }, t("DocsViewerBody.message072")),
              h('option', { value: 'design' }, t("DocumentDropdown.message005")),
              h('option', { value: 'cr' }, 'CR'),
              h('option', { value: 'other' }, t("FileTreeSidebar.message021"))
            )
          ),
          // Sort buttons
          h('div', { className: 'rh-filter-group' },
            h('label', { className: 'rh-filter-label' }, t("FileTreeSidebar.message022")),
            h('div', { className: 'rh-sort-buttons' },
              h(Button, {
                className: `rh-btn rh-btn-ghost rh-btn-sm rh-sort-btn${sortBy === 'none' ? ' active' : ''}`,
                'aria-pressed': sortBy === 'none',
                onClick: () => setSortBy('none'),
                title: t("FileTreeSidebar.message023"),
              }, t("FileTreeSidebar.message024")),
              h(Button, {
                className: `rh-btn rh-btn-ghost rh-btn-sm rh-sort-btn${sortBy === 'mtime-asc' ? ' active' : ''}`,
                'aria-pressed': sortBy === 'mtime-asc',
                onClick: () => setSortBy('mtime-asc'),
                title: t("FileTreeSidebar.message025"),
              }, t("FileTreeSidebar.message026")),
              h(Button, {
                className: `rh-btn rh-btn-ghost rh-btn-sm rh-sort-btn${sortBy === 'mtime-desc' ? ' active' : ''}`,
                'aria-pressed': sortBy === 'mtime-desc',
                onClick: () => setSortBy('mtime-desc'),
                title: t("FileTreeSidebar.message027"),
              }, t("FileTreeSidebar.message028"))
            )
          )
        )
      ),

      // Tree content
      loading
        ? h('div', { className: ('rh-empty') + ' ' + css.size2 }, t("common.loading"))
        : loadError ? h('div', { className: 'rh-knowledge-error', role: 'alert' }, loadError)
        : !selectedReq
          ? h('div', { className: ('rh-empty') + ' ' + css.size2 }, t("DocumentDropdown.message003"))
          : filteredTree.length === 0
            ? h('div', { className: ('rh-empty') + ' ' + css.size2 }, t("FileTreeSidebar.message029"))
            : h('div', {
                role: 'tree', 'aria-label': t("FileTreeSidebar.message030"),
                className: css.pane3
              },
                // File count header
                h('div', {
                  className: css.mutedText3
                }, t("DocTree.message002", { value0: countFiles(filteredTree) })),
                filteredTree.map((node, idx) =>
                  h(TreeNode, {
                    key: node.path || idx,
                    node,
                    depth: 0,
                    expandedDirs,
                    toggleDir,
                    activeFilePath: activeFile?.path,
                    onFileClick: handleFileClick,
                    selection,
                  })
                )
              )
    )
  );
}

module.exports = { FileTreeSidebar };
