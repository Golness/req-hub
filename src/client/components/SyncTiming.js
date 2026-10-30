'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { estimateSyncTiming } = require('../utils/syncTiming.js');
const h = React.createElement;

function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return t('syncTiming.seconds', { seconds });
  }
  if (seconds < 3600) {
    return t('syncTiming.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  }
  return t('syncTiming.hours', {
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
  });
}

/**
 * Present elapsed time and bounded estimates for the current chunk queue.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function SyncTiming({ sync }) {
  const [now, setNow] = React.useState(Date.now);
  const active = ['running', 'preparing', 'cancelling'].includes(sync.status);
  React.useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, sync.id]);
  const timing = estimateSyncTiming(sync, now);
  const elapsed =
    timing.elapsedMs === null ? '' : t('syncTiming.elapsed', { time: duration(timing.elapsedMs) });
  let detail;
  if (!active) {
    detail = '';
  } else if (timing.state === 'estimated') {
    detail = t('syncTiming.range', {
      lower: duration(timing.lowerMs),
      upper: duration(timing.upperMs),
    });
  } else {
    detail = t(`syncTiming.${timing.state}`);
  }
  return h(
    'div',
    { className: 'rh-sync-progress-eta' },
    [elapsed, detail].filter(Boolean).join(' · '),
  );
}
module.exports = { SyncTiming };
