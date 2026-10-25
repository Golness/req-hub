'use strict';
const { t } = require('../../locale.js');
const { Button } = require('./Button.js');
const React = require('react');
const h = React.createElement;

/** The same selection rows and content preview actions for DSH and Codex sessions. */
function SessionList({ sessions, selectedIds, onToggle, onView, loading, disabled = false, source = '', emptyText = t("SessionList.message001") }) {
  if (loading) return h('p', { className: 'rh-sync-hint', role: 'status' }, t("common.loadingEllipsis"));
  if (!sessions.length) return h('p', { className: 'rh-sync-hint' }, emptyText);
  return h('div', { className: 'rh-session-list' }, sessions.map(session => h('div', { key: session.id, className: 'rh-session-row' },
    h('label', { className: 'rh-session-choice', 'data-selected': selectedIds.includes(session.id) },
      h('input', { type: 'checkbox', checked: selectedIds.includes(session.id),
        disabled: disabled || !selectedIds.includes(session.id) && (!session.snapshotVersion || !session.syncTurnCount),
        onChange: () => onToggle(session.id), 'aria-label': t("SessionList.message002", { value0: source, value1: session.title || session.id }) }),
      h('span', { className: 'rh-session-info' },
        h('span', { className: 'rh-session-title', title: session.title }, session.title || session.id),
        h('span', { className: 'rh-session-meta', title: session.snapshotError }, session.snapshotError ? t("SessionList.message003") : t("SessionList.message004", { value0: session.turnCount ?? 0, value1: session.syncTurnCount ?? 0 }),
          session.createdAt ? ` · ${new Date(session.createdAt).toLocaleDateString()}` : '')
      )
    ),
    h(Button, { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !!session.snapshotError && !session.snapshotVersion,
      onClick: () => onView(session) }, t("SessionList.message005"))
  )));
}
module.exports = { SessionList };
