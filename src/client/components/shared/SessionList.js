'use strict';
const React = require('react');
const h = React.createElement;

/** The same selection rows and content preview actions for DSH and Codex sessions. */
function SessionList({ sessions, selectedIds, onToggle, onView, loading, disabled = false, source = '', emptyText = '未找到相关会话' }) {
  if (loading) return h('p', { className: 'rh-sync-hint', role: 'status' }, '加载中…');
  if (!sessions.length) return h('p', { className: 'rh-sync-hint' }, emptyText);
  return h('div', { className: 'rh-session-list' }, sessions.map(session => h('div', { key: session.id, className: 'rh-session-row' },
    h('label', { className: 'rh-session-choice', 'data-selected': selectedIds.includes(session.id) },
      h('input', { type: 'checkbox', checked: selectedIds.includes(session.id),
        disabled: disabled || !selectedIds.includes(session.id) && (!session.snapshotVersion || !session.syncTurnCount),
        onChange: () => onToggle(session.id), 'aria-label': `选择${source}会话 ${session.title || session.id}` }),
      h('span', { className: 'rh-session-info' },
        h('span', { className: 'rh-session-title', title: session.title }, session.title || session.id),
        h('span', { className: 'rh-session-meta', title: session.snapshotError }, session.snapshotError ? '读取失败' : `${session.turnCount ?? 0} 轮（可同步 ${session.syncTurnCount ?? 0} 轮）`,
          session.createdAt ? ` · ${new Date(session.createdAt).toLocaleDateString()}` : '')
      )
    ),
    h('button', { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !!session.snapshotError && !session.snapshotVersion,
      onClick: () => onView(session) }, '查看内容')
  )));
}
module.exports = { SessionList };
