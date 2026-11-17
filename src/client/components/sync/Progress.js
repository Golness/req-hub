'use strict';

const clientApi = require('../../api/index.js');
const { localizeMessage, clientError } = require('../../utils/serverMessage.js');
const { formatDateTime, useTimeZone } = require('../../time.js');
const { SyncStepList } = require('../SyncSteps.js');
const progressCss = require('../SyncProgress.module.css').default;
const { t } = require('../../locale.js');
const css = require('../SyncPanel.module.css').default;
const { cssValue } = require('../shared/presentation.js');
const { Button } = require('../shared/Button.js');
const { ActionBar } = require('../shared/ActionBar.js');
const { ModalFrame } = require('../shared/ModalFrame.js');
const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('../shared/HeaderBack.js');
const { useState, useEffect, useRef } = React;
const syncTaskModel = require('../../../shared/sync-task.cjs');
const { syncActivityText, syncErrorText, syncPhaseLabel } = require('../../utils/syncFeedback.js');
const { SyncTiming } = require('../SyncTiming.js');
const { DeleteSyncTaskButton } = require('../shared/DeleteSyncTaskButton.js');
const { showToast } = require('../shared/ToastContainer.js');
const { createIconComponents } = require('../../icons.js');
const { IconSync, IconError, IconCheck, IconCancel, IconChevronDown } = createIconComponents(h);
// ─── SyncProgressView - Active sync progress display ────────────
/**
 * @component
 * Keep the task overview and actions fixed while active or historical steps scroll.
 * Preserve the existing abort confirmation, deletion and artifact preview behavior.
 * @param {Object} props - Component props
 * @param {Object} props.sync - The sync operation object with status, steps, and metadata
 * @param {Function} props.onBack - Callback invoked to return to the previous view
 * @param {Function} props.onViewFile - Callback invoked when a generated file is clicked
 * @param {string} props.workspaceId - The workspace ID
 * @param {string} props.requirementId - The requirement ID
 * @param {Function} [props.onSyncAborted] - Callback invoked after a sync is successfully aborted
 * @returns {JSX.Element}
 */
function SyncProgressView({
  sync,
  onBack,
  onViewFile,
  workspaceId,
  requirementId,
  requirementPath,
  onSyncAborted,
  onRetry,
}) {
  useTimeZone();
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [aborting, setAborting] = useState(false);

  // Calculate progress — skipped steps are excluded from the count
  const allSteps = sync.steps || [];
  const activeSteps = allSteps.filter((s) => s.status !== 'skipped');
  const totalSteps = activeSteps.length;
  const completedSteps = activeSteps.filter((s) => s.status === 'completed').length;
  const progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  const handleAbort = async () => {
    setAborting(true);
    try {
      const res = await clientApi.request(clientApi.endpoint('sync-abort'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          requirementId,
          syncId: sync.id,
          snapshotDir: sync.snapshotDir,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setShowAbortConfirm(false);
        showToast({
          tone: 'warning',
          text:
            data.status === 'cancelling' ? t('SyncPanel.message029') : t('SyncPanel.message030'),
          holdMs: 3000,
        });
        onSyncAborted?.();
      } else {
        showToast({ tone: 'error', text: data.error || t('SyncPanel.message031'), holdMs: 3000 });
      }
    } catch (e) {
      showToast({
        tone: 'error',
        text: t('SyncPanel.message032') + localizeMessage(e.message),
        holdMs: 3000,
      });
    } finally {
      setAborting(false);
    }
  };

  const renderSyncStatus = () => {
    if (syncTaskModel.isSyncActive(sync)) {
      return h(
        'span',
        { className: css.row11 },
        h(IconSync, { size: 14 }),
        sync.status === 'cancelling' ? t('SyncPanel.message033') : t('SyncPanel.message034'),
      );
    } else if (sync.status === 'completed') {
      return h(
        'span',
        { className: css.row11 },
        h(IconCheck, { size: 14 }),
        t('SyncPanel.message035'),
      );
    } else if (sync.status === 'aborted') {
      return h(
        'span',
        { className: css.row14 },
        h(IconCancel, { size: 14 }),
        t('SyncPanel.message036'),
      );
    } else {
      return h(
        'span',
        { className: css.row11 },
        h(IconError, { size: 14 }),
        t('SyncPanel.message037'),
      );
    }
  };
  return h(
    'div',
    { className: progressCss.view, 'data-sync-progress': '', 'data-status': sync.status },
    // Header
    h(
      'div',
      { className: progressCss.overview },
      h(
        'div',
        { className: progressCss.heading },
        h(HeaderBack, { onBack }),
        h('span', { className: progressCss.status }, renderSyncStatus()),
      ),
      h(
        'div',
        { className: progressCss.meta },
        h('span', null, t('sync.documentTypeLabel'), sync.docTypeName),
        h('span', null, t('SyncPanel.message038'), formatDateTime(sync.startedAt)),
        sync.completedAt &&
          h('span', null, t('SyncPanel.message039'), formatDateTime(sync.completedAt)),
        sync.abortedAt &&
          h('span', null, t('SyncPanel.message040'), formatDateTime(sync.abortedAt)),
      ),
      // Progress bar
      h(
        'div',
        { className: 'rh-sync-progress' + ' ' + progressCss.progress },
        h(
          'div',
          { className: 'rh-sync-progress-header' },
          h(
            'span',
            null,
            t('SyncPanel.message041', { value0: completedSteps, value1: totalSteps }),
          ),
          h('span', { className: 'rh-sync-progress-percent' }, `${progress}%`),
        ),
        h(
          'div',
          { className: 'rh-sync-progress-bar' },
          h('div', {
            className: 'rh-sync-progress-fill ' + css.size2 + ' ' + progressCss.fill,
            'data-status': sync.status,
            style: {
              '--rh-width-0': cssValue(`${progress}%`),
              '--rh-background-1': cssValue(
                sync.status === 'aborted' ? 'var(--dsw-alias-state-warn-primary)' : undefined,
              ),
            },
            role: 'progressbar',
            'aria-label': t('sync.progress.label'),
            'aria-valuenow': progress,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          }),
        ),
        h(SyncTiming, { sync }),
      ),
    ),
    // Steps
    h(
      'div',
      { className: progressCss.content },
      sync.error &&
        h('div', { className: 'rh-knowledge-error', role: 'alert' }, syncErrorText(sync.error)),
      ['failed', 'aborted'].includes(sync.status) &&
        sync.publishState === 'state_committed' &&
        h('div', { className: 'rh-op-info' }, t('SyncPanel.message043')),
      h(SyncStepList, {
        task: { ...sync, workspaceId, requirementId },
        onRetry,
        steps: sync.steps,
        generatedFiles: sync.generatedFiles,
        workspaceId: sync.workspaceId,
        requirementId: sync.requirementId,
        onViewFile: onViewFile,
      }),
    ),
    sync.id &&
      h(
        ActionBar,
        {
          placement: 'page',
          className: progressCss.footer,
          'aria-label': t('sync.progress.actions'),
          leading: h(DeleteSyncTaskButton, {
            task: { ...sync, workspaceId, requirementId },
            onDeleted: onBack,
          }),
        },
        sync.status === 'running' &&
          sync.id &&
          h(
            Button,
            {
              variant: 'outline',
              tone: 'warning',
              onClick: () => setShowAbortConfirm(true),
            },
            t('SyncPanel.message044'),
          ),
      ),
    // Abort confirmation dialog
    showAbortConfirm &&
      h(
        ModalFrame,
        {
          className: 'rh-confirm-overlay',
          onClick: () => !aborting && setShowAbortConfirm(false),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('SyncPanel.message045'),
        },
        h(
          'div',
          {
            className: 'rh-confirm-dialog',
            onClick: (e) => e.stopPropagation(),
          },
          h(
            'div',
            { className: 'rh-confirm-header' },

            h('h3', { className: 'rh-confirm-title' }, t('SyncPanel.message046')),
          ),
          h(
            'div',
            { className: 'rh-confirm-body' },
            h('p', { className: 'rh-confirm-message' }, t('SyncPanel.message047')),
          ),
          h(
            'div',
            { className: 'rh-confirm-footer' },
            h(
              Button,
              {
                className: 'rh-btn',
                onClick: () => setShowAbortConfirm(false),
                disabled: aborting,
              },
              t('common.cancel'),
            ),
            h(
              Button,
              {
                variant: 'outline',
                tone: 'warning',
                onClick: handleAbort,
                disabled: aborting,
              },
              aborting ? t('SyncPanel.message048') : t('SyncPanel.message049'),
            ),
          ),
        ),
      ),
  );
}

module.exports = { SyncProgressView };
