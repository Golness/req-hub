'use strict';
const { t } = require('../../locale.js');
const css = require('./TableOfContents.module.css').default;
const { cssValue } = require('./presentation.js');
const React = require('react');
const h = React.createElement;

/**
 * @component TableOfContents
 * @description Renders a navigable table of contents extracted from document headings.
 * Supports hierarchical heading levels with indentation and active heading highlighting.
 * @param {Object} props - Component props.
 * @param {Array<{id: string, level: number, text: string}>} props.headings - Array of heading objects with id, level (1-6), and text.
 * @param {string} [props.activeId] - The ID of the currently active/visible heading.
 * @param {Function} [props.onNavigate] - Callback invoked when a heading is clicked. Receives the heading ID.
 * @returns {JSX.Element|null} The table of contents navigation element, or null if no headings are provided.
 */
function TableOfContents({ headings, activeId, onNavigate, width }) {
  const navRef = React.useRef(null);
  React.useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector('[aria-current="location"]');
    if (!active) return;
    const bounds = nav.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < bounds.top + 8) nav.scrollTop += item.top - bounds.top - 8;
    else if (item.bottom > bounds.bottom - 8) nav.scrollTop += item.bottom - bounds.bottom + 8;
  }, [activeId, headings]);
  if (!headings || headings.length === 0) return null;

  return h('nav', {
    ref: navRef,
    className: ('rh-toc') + ' ' + css.size,
    'aria-label': t("TableOfContents.message001"),
    style: { "--rh-width-0": cssValue(width || '100%') },
  },
    h('div', { className: 'rh-toc-title' }, t("TableOfContents.message002")),
    headings.map(heading =>
      h('button', {
        key: heading.id,
        className: (`rh-toc-item rh-toc-level-${heading.level}${activeId === heading.id ? ' active' : ''}`) + ' ' + css.content,
        style: { "--rh-padding-left-0": cssValue(`${(heading.level - 1) * 12 + 12}px`) },
        onClick: () => onNavigate && onNavigate(heading.id),
        'aria-current': activeId === heading.id ? 'location' : undefined,
      }, heading.text)
    )
  );
}

/**
 * Extracts headings from a Markdown string.
 * Parses lines matching the pattern `# Heading` through `###### Heading`
 * and generates stable IDs based on line number and content.
 * @param {string} markdown - The Markdown text to extract headings from.
 * @returns {Array<{id: string, level: number, text: string}>} An array of heading objects.
 */
function extractHeadings(markdown) {
  if (!markdown) return [];

  const headings = [];
  const lines = markdown.split('\n');

  lines.forEach((line, i) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const text = match[2].trim();
      // 生成稳定的 ID（基于行号和内容）
      const id = `heading-${i}-${text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}`;
      headings.push({
        id,
        level: match[1].length,
        text,
      });
    }
  });

  return headings;
}

module.exports = { TableOfContents, extractHeadings };
