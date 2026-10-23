'use strict';
const React = require('react');
const h = React.createElement;

/**
 * @component Skeleton
 * @description A skeleton loading placeholder that renders animated lines to indicate content is loading.
 * @param {Object} props - Component props.
 * @param {number} [props.lines=3] - Number of skeleton lines to render.
 * @param {string} [props.height='1em'] - CSS height value for each skeleton line.
 * @returns {JSX.Element} The skeleton loading element.
 */
function Skeleton({ lines = 3, height = '1em' }) {
  return h('div', { className: 'rh-skeleton', 'aria-busy': 'true' },
    Array.from({ length: lines }).map((_, i) =>
      h('div', {
        key: i,
        className: 'rh-skeleton-line',
        style: {
          width: i === lines - 1 ? '60%' : '100%',
          height: height,
        },
        'aria-hidden': 'true',
      })
    )
  );
}

module.exports = { Skeleton };
