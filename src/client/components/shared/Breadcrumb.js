'use strict';
const React = require('react');
const h = React.createElement;

/**
 * @component Breadcrumb
 * @description Breadcrumb navigation component that renders a hierarchical path of navigable items.
 * @param {Object} props - Component props.
 * @param {Array<{label: string, onClick?: Function}>} props.items - Array of breadcrumb items. Each item has a label and optional onClick handler.
 * @param {Function} [props.onNavigate] - Callback invoked when a breadcrumb link is clicked. Receives the item object.
 * @returns {JSX.Element|null} The breadcrumb navigation element, or null if no items are provided.
 */
function Breadcrumb({ items, onNavigate }) {
  if (!items || items.length === 0) return null;

  // 构建扁平元素列表（避免嵌套数组导致的 React key 警告）
  const elements = [];
  items.forEach((item, i) => {
    // 分隔符（第一项之前不显示）
    if (i > 0) {
      elements.push(h('span', {
        key: `sep-${i}`,
        className: 'rh-breadcrumb-sep',
        'aria-hidden': 'true',
      }, ' / '));
    }
    // 链接或当前项
    if (i < items.length - 1) {
      elements.push(h('button', {
        key: `link-${i}`,
        className: 'rh-breadcrumb-link',
        onClick: () => onNavigate ? onNavigate(item) : (item.onClick && item.onClick()),
        'aria-label': `导航到 ${item.label}`,
      }, item.label));
    } else {
      elements.push(h('span', {
        key: `current-${i}`,
        className: 'rh-breadcrumb-current',
        'aria-current': 'page',
      }, item.label));
    }
  });

  return h('nav', {
    className: 'rh-breadcrumb',
    'aria-label': '路径导航',
  }, ...elements);
}

module.exports = { Breadcrumb };
