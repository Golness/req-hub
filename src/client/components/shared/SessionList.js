'use strict';
const { t } = require('../../locale.js');
const { Button } = require('./Button.js');
const React = require('react');
const css = require('./SessionList.module.css').default;
const h = React.createElement;

// Prefer source activity time; importedAt describes the local copy rather than the conversation.
function sessionTime(session) {
  for (const value of [session.updatedAt, session.createdAt]) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    const time = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(time) && time > 0) {
      return time;
    }
  }
  return 0;
}

/**
 * Show recent DSH and Codex sessions first, with explicit selection availability.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function SessionList({
  sessions,
  selectedIds,
  onToggle,
  onView,
  loading,
  disabled = false,
  source = '',
  emptyText = t('SessionList.message001'),
}) {
  const id = React.useId();
  if (loading) {
    return h('p', { className: 'rh-sync-hint', role: 'status' }, t('common.loadingEllipsis'));
  }
  if (!sessions.length) {
    return h('p', { className: 'rh-sync-hint' }, emptyText);
  }
  return h(
    'div',
    { className: 'rh-session-list' },
    [...sessions]
      .sort((a, b) => sessionTime(b) - sessionTime(a))
      .map((session, index) => {
        const selected = selectedIds.includes(session.id);
        const available = !!session.snapshotVersion && session.syncTurnCount > 0;
        const blocked = disabled || (!selected && !available);
        let status = t('sessions.selectable');
        if (session.snapshotError) {
          status = t('SessionList.message003');
        } else if (!session.snapshotVersion) {
          status = t('sessions.notReady');
        } else if (!session.syncTurnCount) {
          status = t('sessions.noCompleteTurns');
        } else if (disabled) {
          status = t('sessions.temporarilyDisabled');
        }
        const time = sessionTime(session);
        const statusId = `${id}-${index}`;
        return h(
          'div',
          {
            key: session.id,
            className: `rh-session-row ${css.row}`,
            'data-unavailable': !available || disabled,
          },
          h(
            'label',
            {
              className: `rh-session-choice ${css.choice}`,
              'data-selected': selected,
              'data-blocked': blocked,
            },
            h('input', {
              type: 'checkbox',
              checked: selected,
              disabled: blocked,
              'aria-describedby': statusId,
              onChange: () => onToggle(session.id),
              'aria-label': t('SessionList.message002', {
                value0: source,
                value1: session.title || session.id,
              }),
            }),
            h(
              'span',
              { className: 'rh-session-info' },
              h(
                'span',
                { className: css.titleRow },
                h(
                  'span',
                  { className: 'rh-session-title', title: session.title },
                  session.title || session.id,
                ),
                h('span', { id: statusId, className: css.status }, status),
              ),
              h(
                'span',
                { className: 'rh-session-meta', title: session.snapshotError },
                !session.snapshotError &&
                  t('SessionList.message004', {
                    value0: session.turnCount ?? 0,
                    value1: session.syncTurnCount ?? 0,
                  }),
                time
                  ? `${session.snapshotError ? '' : ' · '}${new Date(time).toLocaleDateString()}`
                  : '',
              ),
            ),
          ),
          h(
            Button,
            {
              type: 'button',
              className: 'rh-btn rh-btn-ghost rh-btn-sm',
              disabled: !!session.snapshotError && !session.snapshotVersion,
              onClick: () => onView(session),
            },
            t('SessionList.message005'),
          ),
        );
      }),
  );
}
module.exports = { SessionList };
