'use strict';
const React = require('react');
const { t } = require('../../locale.js');
const css = require('./AiTaskStatus.module.css').default;
const h = React.createElement;
const { Button } = require('./Button.js');
function AiTaskStatus({ startedAt, stage = 'preparing', cancelling = false, searched, read, activity, sessionId, onCancel, cancelDisabled, actions, children }) {
  const [now, setNow] = React.useState(Date.now);
  const [expanded, setExpanded] = React.useState(false);
  const detailsId = React.useId();
  const timestamp = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
  const start = React.useRef(Date.now());
  React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - (Number.isFinite(timestamp) ? timestamp : start.current)) / 1000));
  const lastActivityAt = activity?.lastActivityAt;
  const idleSeconds = Math.max(0, Math.floor((now - (lastActivityAt || timestamp || start.current)) / 1000));
  const unconfirmed = !!activity && idleSeconds >= 120;
  const known = ['repairing', 'waiting_model', 'generating', 'thinking', 'tool_call', 'tool_error', 'preparing', 'working', 'searching', 'reading', 'validating', 'submitted'].includes(stage) ? stage : 'working';
  const label = t(cancelling ? 'ai.cancelling' : unconfirmed ? 'ai.unconfirmed' : `ai.${known}`);
  const metric = (key, value) => h('div', { className: css.metric, key }, h('dt', null, t(key)), h('dd', null, value));
  return h('div', { className: css.status },
      h('div', { className: css.summary },
        h('span', { className: css.stage, title: label, role: 'status', 'aria-live': 'polite' }, label),
        h('div', { className: css.actions },
          h('small', { className: css.elapsed }, t('ai.elapsed', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })),
          h(Button, { size: 'sm', variant: 'ghost', 'aria-expanded': expanded, 'aria-controls': detailsId, onClick: () => setExpanded(value => !value) }, t('ai.details')),
          actions,
          onCancel && h(Button, { size: 'sm', variant: 'ghost', disabled: cancelDisabled || cancelling, onClick: onCancel }, t(cancelling ? 'enhancement.state.cancelling' : 'common.cancel')))),
      h('div', { id: detailsId, className: css.details, hidden: !expanded },
        h('dl', { className: css.metrics },
          Number.isFinite(searched) && metric('ai.retrieval', t('ai.knowledge', { searched, read: read || 0 })),
          activity && metric('ai.activity', lastActivityAt ? t('ai.lastActivity', { seconds: idleSeconds }) : t('ai.noActivity')),
          activity && metric('ai.output', t('ai.outputCounts', { output: activity.outputCharacters || 0, reasoning: activity.reasoningCharacters || 0, errors: activity.toolErrors || 0, tool: activity.toolCharacters || 0 })),
          activity?.searches > 0 && metric('ai.search', t('ai.searchCounts', { count: activity.searches, hits: activity.hits || 0 })),
          sessionId && metric('ai.session', sessionId)),
        children,
        h('small', { className: css.hint }, t(unconfirmed ? 'ai.idleHelp' : 'ai.waitHelp'))));
}
module.exports = { AiTaskStatus };
