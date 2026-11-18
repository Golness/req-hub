'use strict';
const { isLiveSync } = require('./Summary.js');
const { ActiveSyncSummary } = require('./Summary.js');
const { SyncProgressView } = require('./Progress.js');
const clientApi = require('../../api/index.js');
const { SyncDocTypeTabs } = require('../shared/SyncDocTypeTabs.js');
const { SyncHistoryRecords } = require('../SyncHistoryRecords.js');
const { Disclosure } = require('../shared/Disclosure.js');
const historyCss = require('../SyncHistory.module.css').default;
const { t } = require('../../locale.js');
const css = require('../SyncPanel.module.css').default;
const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('../shared/HeaderBack.js');
const { useState, useEffect, useRef } = React;
const { SyncVersionCompare } = require('../shared/SyncVersionCompare.js');
const { SyncStorageUsage } = require('../SyncStorageUsage.js');
const { FilePreview } = require('../FilePreview.js');
const { EmptyState } = require('../shared/EmptyState.js');
// ─── SyncHistoryView - List of past syncs ───────────────────────
/**
 * @component
 * Displays a list of past sync operations for a given workspace and requirement.
 * Each entry shows status, document type, timestamp, step progress, and file count.
 * @param {Object} props - Component props
 * @param {boolean} [props.active=true] - Refresh history only while its tab is visible.
 * @param {Function} props.onSelectSync - Callback invoked when a sync history entry is clicked
 * @param {string} props.workspaceId - The workspace ID
 * @param {string} props.requirementId - The requirement ID
 * @returns {JSX.Element}
 */
function SyncHistoryView({ onSelectSync, workspaceId, requirementId, active = true }) {
  const [history, setHistory] = useState([]);
  const [activeTask, setActiveTask] = useState(null);
  const [historyDocType, setHistoryDocType] = useState('requirement');
  const visibleHistory = history.filter((sync) => sync.docType === historyDocType);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [historyError, setHistoryError] = useState(null);

  useEffect(() => {
    if (!active) {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setHistoryError(null);
    clientApi
      .request(
        clientApi.endpoint(
          'sync-history',
          `workspaceId=${workspaceId}&requirementId=${encodeURIComponent(requirementId)}`,
        ),
        { signal: controller.signal },
      )
      .then((res) => {
        if (!res.ok) {
          throw new Error('SYNC_HISTORY_FAILED');
        }
        return res.json();
      })
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        setHistory(data.history || []);
        setActiveTask(data.activeSync || null);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHistoryError(t('common.loadFailed'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [workspaceId, requirementId, reloadKey, active]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const refresh = () => setReloadKey((value) => value + 1);
    window.addEventListener('req-hub-sync-change', refresh);
    return () => window.removeEventListener('req-hub-sync-change', refresh);
  }, [active]);

  const panelId = React.useId();
  const removeRecord = (task, scope) => {
    setHistory((previous) =>
      previous.filter((item) =>
        scope === 'task' ? item.taskId !== task.taskId : item.id !== task.id,
      ),
    );
  };
  let records;
  if (loading) {
    records = h('div', { role: 'status' }, t('common.loading'));
  } else if (!visibleHistory.length) {
    records = h(
      'div',
      { role: 'status' },
      t('SyncPanel.message050', {
        value0:
          historyDocType === 'design' ? t('documents.design') : t('DocsViewerBody.message073'),
      }),
    );
  } else {
    records = h(SyncHistoryRecords, {
      history: visibleHistory,
      workspaceId,
      requirementId,
      onSelect: onSelectSync,
      onDeleted: removeRecord,
    });
  }
  return h(
    'div',
    { className: historyCss.page, 'data-sync-history-list': '' },
    activeTask &&
      h(ActiveSyncSummary, {
        task: activeTask,
        onOpen: () => onSelectSync(activeTask),
        label: t('sync.navigation.active', { type: activeTask.docTypeName || activeTask.docType }),
      }),
    h(
      'div',
      { className: historyCss.filter },
      h(SyncDocTypeTabs, {
        value: historyDocType,
        onChange: setHistoryDocType,
        panelId,
      }),
    ),
    historyError && h('div', { role: 'alert' }, historyError),
    h(
      'div',
      {
        className: historyCss.content,
        id: panelId,
        role: 'tabpanel',
        'aria-labelledby': panelId + '-tab-' + historyDocType,
      },
      !loading &&
        history.length > 0 &&
        h(SyncVersionCompare, {
          history,
          workspaceId,
          requirementId,
          docType: historyDocType,
          showTypeTabs: false,
        }),
      h(
        'section',
        { className: historyCss.recordSection, 'aria-label': t('sync.history.records') },
        h(
          'header',
          { className: historyCss.sectionHeading },
          h('h3', null, t('sync.history.records')),
          !loading && h('span', null, t('sync.history.count', { count: visibleHistory.length })),
        ),
        records,
      ),
    ),
    h(
      Disclosure,
      { title: t('sync.history.storage'), className: historyCss.storage },
      h(SyncStorageUsage, { workspaceId, onChanged: () => setReloadKey((value) => value + 1) }),
    ),
  );
}

/**
 * Own history selection independently of the quick and custom synchronization forms.
 * @param props - The requirement scope, optional focused task and tab visibility.
 * @returns History or its selected task detail, with local return navigation.
 */
function SyncHistoryPanel({ workspaceId, selectedReq, focusedSync, active }) {
  const [selectedSync, setSelectedSync] = useState(focusedSync || null);
  useEffect(() => {
    setSelectedSync(focusedSync || null);
  }, [workspaceId, selectedReq?.id, focusedSync]);
  useEffect(() => {
    const removed = (event) => {
      const task = event.detail;
      if (
        task.workspaceId === workspaceId &&
        task.requirementId === selectedSync?.requirementId &&
        (task.id
          ? task.id === selectedSync.id
          : task.notificationId === selectedSync.notificationId)
      ) {
        setSelectedSync(null);
      }
    };
    window.addEventListener('req-hub-sync-deleted', removed);
    return () => window.removeEventListener('req-hub-sync-deleted', removed);
  }, [workspaceId, selectedSync?.id]);
  if (!selectedReq) {
    return h(EmptyState, {
      title: t('DocsViewerBody.message065'),
      description: t('SyncPanel.message001'),
    });
  }
  if (selectedSync) {
    return h(SyncDetailView, {
      sync: selectedSync,
      workspaceId,
      requirementPath: selectedSync.requirementPath || selectedReq.path,
      onBack: () => setSelectedSync(null),
    });
  }
  return h(SyncHistoryView, {
    workspaceId,
    requirementId: selectedReq.id,
    onSelectSync: (sync) =>
      setSelectedSync({
        ...sync,
        workspaceId,
        requirementId: sync.requirementId || selectedReq.id,
      }),
    active,
  });
}

// ─── SyncDetailView - View a specific sync's detail ─────────────
/**
 * @component
 * Displays detailed information about a specific sync operation, including the ability
 * to view generated files. Delegates to SyncProgressView for the main display and
 * FilePreview for viewing individual files.
 * @param {Object} props - Component props
 * @param {Object} props.sync - The sync object to display details for
 * @param {Function} props.onBack - Callback invoked to return to the previous view
 * @param {string} props.workspaceId - The workspace ID
 * @param {string} props.requirementPath - The requirement path for file preview
 * @returns {JSX.Element}
 */
function SyncDetailView({ sync: initialSync, onBack, workspaceId, requirementPath, onUpdate }) {
  const [sync, setSync] = useState(initialSync);
  const [pollError, setPollError] = useState(null);
  const [viewingFile, setViewingFile] = useState(null);
  useEffect(() => {
    setSync(initialSync);
  }, [initialSync]);
  useEffect(() => {
    if (!isLiveSync(sync)) {
      return;
    }
    const controller = new AbortController();
    let fetching = false;
    const poll = async () => {
      if (fetching) {
        return;
      }
      fetching = true;
      try {
        const preparing =
          sync.status === 'preparing' || (sync.status === 'cancelling' && !sync.snapshotDir);
        const url =
          sync.id && !preparing
            ? clientApi.endpoint(
                'sync-detail',
                `${new URLSearchParams({ id: sync.id, workspaceId, requirementId: sync.requirementId })}`,
              )
            : clientApi.endpoint('sync-overview');
        const response = await clientApi.request(url, { signal: controller.signal });
        if (!response.ok) {
          throw Error('SYNC_DETAIL_FAILED');
        }
        const data = await response.json();
        const next =
          data.sync ||
          [data.active, data.latest].find(
            (task) =>
              task?.workspaceId === workspaceId &&
              task.requirementId === sync.requirementId &&
              (!sync.notificationId ||
                task.notificationId === sync.notificationId ||
                task.startedAt === sync.startedAt),
          );
        if (!controller.signal.aborted && next) {
          setSync(next);
          onUpdate?.(next);
          setPollError(null);
        }
      } catch {
        if (!controller.signal.aborted) {
          setPollError(t('common.loadFailed'));
        }
      } finally {
        fetching = false;
      }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [workspaceId, sync.id, sync.snapshotDir, sync.notificationId, isLiveSync(sync)]);
  const displaySync = sync.status === 'preparing' ? { ...sync, status: 'running' } : sync;

  if (viewingFile) {
    return h(
      'div',
      { className: css.column },
      h(
        'div',
        { className: css.section2 },
        h(
          'div',
          { className: css.row16 },
          h(HeaderBack, { onBack: () => setViewingFile(null), label: t('common.back') }),
          h('span', { className: css.row20 }, ' ', viewingFile.fileName),
        ),
      ),
      h(
        'div',
        { className: css.pane4 },
        h(FilePreview, {
          workspaceId,
          readOnly: true,
          sourceUrl: clientApi.endpoint(
            'sync-file',
            `${new URLSearchParams({ workspaceId, requirementId: sync.requirementId, attemptId: sync.id, artifactId: viewingFile.artifactId })}`,
          ),
          name: viewingFile.fileName,
          requirement: null,
        }),
      ),
    );
  }

  return h(
    React.Fragment,
    null,
    pollError && h('div', { role: 'alert' }, pollError),
    h(SyncProgressView, {
      sync: displaySync,
      workspaceId: sync.workspaceId,
      requirementId: sync.requirementId,
      requirementPath,
      onBack,
      onViewFile: (fileName) => setViewingFile(fileName),
      onSyncAborted: () => {
        setSync((previous) => ({ ...previous, status: 'cancelling' }));
      },
      onRetry: (next) => {
        setSync(next);
        onUpdate?.(next);
      },
    }),
  );
}

module.exports = { SyncHistoryView, SyncHistoryPanel, SyncDetailView };
