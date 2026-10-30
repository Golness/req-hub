'use strict';
const { t } = require('../locale.js');
const React = require('react');
const { HoverCard } = require('./shared/controls.js');
const { createIconComponents } = require('../icons.js');
const { ROUTE } = require('../constants.js');
const css = require('./TriggerButton.module.css').default;
const h = React.createElement;
const { IconReqHub } = createIconComponents(h);
/**
 * Open the requirement panel and load optional workspace counts on demand.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function TriggerButton({ onClick, wide }) {
  const [stats, setStats] = React.useState(null);
  const load = () => {
    fetch(`${ROUTE}/stats`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setStats)
      .catch((error) => {
        // Workspace counts are optional; retain the last successful statistics.
      });
  };
  const anchor = h(
    'button',
    {
      type: 'button',
      className: css.trigger + (wide ? '' : ' ' + css.rail),
      onClick,
      onMouseEnter: load,
      onFocus: load,
      'aria-label': t('common.brand'),
    },
    h(IconReqHub, { size: 16 }),
    wide && h('span', { className: css.label }, t('common.brand')),
  );
  const content = h(
    'div',
    { className: 'rh-workspace-summary' },
    h('strong', null, t('common.brand')),
    stats?.length
      ? stats.map((item) => {
          let statisticsLabel;
          if (item.errorCode) {
            statisticsLabel = t('trigger.statsUnavailable');
          } else if (item.exists) {
            statisticsLabel = t('trigger.requirementCount', { count: item.requirementCount });
          } else {
            statisticsLabel = t('trigger.projectUnavailable');
          }
          return h(
            'div',
            { className: 'rh-tooltip-row', key: item.workspaceId },
            h('span', { title: item.projectPath }, item.title),
            h('span', null, statisticsLabel),
          );
        })
      : h('span', null, stats ? t('WorkspaceModal.message003') : t('common.loading')),
  );
  return h(HoverCard, {
    anchor,
    content,
    side: 'right',
    className: css.row + (wide ? '' : ' ' + css.railRow),
  });
}
module.exports = { TriggerButton };
