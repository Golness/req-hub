'use strict';
const { t } = require('../../locale.js');
const css = require('./DiffViewer.module.css').default;
const { Button } = require('./Button.js');
const React = require('react');
const h = React.createElement;
const { useState, useMemo, useCallback } = React;
const { structuredPatch } = require('diff');

/**
 * @module DiffViewer
 * @description Line-level diff viewer fully aligned with DSH DiffBlock implementation.
 * Uses the `diff` npm package's structuredPatch() for computing line-level differences.
 * Features: row-based rendering (path/del/add/context/gap), large file folding,
 * CSS ::before pseudo-elements for +/- prefixes, split and inline view modes,
 * code wrapping toggle, and clipboard copy support.
 */

// ─── 常量（与 DSH 一致）──────────────────────────────────────────────

/** Number of output lines above which the middle section is folded (DSH DEFAULT_DIFF_MAX_LINES = 16). */
const DEFAULT_DIFF_MAX_LINES = 16;

/** Limits the edit graph search range for the diff algorithm (DSH MAX_DIFF_EDIT_LENGTH = 256). */
const MAX_DIFF_EDIT_LENGTH = 256;

// ─── 工具函数（与 DSH DiffBlock.tsx 行为一致）────────────────────────

/**
 * Splits text into content lines (aligned with DSH contentLines behavior).
 * Empty text returns 0 lines; trailing newline is treated as a terminator, not an extra empty line.
 * @param {string} text - The text to split into lines.
 * @returns {string[]} Array of text lines.
 */
function contentLines(text) {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

/**
 * Normalizes line content to structuredPatch input format (appends \n to each line).
 * @param {string[]} lines - Array of text lines.
 * @returns {string} Normalized text with newlines appended.
 */
function normalize(lines) {
  return lines.map(line => `${line}\n`).join('');
}

/**
 * Computes local diff hunks using the diff package's structuredPatch (aligned with DSH localHunks).
 * Falls back to full replacement if structuredPatch fails.
 * @param {Object} diff - The diff input object.
 * @param {string} [diff.oldText] - The old text content.
 * @param {string} diff.newText - The new text content.
 * @returns {Array} Array of hunk objects from structuredPatch, or a fallback full-replacement hunk.
 */
function localHunks(diff) {
  const oldLines = contentLines(diff.oldText ?? '');
  const newLines = contentLines(diff.newText);
  const result = structuredPatch(
    '', '',
    normalize(oldLines), normalize(newLines),
    undefined, undefined,
    { context: 3, maxEditLength: MAX_DIFF_EDIT_LENGTH }
  );
  if (result?.hunks) return result.hunks;
  // 降级：全量替换（与 DSH 一致）
  return [{
    lines: [
      ...oldLines.map(line => `-${line}`),
      ...newLines.map(line => `+${line}`),
    ]
  }];
}

/**
 * Flattens diff hunks into a renderable row list (aligned with DSH buildRows).
 * @param {string} oldText - The old text content.
 * @param {string} newText - The new text content.
 * @param {string} [fileName] - Optional file name for the path header row.
 * @returns {Array<{kind: string, text: string}>} Array of row objects with kind ('path'|'del'|'add'|'context'|'gap') and text.
 */
function buildRows(oldText, newText, fileName) {
  const rows = [];
  const diff = { path: fileName || 'diff', oldText, newText };

  // 文件路径头（与 DSH 一致）
  if (fileName) {
    rows.push({ kind: 'path', text: fileName });
  }

  const hunks = localHunks(diff);
  for (let index = 0; index < hunks.length; index++) {
    // 在连续 hunk 之间插入 gap（与 DSH 一致）
    if (index > 0) {
      rows.push({ kind: 'gap', text: '⋯' });
    }
    const hunk = hunks[index];
    for (const line of hunk.lines) {
      const kind = line.startsWith('-') ? 'del'
        : line.startsWith('+') ? 'add'
        : 'context';
      rows.push({ kind, text: line.slice(1) });
    }
  }

  return rows;
}

/**
 * Counts the number of added and removed lines (aligned with DSH diffTotals).
 * @param {Array<{kind: string}>} rows - Array of diff row objects.
 * @returns {{added: number, removed: number}} Object with added and removed line counts.
 */
function diffTotals(rows) {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added++;
    if (row.kind === 'del') removed++;
  }
  return { added, removed };
}

/**
 * Serializes diff rows into copyable plain text (aligned with DSH copyText).
 * @param {Array<{kind: string, text: string}>} rows - Array of diff row objects.
 * @returns {string} Plain text representation with +/- prefixes for diff lines.
 */
function copyText(rows) {
  return rows.map(row => {
    switch (row.kind) {
      case 'del': return `- ${row.text}`;
      case 'add': return `+ ${row.text}`;
      case 'context': return `  ${row.text}`;
      case 'path': return row.text;
      case 'gap': return row.text;
      default: return row.text;
    }
  }).join('\n');
}

// ─── DiffViewer 组件 ────────────────────────────────────────────────

/**
 * @component DiffViewer
 * @description Line-level diff viewer component aligned with DSH DiffBlock.
 * Supports inline and split view modes, large file folding, code wrapping toggle,
 * and clipboard copy. Uses the `diff` npm package for computing line-level differences.
 * @param {Object} props - Component props.
 * @param {string} props.oldContent - The original text content before changes.
 * @param {string} props.newContent - The modified text content after changes.
 * @param {string} [props.fileName] - Optional file name displayed in the toolbar header.
 * @param {'inline'|'split'} [props.defaultViewMode='inline'] - The default diff view mode.
 * @param {string} [props.oldLabel] - Optional label for the old version (shown in split view header).
 * @param {string} [props.newLabel] - Optional label for the new version (shown in split view header).
 * @returns {JSX.Element|null} The diff viewer element, or null if there are no rows to display.
 */
function DiffViewer({ oldContent, newContent, fileName, defaultViewMode = 'inline', oldLabel, newLabel }) {
  const [mode, setMode] = useState(defaultViewMode);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);

  const rows = useMemo(
    () => buildRows(oldContent, newContent, fileName),
    [oldContent, newContent, fileName]
  );

  const totals = useMemo(() => diffTotals(rows), [rows]);

  // 复制到剪贴板（与 DSH writeClipboard 一致）
  const onCopy = useCallback(() => {
    if (copied) return;
    const text = copyText(rows);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(ok => {
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        }
      }).catch(() => {});
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 1000);
      } catch {}
      document.body.removeChild(ta);
    }
  }, [copied, rows]);

  const onToggle = useCallback(() => setExpanded(v => !v), []);
  const onWrap = useCallback(() => setWrapped(v => !v), []);

  if (rows.length === 0) return null;

  // ─── 折叠逻辑（与 DSH DiffBlock 完全一致 — 包含所有行）──────────
  const hidden = rows.length - DEFAULT_DIFF_MAX_LINES;
  const capped = hidden > 0 && !expanded;
  const headLines = Math.ceil(DEFAULT_DIFF_MAX_LINES / 2);
  const tailLines = DEFAULT_DIFF_MAX_LINES - headLines;
  const head = capped ? rows.slice(0, headLines) : rows;
  const tail = capped ? rows.slice(rows.length - tailLines) : [];

  // ─── 行渲染（CSS class 与 DSH DiffBlock.module.css 完全对齐）────
  // 使用 CSS ::before 伪元素显示 +/- 前缀（与 DSH 一致）
  const renderRows = (rowsToRender, startKey = 0) => rowsToRender.map((row, i) => {
    // path 和 gap 行使用不同的样式
    if (row.kind === 'path' || row.kind === 'gap') {
      return h('div', {
        key: startKey + i,
        className: `rh-diff-line rh-diff-${row.kind}`,
      }, row.text);
    }
    // del/add/context 行使用 DSH 风格的 CSS ::before 前缀
    return h('div', {
      key: startKey + i,
      className: `rh-diff-line rh-diff-${row.kind}`,
    }, row.text);
  });

  // ─── 内联视图 ───
  const renderInline = () => h('div', {
    className: 'rh-diff-body',
  },
    renderRows(head),
    hidden > 0 && h(Button, {
      className: 'rh-btn rh-btn-ghost rh-btn-sm rh-diff-expand',
      onClick: onToggle,
      'aria-expanded': expanded,
    }, expanded ? t("FileTreeSidebar.message008") : t("DiffViewer.message001", { value0: hidden })),
    renderRows(tail, head.length)
  );

  // ─── 并排视图 ───
  const renderSplit = () => {
    // 分离 old/new 侧的行
    const oldSide = rows.filter(r => r.kind !== 'path' && r.kind !== 'add');
    const newSide = rows.filter(r => r.kind !== 'path' && r.kind !== 'del');

    const applyCap = (sideRows) => {
      if (!capped) return sideRows;
      return [
        ...sideRows.slice(0, headLines),
        { kind: 'gap', text: t("DiffViewer.message002", { value0: hidden }) },
        ...sideRows.slice(sideRows.length - tailLines),
      ];
    };

    return h('div', { className: 'rh-diff-split' },
      h('div', { className: 'rh-diff-pane rh-diff-pane-old' },
        h('div', { className: 'rh-diff-pane-header' }, t("DiffViewer.message003")),
        h('div', { className: 'rh-diff-body' }, renderRows(applyCap(oldSide)))
      ),
      h('div', { className: 'rh-diff-pane rh-diff-pane-new' },
        h('div', { className: 'rh-diff-pane-header' }, t("DiffViewer.message004")),
        h('div', { className: 'rh-diff-body' }, renderRows(applyCap(newSide)))
      )
    );
  };

  // ─── 主渲染 ───
  return h('div', {
    className: 'rh-diff-viewer',
    'data-diff': '',
    'data-code-wrap': wrapped ? 'true' : undefined,
  },
    // Header（工具栏）
    h('div', { className: 'rh-diff-toolbar' },
      h('div', { className: 'rh-diff-toolbar-left' },
        h('span', { className: 'rh-diff-filename' }, fileName || 'diff'),
        oldLabel && h('span', { className: ('rh-diff-version-label') + ' ' + css.mutedText }, `${oldLabel} → ${newLabel || ''}`),
        totals.added > 0 && h('span', { className: 'rh-diff-stat rh-diff-stat-add' }, `+${totals.added}`),
        totals.removed > 0 && h('span', { className: 'rh-diff-stat rh-diff-stat-del' }, `-${totals.removed}`)
      ),
      h('div', { className: 'rh-diff-toolbar-right' },
        // 视图模式切换
        h('div', { className: 'rh-diff-mode-toggle' },
          h(Button, {
            className: `rh-btn rh-btn-ghost rh-btn-sm rh-diff-mode-btn${mode === 'inline' ? ' active' : ''}`,
            'aria-pressed': mode === 'inline',
            onClick: () => setMode('inline'),
            title: t("DiffViewer.message005"),
          }, t("DiffViewer.message006")),
          h(Button, {
            className: `rh-btn rh-btn-ghost rh-btn-sm rh-diff-mode-btn${mode === 'split' ? ' active' : ''}`,
            'aria-pressed': mode === 'split',
            onClick: () => setMode('split'),
            title: t("DiffViewer.message007"),
          }, t("DiffViewer.message008"))
        ),
        // 换行切换
        h(Button, {
          className: 'rh-btn rh-btn-ghost rh-btn-sm rh-diff-toolbar-btn',
          onClick: onWrap,
          'aria-pressed': wrapped,
          title: wrapped ? t("DiffViewer.message009") : t("DiffViewer.message010"),
        }, wrapped ? t("DiffViewer.message009") : t("DiffViewer.message010")),
        // 复制
        h(Button, {
          className: 'rh-btn rh-btn-ghost rh-btn-sm rh-diff-toolbar-btn',
          onClick: onCopy,
          title: copied ? t("DiffViewer.message011") : t("DiffViewer.message012"),
        }, copied ? t("DiffViewer.message011") : t("DiffViewer.message012"))
      )
    ),
    // Body
    mode === 'split' ? renderSplit() : renderInline()
  );
}

module.exports = { DiffViewer, buildRows, diffTotals, copyText, contentLines };
