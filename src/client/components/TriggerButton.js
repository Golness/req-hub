'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef } = React;
const { createIconComponents } = require('../icons.js');

const { IconReqHub } = createIconComponents(h);
const { ROUTE } = require('../constants.js');

/**
 * @component
 * Trigger button that serves as the entry point for opening the documentation panel.
 * Displays a requirements hub icon with an optional "Req Hub" label (wide mode), and shows a tooltip
 * on hover with workspace documentation statistics. Auto-adjusts tooltip position
 * to stay within the viewport.
 * @param {Object} props - Component props
 * @param {Function} props.onClick - Callback invoked when the button is clicked
 * @param {boolean} [props.wide] - Whether to display the button in wide mode with a label
 * @returns {JSX.Element}
 */
function TriggerButton({ onClick, wide }) {
  const [hovered, setHovered] = useState(false);
  const [stats, setStats] = useState(null);
  const [docsDir, setDocsDir] = useState('docs');
  const [tooltipPos, setTooltipPos] = useState(null);
  const tooltipRef = useRef(null);
  const adjustCountRef = useRef(0);
  const cls = 'rh-trigger' + (wide ? '' : ' rh-trigger-rail');

  const loadConfig = () => {
    fetch(`${ROUTE}/config?t=${Date.now()}`, { cache: 'no-cache', headers: { 'Cache-Control': 'no-cache' } })
      .then(res => res.ok ? res.json() : null)
      .then(config => { if (config?.docsDir) setDocsDir(config.docsDir); })
      .catch(() => {});
  };

  useEffect(() => {
    loadConfig();
    window.addEventListener('focus', loadConfig);
    return () => window.removeEventListener('focus', loadConfig);
  }, []);

  useEffect(() => {
    if (!tooltipPos || !tooltipRef.current) return;
    if (adjustCountRef.current >= 3) return;
    const el = tooltipRef.current;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let newTop = tooltipPos.top;
    let newLeft = tooltipPos.left;
    if (rect.bottom > vh - 8) newTop = Math.max(8, vh - rect.height - 8);
    if (rect.right > vw - 8) newLeft = tooltipPos.left - rect.width - 16;
    if (newTop !== tooltipPos.top || newLeft !== tooltipPos.left) {
      adjustCountRef.current++;
      setTooltipPos({ top: newTop, left: newLeft });
    }
  }, [tooltipPos, stats]);

  const handleMouseEnter = (e) => {
    setHovered(true);
    adjustCountRef.current = 0;
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltipPos({ top: rect.top, left: rect.right + 8 });
    if (!stats) {
      fetch(`${ROUTE}/stats`).then(res => res.ok ? res.json() : null)
        .then(data => { if (data) setStats(data); }).catch(() => {});
    }
  };

  const handleMouseLeave = () => { setHovered(false); setTooltipPos(null); };
  const showTooltip = hovered && tooltipPos;

  return h('div', { className: 'rh-trigger-row' + (wide ? '' : ' rh-trigger-row-rail') },
    h('button', {
      type: 'button', className: cls, onClick,
      onMouseEnter: handleMouseEnter, onMouseLeave: handleMouseLeave,
      'aria-label': 'Req Hub',
    },
      h(IconReqHub, { size: 16, className: 'rh-trigger-icon', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      wide && h('span', { className: 'rh-trigger-label' }, 'Req Hub'),
    ),
    showTooltip && h('div', {
      ref: tooltipRef, className: 'rh-tooltip',
      style: { position: 'fixed', top: tooltipPos.top + 'px', left: tooltipPos.left + 'px', zIndex: 9999, maxHeight: 'calc(100vh - 16px)' },
      onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false),
    },
      h('div', { className: 'rh-tooltip-title' }, `Req Hub (${docsDir}/)`),
      !stats
        ? h('div', { className: 'rh-tooltip-row' }, 'Loading...')
        : stats.length === 0
          ? h('div', { className: 'rh-tooltip-row' }, 'No workspaces')
          : stats.map(s =>
              h('div', { key: s.workspaceId, className: 'rh-tooltip-row' },
                h('span', { className: 'rh-tooltip-name' }, s.title),
                h('span', { className: 'rh-tooltip-counts' },
                  s.exists ? `${s.docCount} docs` : `No ${docsDir}/`)
              )
            )
    )
  );
}

module.exports = { TriggerButton };
