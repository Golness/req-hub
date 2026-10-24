'use strict';
const React = require('react'), h = React.createElement;
const { ROUTE } = require('../../constants.js');

function DeleteSyncTaskButton({ task, onDeleted }) {
  const [busy, setBusy] = React.useState(false);
  if (!task?.id && !task?.notificationId) return null;
  const remove = async event => {
    event.stopPropagation(); if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`${ROUTE}/sync-delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: task.workspaceId, requirementId: task.requirementId, syncId: task.id, snapshotDir: task.snapshotDir, notificationId: task.notificationId }) });
      const result = await response.json();
      if (!response.ok || !result.success) return;
      window.dispatchEvent(new CustomEvent('req-hub-sync-deleted', { detail: task }));
      window.dispatchEvent(new Event('req-hub-sync-change'));
      onDeleted?.(task);
    } catch { /* No termination-failure popup; leave the action available for a network retry. */ }
    finally { setBusy(false); }
  };
  return h('button', { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: busy, onClick: remove,
    title: '删除任务与中间文件，保留正式文档', 'aria-label': '删除同步任务' }, busy ? '删除中…' : '删除任务');
}
module.exports = { DeleteSyncTaskButton };
