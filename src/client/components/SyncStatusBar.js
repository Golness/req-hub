'use strict';
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const React = require('react');
const h = React.createElement;
const model = require('../../shared/sync-task.cjs');
const { DeleteSyncTaskButton } = require('./shared/DeleteSyncTaskButton.js');
const { syncActivityText, syncErrorText } = require('../utils/syncFeedback.js');

/**
 * Keep scoped sync activity visible outside the operation page.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function SyncStatusBar({ monitor, onOpen }) {
  const task = monitor.notification;
  if (!task) {
    return null;
  }
  const active = model.isSyncActive(task) || task.status === 'preparing';
  const steps = task.steps || [];
  const step = steps.find((item) => ['running', 'queued'].includes(item.status));
  const done = steps.filter((item) => ['completed', 'skipped'].includes(item.status)).length;
  const chunks = step?.chunks || [];
  const chunkDone = chunks.filter((item) => ['completed', 'skipped'].includes(item.status)).length;
  let text;
  if (task.status === 'cancelling') {
    text = t('SyncStatusBar.message001');
  } else if (active) {
    text = t('SyncStatusBar.message002');
  } else {
    text =
      {
        completed: t('SyncStatusBar.message003'),
        failed: t('SyncStatusBar.message004'),
        aborted: t('SyncStatusBar.message005'),
      }[task.status] || t('SyncStatusBar.message006');
  }
  let detail;
  if (active) {
    detail = t('SyncStatusBar.message009', {
      value0: step?.activity
        ? syncActivityText(step.activity)
        : step?.label || t('SyncStatusBar.message007'),
      value1: done,
      value2: steps.length,
      value3: chunks.length
        ? t('SyncStatusBar.message008', { value0: chunkDone, value1: chunks.length })
        : '',
    });
  } else if (task.error) {
    detail = ` · ${syncErrorText(task.error)}`;
  } else {
    detail = '';
  }
  return h(
    'div',
    {
      className: 'rh-sync-status',
      role: 'status',
      'aria-live': 'polite',
      'data-status': task.status,
    },
    h(
      Button,
      {
        type: 'button',
        className: 'rh-btn rh-btn-ghost rh-btn-sm rh-sync-status-link',
        disabled: !task.id,
        onClick: () => {
          onOpen(task);
          monitor.dismiss();
        },
        title: `${task.requirementId} · ${text}${detail}`,
      },
      `${task.docTypeName || (task.docType === 'design' ? t('documents.design') : t('DocsViewerBody.message073'))} · ${task.requirementId} · ${text}${detail}`,
    ),
    monitor.error &&
      h(
        Button,
        { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: monitor.refresh },
        monitor.error + t('SyncStatusBar.message010'),
      ),
    h(DeleteSyncTaskButton, { task }),
    !active &&
      h(
        Button,
        {
          type: 'button',
          className: 'rh-btn rh-btn-ghost rh-btn-sm',
          'aria-label': t('SyncStatusBar.message011'),
          onClick: monitor.dismiss,
        },
        t('common.close'),
      ),
  );
}
module.exports = { SyncStatusBar };
