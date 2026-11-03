'use strict';
const React = require('react');
const { Button } = require('./shared/Button.js');
const { DeleteSyncTaskButton } = require('./shared/DeleteSyncTaskButton.js');
const { t } = require('../locale.js');
const css = require('./SyncHistory.module.css').default;
const h = React.createElement;

function statusLabel(status) {
  const keys = {
    completed: 'SyncStatusBar.message003',
    failed: 'SyncStatusBar.message004',
    aborted: 'SyncStatusBar.message005',
    cancelling: 'SyncStatusBar.message001',
  };
  return t(keys[status] || 'SyncStatusBar.message002');
}

/**
 * Keep record metadata, navigation and deletion in separate, consistently aligned rows.
 * @param props - Filtered history and existing selection/deletion callbacks.
 * @returns Accessible history records without clickable containers around action buttons.
 */
function SyncHistoryRecords({ history, workspaceId, requirementId, onSelect, onDeleted }) {
  return h(
    'div',
    { className: css.records },
    history.map((sync) => {
      const activeSteps = (sync.steps || []).filter((item) => item.status !== 'skipped');
      const completed = activeSteps.filter((item) => item.status === 'completed').length;
      const date = new Date(sync.startedAt);
      const validDate = !Number.isNaN(date.getTime());
      return h(
        'article',
        { key: sync.id, className: css.record, 'data-sync-record': sync.id },
        h(
          'header',
          { className: css.recordHeading },
          h('h4', null, sync.docTypeName),
          h(
            'span',
            { className: css.status, 'data-status': sync.status },
            statusLabel(sync.status),
          ),
        ),
        h(
          'div',
          { className: css.metadata },
          h(
            'time',
            { dateTime: validDate ? date.toISOString() : undefined },
            validDate ? date.toLocaleString() : t('VersionSelect.message001'),
          ),
          h('code', null, (sync.commitHash || sync.id).slice(0, 8)),
        ),
        h(
          'div',
          { className: css.metrics },
          h(
            'span',
            null,
            t('SyncPanel.message051', { value0: completed, value1: activeSteps.length }),
          ),
          h('span', null, t('SyncPanel.message052', { value0: sync.generatedFiles?.length || 0 })),
          sync.stats &&
            h('span', null, t('SyncPanel.message053', { value0: sync.stats.totalLLMCalls || 0 })),
        ),
        h(
          'footer',
          { className: css.recordActions },
          h(
            Button,
            { size: 'sm', variant: 'outline', onClick: () => onSelect(sync) },
            t('sync.history.details'),
          ),
          h(
            'div',
            { className: css.deleteActions },
            h(DeleteSyncTaskButton, {
              task: { ...sync, workspaceId, requirementId },
              onDeleted: (task) => onDeleted(task, 'attempt'),
            }),
            h(DeleteSyncTaskButton, {
              scope: 'task',
              task: { ...sync, workspaceId, requirementId },
              onDeleted: (task) => onDeleted(task, 'task'),
            }),
          ),
        ),
      );
    }),
  );
}
module.exports = { SyncHistoryRecords };
