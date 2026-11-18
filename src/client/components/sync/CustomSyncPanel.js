'use strict';
const { isLiveSync } = require('./Summary.js');
const { ActiveSyncSummary } = require('./Summary.js');
const { SyncDetailView } = require('./History.js');
const { PhasedSyncUI } = require('./PhasedSyncUI.js');
const clientApi = require('../../api/index.js');
const { t } = require('../../locale.js');
const css = require('../SyncPanel.module.css').default;
const { Button } = require('../shared/Button.js');
const { EmptyState } = require('../shared/EmptyState.js');
const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef } = React;
const { DocsViewerContext, SessionSelectionContext } = require('../../context.js');
// ─── SyncPanel ───────────────────────────────────────────────────
// Sync requirement or design docs with code changes from git branch
// Use phased sync for both requirement and technical documents.
/**
 * @component
 * Main sync panel for synchronizing requirement or design documentation with code changes
 * from a git branch. Provides two sync modes: requirement docs and design docs.
 * Supports selecting document types and resuming active sync operations.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The workspace ID for sync operations
 * @param {Object|null} props.selectedReq - The currently selected requirement object, or null if none selected
 * @returns {JSX.Element}
 */
function CustomSyncPanel({ workspaceId, selectedReq }) {
  const [syncDocType, setSyncDocType] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [view, setView] = useState('main');
  const [selectedHistorySync, setSelectedHistorySync] = useState(null);
  const [activeTask, setActiveTask] = useState(null);
  const { refreshTree, syncActivity } = React.useContext(DocsViewerContext);
  useEffect(() => {
    const removed = (event) => {
      const task = event.detail;
      if (task.workspaceId !== workspaceId || task.requirementId !== selectedReq?.id) {
        return;
      }
      setActiveTask((previous) =>
        previous &&
        (task.id ? previous.id === task.id : previous.notificationId === task.notificationId)
          ? null
          : previous,
      );
      if (syncDocType || selectedHistorySync?.snapshotDir === task.snapshotDir) {
        setSyncDocType(null);
        setSyncing(false);
        setSelectedHistorySync(null);
        setView('main');
      }
    };
    window.addEventListener('req-hub-sync-deleted', removed);
    return () => window.removeEventListener('req-hub-sync-deleted', removed);
  }, [workspaceId, selectedReq?.id, syncDocType, selectedHistorySync]);

  // Keep a visible return entry even after leaving preparation or progress.
  useEffect(() => {
    setActiveTask(null);
    if (!selectedReq?.id || !workspaceId) {
      return;
    }
    const controller = new AbortController();
    clientApi
      .request(
        clientApi.endpoint(
          'sync-active',
          `workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`,
        ),
        { signal: controller.signal },
      )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!controller.signal.aborted) {
          setActiveTask(data?.active ? data.sync : null);
        }
      })
      .catch((error) => {
        // Keep the current view when optional active-task discovery fails.
      });
    return () => controller.abort();
  }, [workspaceId, selectedReq?.id, syncDocType]);
  let resumable;
  if (isLiveSync(syncActivity)) {
    resumable = syncActivity;
  } else if (isLiveSync(activeTask)) {
    resumable = activeTask;
  } else {
    resumable = null;
  }

  if (!selectedReq) {
    return h(EmptyState, {
      title: t('DocsViewerBody.message065'),
      description: t('SyncPanel.message001'),
    });
  }

  // View sync detail
  if (view === 'detail' && selectedHistorySync) {
    return h(SyncDetailView, {
      sync: selectedHistorySync,
      workspaceId: selectedHistorySync.workspaceId || workspaceId,
      requirementPath: selectedReq.path,
      onUpdate: (next) => setActiveTask(isLiveSync(next) ? next : null),
      onBack: () => {
        setView('main');
        setSelectedHistorySync(null);
      },
    });
  }

  // If a sync is in progress or showing results, show the phased sync UI
  if (syncDocType) {
    return h(PhasedSyncUI, {
      workspaceId,
      selectedReq,
      activeTab: syncDocType,
      syncing,
      setSyncing,
      onClose: () => {
        setSyncDocType(null);
        setSyncing(false);
      },
      refreshTree,
    });
  }

  // Main sync view
  return h(
    'div',
    { className: 'rh-op-panel' },
    // Current requirement summary
    selectedReq &&
      h(
        'div',
        { className: 'rh-req-card' },
        h('div', { className: 'rh-req-card-title' }, selectedReq.title),
        h(
          'div',
          { className: 'rh-req-card-row' },
          t('requirement.developerLabel'),
          selectedReq.developer,
        ),
        h('div', { className: 'rh-req-card-row' }, t('requirement.dateLabel'), selectedReq.date),
        h(
          'div',
          { className: 'rh-req-card-row' },
          t('requirement.documentCountLabel'),
          selectedReq.fileCount,
        ),
      ),

    resumable &&
      h(ActiveSyncSummary, {
        task: resumable,
        onOpen: () => {
          setSelectedHistorySync(resumable);
          setView('detail');
        },
      }),
    h(
      'div',
      { className: css.homeActions },
      !resumable &&
        h(
          Button,
          {
            onClick: () => setSyncDocType('requirement'),
          },
          t('SyncPanel.message003'),
        ),
      !resumable &&
        h(
          Button,
          {
            onClick: () => setSyncDocType('design'),
          },
          t('SyncPanel.message004'),
        ),
    ),
  );
}

module.exports = { CustomSyncPanel };
