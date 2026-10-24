'use strict';

const React = require('react');
const h = React.createElement;
const { IconChevronRight } = require('../icons.js').createIconComponents(h);
const { useState, useCallback } = React;

/**
 * @component JsonViewer
 * @description Interactive JSON viewer with syntax highlighting and collapsible nodes.
 * Supports expanding/collapsing objects and arrays, with color-coded data types.
 * @param {Object} props - Component props
 * @param {*} props.data - The parsed JSON data to display
 * @param {number} [props.initialExpandLevel=2] - How many levels to expand by default
 * @returns {JSX.Element}
 */
function JsonViewer({ data, initialExpandLevel = 2 }) {
  const [expandedPaths, setExpandedPaths] = useState(new Set());

  const togglePath = useCallback((path) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const isExpanded = (path) => expandedPaths.has(path);

  const renderValue = (value, path, indent = 0) => {
    if (value === null) {
      return h('span', { className: 'rh-json-literal' }, 'null');
    }

    if (typeof value === 'boolean') {
      return h('span', { className: 'rh-json-literal' }, value.toString());
    }

    if (typeof value === 'number') {
      return h('span', { className: 'rh-json-number' }, value.toString());
    }

    if (typeof value === 'string') {
      return h('span', { className: 'rh-json-string' }, `"${value}"`);
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return h('span', null, '[]');
      }

      const expanded = isExpanded(path);
      return h('div', null,
        h('button', {
          type: 'button', className: 'rh-json-toggle',
          'aria-label': expanded ? '收起节点' : '展开节点', 'aria-expanded': expanded,
          onClick: () => togglePath(path)
        }, h(IconChevronRight, { size: 12, style: { transform: expanded ? 'rotate(90deg)' : 'none' } })),
        h('span', { className: 'rh-json-punctuation' }, ` Array(${value.length}) [`),
        expanded && h('div', { style: { marginLeft: indent * 20 } },
          value.map((item, index) =>
            h('div', { key: `${path}-${index}` },
              h('span', { className: 'rh-json-muted' }, ' '.repeat(indent * 2)),
              renderValue(item, `${path}-${index}`, indent + 1),
              index < value.length - 1 && h('span', { className: 'rh-json-punctuation' }, ',')
            )
          )
        ),
        expanded && h('span', { className: 'rh-json-punctuation' }, ']'),
        !expanded && h('span', { className: 'rh-json-muted' }, '...]')
      );
    }

    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 0) {
        return h('span', null, '{}');
      }

      const expanded = isExpanded(path);
      return h('div', null,
        h('button', {
          type: 'button', className: 'rh-json-toggle',
          'aria-label': expanded ? '收起节点' : '展开节点', 'aria-expanded': expanded,
          onClick: () => togglePath(path)
        }, h(IconChevronRight, { size: 12, style: { transform: expanded ? 'rotate(90deg)' : 'none' } })),
        h('span', { className: 'rh-json-punctuation' }, ` Object {`),
        expanded && h('div', { style: { marginLeft: indent * 20 } },
          keys.map((key, index) =>
            h('div', { key: `${path}-${key}` },
              h('span', { className: 'rh-json-muted' }, ' '.repeat(indent * 2)),
              h('span', { className: 'rh-json-key' }, `"${key}"`),
              h('span', { className: 'rh-json-punctuation' }, ': '),
              renderValue(value[key], `${path}-${key}`, indent + 1),
              index < keys.length - 1 && h('span', { className: 'rh-json-punctuation' }, ',')
            )
          )
        ),
        expanded && h('span', { className: 'rh-json-punctuation' }, '}'),
        !expanded && h('span', { className: 'rh-json-muted' }, '...}')
      );
    }

    return h('span', null, String(value));
  };

  return h('div', {
    className: 'rh-json-viewer',
    style: {
      fontFamily: 'var(--rh-font-code)',
      fontSize: 'var(--rh-font-size)',
      lineHeight: 1.6,
      padding: 8,
      overflow: 'auto',
      whiteSpace: 'pre',
    }
  }, renderValue(data, 'root', 0));
}

module.exports = { JsonViewer };
