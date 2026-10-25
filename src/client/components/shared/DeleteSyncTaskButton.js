'use strict';
const { t } = require('../../locale.js');
const { Button } = require('./Button.js');
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
  return h(Button, { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: busy, onClick: remove,
    title: t("DeleteSyncTaskButton.message001"), 'aria-label': t("DeleteSyncTaskButton.message002") }, busy ? t("DeleteSyncTaskButton.message003") : t("DeleteSyncTaskButton.message004"));
}
module.exports = { DeleteSyncTaskButton };
