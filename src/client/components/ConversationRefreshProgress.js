'use strict';
const React = require('react');
const { t } = require('../locale.js');
const h = React.createElement;
/**
 * Present refresh progress without treating pending work as successful.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function ConversationRefreshProgress({ progress, source = 'DSH' }) {
  if (!progress) {
    return null;
  }
  const key =
    {
      queued: 'conversationSources.queued',
      inventory: 'conversationSources.inventory',
      saving: 'conversationSources.saving',
    }[progress.phase] || 'conversationSources.importing';
  return h(
    'div',
    { className: 'rh-codex-progress', role: 'status', 'aria-live': 'polite' },
    h('span', null, t(key, { source, completed: progress.completed, total: progress.total })),
    h('progress', {
      'aria-label': t('conversationSources.progress', { source }),
      max: progress.total || 1,
      value: progress.total == null ? undefined : progress.completed,
    }),
  );
}
module.exports = { ConversationRefreshProgress };
