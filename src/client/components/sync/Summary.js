'use strict';

const { t } = require('../../locale.js');
const css = require('../SyncPanel.module.css').default;
const { Button } = require('../shared/Button.js');
const React = require('react');
const h = React.createElement;
const syncTaskModel = require('../../../shared/sync-task.cjs');
const { syncActivityText, syncErrorText, syncPhaseLabel } = require('../../utils/syncFeedback.js');
const isLiveSync = (task) => task?.status === 'preparing' || syncTaskModel.isSyncActive(task);

function ActiveSyncSummary({ task, onOpen, label }) {
  const steps = task.steps || [];
  const current = steps.find((step) => ['running', 'queued'].includes(step.status));
  const completed = steps.filter((step) => step.status === 'completed').length;
  const total = steps.filter((step) => step.status !== 'skipped').length;
  const type = task.docType === 'design' ? t('documents.design') : t('DocsViewerBody.message073');
  const status =
    task.status === 'cancelling' ? t('SyncStatusBar.message001') : t('SyncStatusBar.message002');
  return h(
    'section',
    { className: css.activeSummary, 'aria-label': t('sync.summary.label') },
    h(
      'div',
      { className: css.activeSummaryText },
      h('div', { className: css.activeSummaryTitle }, t('sync.summary.title', { type, status })),
      h(
        'div',
        { className: css.activeSummaryDetail, role: 'status' },
        current?.activity ? syncActivityText(current.activity) : syncPhaseLabel(current),
        total > 0 &&
          h('span', null, t('SyncPanel.message041', { value0: completed, value1: total })),
      ),
      h('div', { className: css.activeSummaryDetail }, t('sync.summary.wait')),
    ),
    h(Button, { size: 'sm', onClick: onOpen }, label || t('sync.navigation.resume')),
  );
}

module.exports = { isLiveSync, ActiveSyncSummary };
