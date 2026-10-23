'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const { ROUTE } = require('../constants.js');
const { getDocIcon } = require('../utils/getDocIcon.js');
const { createIconComponents } = require('../icons.js');

const { IconFolder, IconFolderOpen, IconFile, IconClose, IconChevronRight } = createIconComponents(h);

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
  if (lower.includes('技术') || lower.includes('design') || lower.includes('tech') || lower.includes('technical')) return 'design';
  if (lower.includes('需求') || lower.includes('require') || lower.includes('prd')) return 'requirement';
  return 'other';
}

const docTypeLabels = { requirement: '需求', design: '技术方案', cr: 'CR', other: '文档' };

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
        className: 'rh-tree-dir',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: `4px 8px 4px ${depth * 14 + 8}px`,
          cursor: 'pointer',
          fontSize: 'var(--rh-font-size)',
          borderRadius: 4,
          userSelect: 'none',
        },
        onClick: () => toggleDir(node.path),
        role: 'treeitem', tabIndex: 0, 'aria-expanded': isExpanded,
        onKeyDown: event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowRight' && !isExpanded || event.key === 'ArrowLeft' && isExpanded) { event.preventDefault(); toggleDir(node.path); } },
      },
        selection && h(TreeCheckbox, { paths: leafPaths(node), ...selection, label: `选择目录 ${node.path}` }),
        h('span', {
          style: {
            display: 'inline-block',
            width: 10,
            transition: 'transform 0.15s',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            color: 'var(--dsw-alias-label-secondary)',
          }
        }, h(IconChevronRight, { size: 10 })),
        isExpanded ? h(IconFolderOpen, { size: 14 }) : h(IconFolder, { size: 14 }),
        h('span', {
          style: {
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 'var(--rh-font-size)',
            fontWeight: 500,
            color: 'var(--dsw-alias-label-primary)',
          }
        }, node.name),
        node.children && h('span', {
          style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-tertiary)', marginLeft: 4, flexShrink: 0 }
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
    className: `rh-tree-file${isActive ? ' active' : ''}`,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: `4px 8px 4px ${depth * 14 + 22}px`,
      cursor: 'pointer',
      fontSize: 'var(--rh-font-size)',
      borderRadius: 4,
      background: isActive ? 'var(--rh-accent-bg)' : 'transparent',
      color: isActive ? 'var(--rh-accent)' : 'var(--dsw-alias-label-primary)',
      transition: 'background 0.1s',
    },
    onClick: () => onFileClick(node),
    role: 'treeitem', tabIndex: 0, 'aria-selected': isActive,
    onKeyDown: event => { if (event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); onFileClick(node); } },
    title: node.path,
  },
    selection && h(TreeCheckbox, { paths: [node.path], ...selection, label: `选择文件 ${node.path}` }),
    getDocIcon(docType, 14),
    h('div', { style: { flex: 1, overflow: 'hidden', minWidth: 0 } },
      h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, node.name),
      node.mtime && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, formatTime(node.mtime))
    ),
    h('span', {
      className: 'rh-doctype-tag',
      style: { flexShrink: 0 },
    }, docTypeLabels[docType] || '文档')
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
        if (!res.ok) throw new Error('文件树加载失败，请重新选择需求目录');
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
    className: `rh-file-tree-sidebar${!expanded ? ' collapsed' : ''}${isResizing ? ' resizing' : ''}`,
    style: { width: `${width}px`, minWidth: `${width}px` },
  },
    // Resize handle
    expanded && h('div', {
      className: `rh-resize-handle${isResizing ? ' dragging' : ''}`,
      onMouseDown: handleMouseDown,
      title: '拖动调整宽度',
    }),

    // Toggle button
    h('button', {
      className: 'rh-file-tree-toggle',
      onClick: () => setExpanded(!expanded),
      'aria-label': expanded ? '收起文件树' : '展开文件树',
      title: expanded ? '收起' : '展开',
    }, expanded ? '‹' : '›'),

    // Content
    expanded && h('div', { className: 'rh-file-tree-content' },
      multiSelect && h('div', { className: 'rh-knowledge-selection' },
        h('span', { role: 'status' }, `已选 ${selectedPaths.length} 个${selectedPaths.length > visibleSelected ? `（${selectedPaths.length - visibleSelected} 个不在当前筛选结果）` : ''}`),
        h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !visiblePaths.length, onClick: () => togglePaths(visiblePaths, true) }, '全选当前筛选结果'),
        h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !selectedPaths.length, onClick: () => onSelectionChange?.([]) }, '清空选择')),
      // Filters (collapsible, default collapsed)
      h('div', { className: 'rh-file-tree-filters' },
        h('div', {
          className: 'rh-filter-toggle',
          onClick: () => setShowFilters(!showFilters),
          role: 'button',
          'aria-expanded': showFilters,
        },
          h('span', null, '筛选'),
          h('span', {
            className: `rh-filter-arrow${showFilters ? ' expanded' : ''}`,
          }, '▾')
        ),
        showFilters && h('div', { className: 'rh-filter-content' },
          // Extension filter
          h('div', { className: 'rh-filter-group' },
            h('label', { className: 'rh-filter-label' }, '类型:'),
            h('select', {
              className: 'rh-filter-select',
              value: filterExt,
              onChange: (e) => setFilterExt(e.target.value),
            },
              h('option', { value: 'all' }, '全部'),
              h('option', { value: '.md' }, 'Markdown'),
              h('option', { value: '.html' }, 'HTML'),
              h('option', { value: '.txt' }, '文本'),
              h('option', { value: '.json' }, 'JSON')
            )
          ),
          // Document type filter
          h('div', { className: 'rh-filter-group' },
            h('label', { className: 'rh-filter-label' }, '文档:'),
            h('select', {
              className: 'rh-filter-select',
              value: filterType,
              onChange: (e) => setFilterType(e.target.value),
            },
              h('option', { value: 'all' }, '全部'),
              h('option', { value: 'requirement' }, '需求'),
              h('option', { value: 'design' }, '技术方案'),
              h('option', { value: 'cr' }, 'CR'),
              h('option', { value: 'other' }, '其他')
            )
          ),
          // Sort buttons
          h('div', { className: 'rh-filter-group' },
            h('label', { className: 'rh-filter-label' }, '排序:'),
            h('div', { className: 'rh-sort-buttons' },
              h('button', {
                className: `rh-sort-btn${sortBy === 'none' ? ' active' : ''}`,
                onClick: () => setSortBy('none'),
                title: '不排序',
              }, '—'),
              h('button', {
                className: `rh-sort-btn${sortBy === 'mtime-asc' ? ' active' : ''}`,
                onClick: () => setSortBy('mtime-asc'),
                title: '编辑时间升序',
              }, '↑'),
              h('button', {
                className: `rh-sort-btn${sortBy === 'mtime-desc' ? ' active' : ''}`,
                onClick: () => setSortBy('mtime-desc'),
                title: '编辑时间降序',
              }, '↓')
            )
          )
        )
      ),

      // Tree content
      loading
        ? h('div', { className: 'rh-empty', style: { minHeight: 80 } }, '加载中...')
        : loadError ? h('div', { className: 'rh-knowledge-error', role: 'alert' }, loadError)
        : !selectedReq
          ? h('div', { className: 'rh-empty', style: { minHeight: 80 } }, '请先选择需求目录')
          : filteredTree.length === 0
            ? h('div', { className: 'rh-empty', style: { minHeight: 80 } }, '无匹配文件')
            : h('div', {
                role: 'tree', 'aria-label': '需求文件',
                style: {
                  flex: 1,
                  overflow: 'auto',
                  padding: '4px 0',
                }
              },
                // File count header
                h('div', {
                  style: {
                    padding: '4px 12px 8px',
                    fontSize: 'var(--rh-font-size-sm)',
                    color: 'var(--dsw-alias-label-secondary)',
                  }
                }, `${countFiles(filteredTree)} 个文件`),
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
