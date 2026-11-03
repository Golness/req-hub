'use strict';
const { SyncStepList } = require('./SyncSteps.js');
const progressCss = require('./SyncProgress.module.css').default;
const { KnowledgeContextPicker } = require('./KnowledgeContextPicker.js');
const { SyncSetup } = require('./SyncSetup.js');
const { SyncDocTypeTabs } = require('./shared/SyncDocTypeTabs.js');
const { SyncHistoryRecords } = require('./SyncHistoryRecords.js');
const { Disclosure } = require('./shared/Disclosure.js');
const historyCss = require('./SyncHistory.module.css').default;
const { Checkbox } = require('./shared/controls.js');
const { t } = require('../locale.js');
const css = require('./SyncPanel.module.css').default;
const { cssValue } = require('./shared/presentation.js');
const { Button } = require('./shared/Button.js');
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Input } = require('./shared/Input.js');

const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('./shared/HeaderBack.js');
const { useState, useEffect, useRef } = React;
const syncTaskModel = require('../../shared/sync-task.cjs');
const { readSyncEvents } = require('../utils/syncEvents.js');
const { syncActivityText, syncErrorText } = require('../utils/syncFeedback.js');
const { SyncTiming } = require('./SyncTiming.js');
const { SyncVersionCompare } = require('./shared/SyncVersionCompare.js');
const { DeleteSyncTaskButton } = require('./shared/DeleteSyncTaskButton.js');
const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');
const { SyncStorageUsage } = require('./SyncStorageUsage.js');
const { FilePreview } = require('./FilePreview.js');
const { showToast } = require('./shared/ToastContainer.js');
const { SyncBranchPicker } = require('./SyncBranchPicker.js');
const { parseBranchName } = require('./CreateDirForm.js');
const { ConversationSources } = require('./ConversationSources.js');
const { ConversationManager } = require('./ConversationManager.js');
const { createIconComponents } = require('../icons.js');

const { IconSync, IconError, IconCheck, IconCancel, IconChevronDown } = createIconComponents(h);

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
        current?.activity
          ? syncActivityText(current.activity)
          : current?.label || syncActivityText(),
        total > 0 &&
          h('span', null, t('SyncPanel.message041', { value0: completed, value1: total })),
      ),
      h('div', { className: css.activeSummaryDetail }, t('sync.summary.wait')),
    ),
    h(Button, { size: 'sm', onClick: onOpen }, label || t('sync.navigation.resume')),
  );
}

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
 * @param {Function} props.onClose - Callback invoked to close the panel
 * @returns {JSX.Element}
 */
function CustomSyncPanel({ workspaceId, selectedReq, onClose }) {
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
    fetch(
      `${ROUTE}/sync-active?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`,
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
    return h(
      'div',
      { className: 'rh-op-panel' },
      h('div', { className: css.spacing }, t('SyncPanel.message001')),
      h(Button, { className: 'rh-btn', onClick: onClose }, t('common.close')),
    );
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

/**
 * Present quick and custom entries while retaining the existing sync executor.
 * @param props - Workspace, selected requirement and navigation callbacks.
 * @returns The tabbed synchronization panel.
 */
function SyncPanel(props) {
  const [tab, setTab] = useState(props.focusedSync ? 'history' : 'quick');
  const [historyRequirement, setHistoryRequirement] = useState(props.selectedReq);
  return h(
    'div',
    { className: css.panel },
    h(
      'div',
      { className: css.tabs },
      h(
        'div',
        { className: 'rh-workbench-tabs', role: 'tablist', 'aria-label': t('sync.tabs') },
        ['quick', 'custom', 'history'].map((id, index, tabs) =>
          h(
            'button',
            {
              key: id,
              id: `sync-tab-${id}`,
              type: 'button',
              role: 'tab',
              className: 'rh-workbench-tab',
              'aria-selected': tab === id,
              'aria-controls': `sync-content-${id}`,
              tabIndex: tab === id ? 0 : -1,
              onClick: () => setTab(id),
              onKeyDown: (event) => {
                let next;
                if (event.key === 'ArrowRight') {
                  next = (index + 1) % tabs.length;
                } else if (event.key === 'ArrowLeft') {
                  next = (index + tabs.length - 1) % tabs.length;
                } else if (event.key === 'Home') {
                  next = 0;
                } else if (event.key === 'End') {
                  next = tabs.length - 1;
                }
                if (next !== undefined) {
                  event.preventDefault();
                  setTab(tabs[next]);
                  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
                }
              },
            },
            t(`sync.${id}`),
          ),
        ),
      ),
      h(Button, { size: 'sm', variant: 'ghost', onClick: props.onClose }, t('common.close')),
    ),
    ['quick', 'custom', 'history'].map((id) =>
      h(
        'div',
        {
          key: id,
          className: css.body,
          id: `sync-content-${id}`,
          role: 'tabpanel',
          'aria-labelledby': `sync-tab-${id}`,
          hidden: tab !== id,
        },
        h(SyncTabContent, {
          id,
          props,
          active: tab === id,
          historyRequirement,
          onRequirementReady: setHistoryRequirement,
        }),
      ),
    ),
  );
}

/**
 * Own a local return-button target after removing the old shell title bar.
 * @param props - Tab identity and sync panel properties.
 * @returns A panel with navigation contained within its tab.
 */
function SyncTabContent({ id, props, active, historyRequirement, onRequirementReady }) {
  const context = React.useContext(DocsViewerContext);
  const [target, setTarget] = useState(null);
  let content;
  if (id === 'quick') {
    content = h(QuickSync, {
      key: props.workspaceId,
      workspaceId: props.workspaceId,
      onRequirementReady,
      active,
    });
  } else if (id === 'history') {
    content = h(SyncHistoryPanel, {
      key: `${props.workspaceId}:${historyRequirement?.id || ''}`,
      workspaceId: props.workspaceId,
      selectedReq: historyRequirement,
      focusedSync:
        props.focusedSync?.requirementId === historyRequirement?.id ? props.focusedSync : null,
      active,
    });
  } else {
    content = h(CustomSyncPanel, props);
  }
  return h(
    DocsViewerContext.Provider,
    { value: { ...context, headerBackTarget: target } },
    h('div', { className: 'rh-header-back-slot', ref: setTarget }),
    content,
  );
}

/**
 * Resolve the branch's directory through existing Host operations before syncing.
 * @param props - The workspace owning the local feature branch.
 * @returns The quick entry or the existing phased sync view without conversations.
 */
function QuickSync({ workspaceId, onRequirementReady, active }) {
  const [branch, setBranch] = useState('');
  const [requirement, setRequirement] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const request = useRef(null);
  const { refreshTree } = React.useContext(DocsViewerContext);
  useEffect(() => () => request.current?.abort(), []);

  const start = async () => {
    if (busy || !branch) {
      return;
    }
    const parsed = parseBranchName(branch.trim());
    if (!parsed?.developer) {
      setError(t('sync.quick.branchInvalid'));
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    const read = async (url, options = {}) => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json();
      controller.signal.throwIfAborted();
      if (!response.ok) {
        throw new Error(data.error || t('sync.loadFailed'));
      }
      return data;
    };
    try {
      const params = new URLSearchParams({
        workspaceId,
        requirementId: parsed.requirementId,
        targetBranch: branch.trim(),
      });
      const info = await read(`${ROUTE}/sync-branch-info?${params}`);
      if (info.targetBranch !== branch.trim() || info.targetBranchError) {
        throw new Error(t('sync.quick.branchInvalid'));
      }
      if (!info.baseBranch) {
        throw new Error(t('sync.quick.baseMissing'));
      }
      const find = async () => {
        const data = await read(`${ROUTE}/tree?${new URLSearchParams({ workspaceId })}`);
        for (const developer of data.tree.developers) {
          const item = developer.requirements.find((req) => req.id === parsed.requirementId);
          if (item) {
            return { ...item, developer: developer.name };
          }
        }
        return null;
      };
      let found = await find();
      if (!found) {
        try {
          await read(`${ROUTE}/create-dir`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, ...parsed, createBranch: false }),
          });
        } catch (creationError) {
          found = await find();
          if (!found) {
            throw creationError;
          }
        }
        found ||= await find();
        if (!found) {
          throw new Error(t('sync.quick.directoryMissing'));
        }
        refreshTree?.();
      }
      onRequirementReady?.(found);
      setRequirement({ ...found, targetBranch: branch.trim() });
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.message);
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  };

  if (requirement) {
    return h(PhasedSyncUI, {
      workspaceId,
      selectedReq: requirement,
      activeTab: 'requirement',
      quick: true,
      syncing,
      setSyncing,
      refreshTree,
      onClose: () => setRequirement(null),
    });
  }
  return h(
    'div',
    { className: css.quickForm },
    h('p', { className: css.quickDescription }, t('sync.quick.description')),
    h(
      'div',
      { className: css.quickRow },
      h(
        'div',
        { className: css.quickField },
        h(SyncBranchPicker, {
          workspaceId,
          value: branch,
          onChange: setBranch,
          disabled: busy,
          active,
        }),
      ),
      h(
        Button,
        {
          className: css.quickAction,
          variant: 'primary',
          disabled: busy || !branch,
          onClick: start,
        },
        h(IconSync, { size: 16 }),
        busy ? t('common.loading') : t('sync.quick.start'),
      ),
    ),
    error && h('p', { className: 'rh-error', role: 'alert' }, error),
  );
}

/**
 * @component
 * Displays the conversation turns of a session in an expandable list format.
 * Each turn shows ordered human input and labeled intermediate/final assistant text.
 * Supports expand all / collapse all functionality.
 * @param {Object} props - Component props
 * @param {string} props.sessionId - The session ID to load turns for
 * @param {string} props.sessionTitle - Display title for the session
 * @param {Function} props.onBack - Callback invoked to return to the previous view
 * @returns {JSX.Element}
 */
function SessionTurnsView({ workspaceId, sessionId, sessionTitle, snapshotVersion, onBack }) {
  const [turnsData, setTurnsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedTurns, setExpandedTurns] = useState(new Set());

  useEffect(() => {
    loadSessionTurns();
  }, [sessionId]);

  const loadSessionTurns = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${ROUTE}/session-turns?${new URLSearchParams({ workspaceId, sessionId, version: snapshotVersion })}`,
      );
      const data = await res.json();
      if (res.ok) {
        if (data.success) {
          setTurnsData(data);
        } else {
          setError(data.error || t('sync.loadFailed'));
        }
      } else {
        setError(data.error || t('sync.loadFailed'));
      }
    } catch (e) {
      console.error('Failed to load session turns:', e);
      setError(e.message || t('sync.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const toggleTurn = (turnNumber) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnNumber)) {
        next.delete(turnNumber);
      } else {
        next.add(turnNumber);
      }
      return next;
    });
  };

  const expandAll = () => {
    if (turnsData) {
      setExpandedTurns(new Set(turnsData.turns.map((t) => t.turnNumber)));
    }
  };

  const collapseAll = () => {
    setExpandedTurns(new Set());
  };

  if (loading) {
    return h(
      'div',
      { className: css.centered },
      h(HeaderBack, { onBack }),
      h('div', { className: css.mutedText }, t('common.loading')),
    );
  }

  if (error) {
    return h(
      'div',
      { className: css.section },
      h(HeaderBack, { onBack }),
      h('div', { className: css.row }, h(IconError, { size: 14 }), error),
    );
  }

  if (!turnsData || !turnsData.turns || turnsData.turns.length === 0) {
    return h(
      'div',
      { className: css.section },
      h(HeaderBack, { onBack: onBack, label: t('common.back') }),
      h('div', { className: css.mutedText2 }, t('SyncPanel.message006')),
    );
  }

  return h(
    'div',
    { className: css.column },
    // Header
    h(
      'div',
      { className: css.section2 },
      h(
        'div',
        { className: css.row2 },
        h(HeaderBack, { onBack: onBack, label: t('common.back') }),
        h('span', { className: css.heading }, sessionTitle || t('SyncPanel.message007')),
      ),
      h(
        'div',
        { className: css.row3 },
        h(
          'span',
          null,
          t('SyncPanel.message008', {
            value0: turnsData.turnCount || turnsData.turns?.length || 0,
          }),
        ),
        h('span', null, `•`),
        h(
          'span',
          null,
          t('SyncPanel.message009', { value0: ((turnsData.totalTokens || 0) / 1000).toFixed(1) }),
        ),
        h(
          'span',
          { className: css.spacing3 },
          expandedTurns.size === turnsData.turnCount
            ? h(
                Button,
                { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: collapseAll },
                t('SyncPanel.message010'),
              )
            : h(
                Button,
                { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: expandAll },
                t('SyncPanel.message011'),
              ),
        ),
      ),
    ),

    // Turns list
    h(
      'div',
      { className: css.pane },
      turnsData.turns.map((turn, idx) => {
        const isExpanded = expandedTurns.has(turn.turnNumber);
        const time = turn.time ? new Date(turn.time).toLocaleString() : '';
        const userInput = turn.messages?.find((message) => message.role === 'user')?.text || '';

        return h(
          'div',
          {
            key: idx,
            className: css.pane2,
          },
          // Turn header
          h(
            'div',
            {
              onClick: () => toggleTurn(turn.turnNumber),
              className: css.row4,
              style: {
                '--rh-background-1': cssValue(
                  isExpanded ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
                ),
              },
            },
            h(
              'span',
              { className: css.heading2 },
              t('SyncPanel.message012', { value0: turn.turnNumber }),
            ),
            h('span', { className: css.pane3 }, userInput.substring(0, 100)),
            !turn.syncable && h('span', { className: css.mutedText3 }, t('SyncPanel.message013')),
            h('span', { className: css.mutedText4 }, time),
            h(
              'span',
              {
                className: css.mutedText5,
                style: {
                  '--rh-transform-2': cssValue(isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'),
                },
              },
              h(IconChevronDown, { size: 12 }),
            ),
          ),

          // Turn content (expanded)
          isExpanded &&
            h(
              'div',
              { className: css.section3 },
              (turn.messages || []).map((message, messageIndex) =>
                h(
                  'div',
                  {
                    key: messageIndex,
                    className: css.spacing2,
                  },
                  h('div', { className: css.heading3 }, message.label),
                  h(
                    'div',
                    {
                      className: css.section4,
                      style: {
                        '--rh-border-left-7': cssValue(
                          '3px solid ' +
                            (message.kind === 'final'
                              ? 'var(--dsw-alias-state-success-primary)'
                              : 'var(--rh-accent)'),
                        ),
                      },
                    },
                    message.text,
                  ),
                ),
              ),
            ),
        );
      }),
    ),
  );
}

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
}) {
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [aborting, setAborting] = useState(false);

  // Calculate progress — skipped steps are excluded from the count
  const allSteps = sync.steps || [];
  const skippedSteps = allSteps.filter((s) => s.status === 'skipped');
  const activeSteps = allSteps.filter((s) => s.status !== 'skipped');
  const totalSteps = activeSteps.length;
  const completedSteps = activeSteps.filter((s) => s.status === 'completed').length;
  const failedSteps = activeSteps.filter((s) => s.status === 'failed').length;
  const runningSteps = activeSteps.filter((s) => s.status === 'running').length;
  const progress =
    totalSteps > 0 ? Math.round(((completedSteps + failedSteps) / totalSteps) * 100) : 0;

  const handleAbort = async () => {
    setAborting(true);
    try {
      const res = await fetch(`${ROUTE}/sync-abort`, {
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
      showToast({ tone: 'error', text: t('SyncPanel.message032') + e.message, holdMs: 3000 });
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
        h('span', null, t('SyncPanel.message038'), new Date(sync.startedAt).toLocaleString()),
        sync.completedAt &&
          h('span', null, t('SyncPanel.message039'), new Date(sync.completedAt).toLocaleString()),
        sync.abortedAt &&
          h('span', null, t('SyncPanel.message040'), new Date(sync.abortedAt).toLocaleString()),
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
                sync.status === 'aborted' ? 'var(--dsw-alias-state-warning-primary)' : undefined,
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
        steps: sync.steps,
        generatedFiles: sync.generatedFiles,
        workspaceId: sync.workspaceId,
        requirementId: sync.requirementId,
        onViewFile: onViewFile,
      }),
    ),
    sync.id &&
      h(
        'footer',
        { className: progressCss.footer, 'aria-label': t('sync.progress.actions') },
        h(DeleteSyncTaskButton, {
          task: { ...sync, workspaceId, requirementId },
          onDeleted: onBack,
        }),
        sync.status === 'running' &&
          sync.id &&
          h(
            Button,
            {
              className: 'rh-btn rh-btn-danger-outline',
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
                className: 'rh-btn rh-btn-danger',
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
    fetch(
      `${ROUTE}/sync-history?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(requirementId)}`,
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
    { className: historyCss.page },
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
    return h('div', { className: 'rh-op-panel' }, t('SyncPanel.message001'));
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
        const url = sync.id
          ? `${ROUTE}/sync-detail?${new URLSearchParams({ id: sync.id, workspaceId, requirementId: sync.requirementId })}`
          : `${ROUTE}/sync-overview`;
        const response = await fetch(url, { signal: controller.signal });
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
  }, [workspaceId, sync.id, sync.notificationId, isLiveSync(sync)]);
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
          sourceUrl: `${ROUTE}/sync-file?${new URLSearchParams({ workspaceId, requirementId: sync.requirementId, attemptId: sync.id, artifactId: viewingFile.artifactId })}`,
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
    }),
  );
}

// ─── PhasedSyncUI - Main sync UI with session selector ──────────
/**
 * @component
 * Main phased sync UI that provides session selection, branch info display,
 * and multi-phase sync execution with real-time progress tracking via SSE.
 * Supports viewing sync progress, conversation details, and generated files.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The workspace ID
 * @param {Object} props.selectedReq - The selected requirement object
 * @param {string} props.activeTab - The active document type ('requirement' or 'design')
 * @param {boolean} props.syncing - Whether a sync is currently in progress
 * @param {Function} props.setSyncing - State setter for the syncing flag
 * @param {Function} props.onClose - Callback invoked to close the panel
 * @param {Function} props.refreshTree - Callback to refresh the document tree after sync
 * @param {boolean} [props.quick=false] - Submit one Host-owned requirement/design sequence.
 * @returns {JSX.Element}
 */
function PhasedSyncUI({
  workspaceId,
  selectedReq,
  activeTab,
  syncing,
  setSyncing,
  onClose,
  refreshTree,
  quick = false,
}) {
  const { syncActivity } = React.useContext(DocsViewerContext);
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [codexSelection, setCodexSelection] = useState({ ids: [], versions: {} });
  const selectedSessionIds = quick ? [] : [...selectedSessions, ...codexSelection.ids];
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState(null);
  const [viewingSession, setViewingSession] = useState(null);
  const [managingConversations, setManagingConversations] = useState(false);
  const [conversationRevision, setConversationRevision] = useState(0);
  const [sessionSource, setSessionSource] = useState('dsh');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const selectedSessionVersions = useRef({});
  const sessionVersions = () => ({
    ...selectedSessionVersions.current,
    ...codexSelection.versions,
  });
  useEffect(() => {
    setSelectedSessions([]);
    selectedSessionVersions.current = {};
    setCodexSelection({ ids: [], versions: {} });
  }, [workspaceId]);
  const pollRef = useRef(null);
  const preparationPollRef = useRef(null);
  const observationRef = useRef(null);
  const quickSyncId = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      clearInterval(pollRef.current);
      clearInterval(preparationPollRef.current);
      observationRef.current?.();
    },
    [],
  );
  const [view, setView] = useState('select'); // 'select' | 'progress' | 'file'
  const [currentSync, setCurrentSync] = useState(null);
  const [viewingFile, setViewingFile] = useState(null);
  const [branchInfo, setBranchInfo] = useState({ targetBranch: null, baseBranch: null });
  const [baseBranch, setBaseBranch] = useState('');
  const baseBranchEdited = React.useRef(false);
  const [commitState, setCommitState] = useState({
    data: null,
    error: null,
    loading: false,
    key: null,
  });
  const [selectedCommits, setSelectedCommits] = useState([]);
  const [commitSearch, setCommitSearch] = useState('');
  const [commitRevision, setCommitRevision] = useState(0);
  const [includeWorkingChanges, setIncludeWorkingChanges] = useState(!quick);
  const [knowledgeScopeIds, setKnowledgeScopeIds] = useState([]);
  const [designReferencePath, setDesignReferencePath] = useState('');
  const [referencePending, setReferencePending] = useState(false);
  useEffect(() => {
    setDesignReferencePath('');
    setReferencePending(false);
  }, [workspaceId, selectedReq?.id]);
  useEffect(() => {
    setKnowledgeScopeIds([]);
  }, [workspaceId]);

  const docTypeName =
    activeTab === 'requirement' ? t('DocsViewerBody.message073') : t('documents.design');

  // Reattach to both preparation and a persisted execution.
  useEffect(() => {
    if (!selectedReq?.id) {
      return;
    }
    const controller = new AbortController();
    fetch(
      `${ROUTE}/sync-active?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`,
      { signal: controller.signal },
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (controller.signal.aborted || !data?.active || !data.sync) {
          return;
        }
        quickSyncId.current = data.sync.quickSyncId || null;
        setCurrentSync(data.sync);
        setView('progress');
        setSyncing?.(true);
        if (isLiveSync(data.sync)) {
          connectToSyncSSE(data.sync.id);
        }
      })
      .catch((error) => {
        // Keep the previous branch metadata when its optional refresh fails.
      });
    return () => {
      controller.abort();
      clearInterval(pollRef.current);
    };
  }, [workspaceId, selectedReq?.id]);

  // Load branch info
  useEffect(() => {
    if (!selectedReq?.id) {
      return;
    }
    const controller = new AbortController();
    baseBranchEdited.current = false;
    setBranchInfo({ targetBranch: null, baseBranch: null });
    setBaseBranch('');
    fetch(
      `${ROUTE}/sync-branch-info?workspaceId=${encodeURIComponent(workspaceId)}&requirementId=${encodeURIComponent(selectedReq.id)}${selectedReq.targetBranch ? `&targetBranch=${encodeURIComponent(selectedReq.targetBranch)}` : ''}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || t('SyncPanel.message054'));
        }
        return data;
      })
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        setBranchInfo(data);
        if (!baseBranchEdited.current) {
          setBaseBranch(data.baseBranch || '');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setBranchInfo({ targetBranch: null, baseBranch: null, targetBranchError: error.message });
        }
      });
    return () => controller.abort();
  }, [workspaceId, selectedReq?.id]);

  const comparisonKey = JSON.stringify([
    workspaceId,
    selectedReq?.id,
    branchInfo.targetBranch,
    baseBranch.trim(),
    commitRevision,
  ]);
  const commitsReady =
    !!commitState.data && commitState.key === comparisonKey && !commitState.loading;
  const availableCommits = commitsReady ? commitState.data.commits : [];
  const visibleCommits = availableCommits.filter((commit) =>
    `${commit.hash} ${commit.subject} ${commit.author}`
      .toLowerCase()
      .includes(commitSearch.toLowerCase().trim()),
  );
  const canSync =
    (quick || activeTab !== 'design' || !referencePending) &&
    !loadingSessions &&
    !syncActivity &&
    !!branchInfo.targetBranch &&
    !!baseBranch.trim() &&
    commitsReady &&
    (selectedCommits.length > 0 ||
      selectedSessionIds.length > 0 ||
      (includeWorkingChanges && commitState.data.hasUncommitted));

  useEffect(() => {
    setSelectedCommits([]);
    if (!branchInfo.targetBranch || !baseBranch.trim()) {
      setCommitState({ data: null, error: null, loading: false, key: comparisonKey });
      return;
    }
    const controller = new AbortController();
    setCommitState({ data: null, error: null, loading: true, key: comparisonKey });
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          workspaceId,
          requirementId: selectedReq.id,
          baseBranch: baseBranch.trim(),
          ...(selectedReq.targetBranch ? { targetBranch: selectedReq.targetBranch } : {}),
        });
        const res = await fetch(`${ROUTE}/sync-commits?${params}`, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || t('SyncPanel.message055'));
        }
        if (controller.signal.aborted) {
          return;
        }
        setCommitState({ data, error: null, loading: false, key: comparisonKey });
        setSelectedCommits(data.commits.map((commit) => commit.hash));
      } catch (error) {
        if (!controller.signal.aborted) {
          setCommitState({ data: null, error: error.message, loading: false, key: comparisonKey });
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [comparisonKey]);

  // Resolve only the identified task's persisted outcome after a transport interruption.
  const connectToSyncSSE = (syncId, sequenceId = quickSyncId.current) => {
    observationRef.current?.();
    clearInterval(pollRef.current);
    const controller = new AbortController();
    let settle;
    const completion = new Promise((resolve) => {
      settle = resolve;
    });
    let stopped = false;
    let fetching = false;
    const stop = (sync = null) => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      controller.abort();
      window.removeEventListener('req-hub-sync-deleted', removed);
      if (observationRef.current === stop) {
        observationRef.current = null;
      }
      settle(sync);
    };
    const removed = (event) => {
      const task = event.detail;
      if (
        task.workspaceId === workspaceId &&
        task.requirementId === selectedReq.id &&
        task.id === syncId
      ) {
        setCurrentSync(null);
        setSyncing(false);
        setView('select');
        stop();
      }
    };
    const poll = async () => {
      if (fetching || stopped || !mounted.current) {
        return;
      }
      fetching = true;
      try {
        let url = `${ROUTE}/sync-overview`;
        if (quick && sequenceId) {
          url = `${ROUTE}/quick-sync-status?${new URLSearchParams({
            id: sequenceId,
            workspaceId,
            requirementId: selectedReq.id,
          })}`;
        } else if (!quick && syncId) {
          url = `${ROUTE}/sync-detail?id=${syncId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`;
        }
        const response = await fetch(url, { signal: controller.signal });
        if (stopped || !mounted.current) {
          return;
        }
        if (response.status === 404 || response.status === 410) {
          setCurrentSync(null);
          setSyncing(false);
          setView('select');
          setError(t('SyncPanel.message058'));
          stop();
          return;
        }
        if (!response.ok) {
          throw new Error(t('SyncPanel.message057'));
        }
        const data = await response.json();
        if (stopped || !mounted.current) {
          return;
        }
        let sequence = quick ? data.quickSync : null;
        if (
          sequence &&
          !sequenceId &&
          (sequence.workspaceId !== workspaceId || sequence.requirementId !== selectedReq.id)
        ) {
          sequence = null;
        }
        if (
          sequence &&
          sequence.workspaceId === workspaceId &&
          sequence.requirementId === selectedReq.id
        ) {
          if (sequenceId && sequence.id !== sequenceId) {
            throw new Error(t('SyncPanel.message058'));
          }
          sequenceId = sequence.id;
          quickSyncId.current = sequence.id;
        }
        const sync =
          data.sync ||
          [data.active, data.latest].find(
            (task) =>
              task?.workspaceId === workspaceId &&
              task.requirementId === selectedReq.id &&
              (quick || task.docType === activeTab),
          );
        if ((!sync && !sequence) || (!quick && syncId && sync.id !== syncId)) {
          throw new Error(t('SyncPanel.message058'));
        }
        if (sync) {
          setCurrentSync(sync);
        }
        if (sync?.id) {
          syncId = sync.id;
        }
        const terminal = sequence ? sequence.status !== 'running' : !isLiveSync(sync);
        if (terminal) {
          setSyncing(false);
          if (!sync) {
            setCurrentSync(null);
            setView('select');
          }
          const outcome = sequence || sync;
          setError(outcome.status === 'completed' ? null : syncErrorText(outcome.error));
          refreshTree();
          stop(sync);
        }
      } catch (error) {
        if (!stopped && mounted.current) {
          setError(error.message);
        }
      } finally {
        fetching = false;
      }
    };
    const timer = setInterval(poll, 1000);
    pollRef.current = timer;
    observationRef.current = stop;
    window.addEventListener('req-hub-sync-deleted', removed);
    return completion;
  };

  const runPhasedSync = async (docType) => {
    quickSyncId.current = null;
    window.dispatchEvent(new Event('req-hub-sync-change'));
    setError(null);
    setView('progress');
    if (setSyncing) {
      setSyncing(true);
    }

    const steps = syncTaskModel.createSyncSteps({ sessionIds: selectedSessionIds });
    Object.assign(steps[0], {
      status: 'running',
      startedAt: Date.now(),
      activity: { stage: 'preparing' },
    });

    const initialSync = {
      id: `sync-${Date.now()}`,
      workspaceId,
      requirementId: selectedReq.id,
      docType,
      docTypeName:
        docType === 'requirement' ? t('DocsViewerBody.message073') : t('documents.design'),
      sessionIds: selectedSessionIds,
      sessionVersions: Object.fromEntries(
        selectedSessionIds.map((id) => [id, sessionVersions()[id]]),
      ),
      startedAt: Date.now(),
      status: 'running',
      steps,
      generatedFiles: [],
    };
    setCurrentSync(initialSync);
    let latestSync = initialSync;
    let confirmedId = null;
    let terminalReceived = false;
    let taskDeleted = false;
    let preparing = true;
    let preparationFetching = false;
    // Commit capture precedes the task's SSE response. Observe the existing
    // supervisor lease until that response arrives, then let SSE own updates.
    const preparationTimer = (preparationPollRef.current = setInterval(async () => {
      if (!preparing || preparationFetching || !mounted.current) {
        return;
      }
      preparationFetching = true;
      try {
        const response = await fetch(`${ROUTE}/sync-overview`);
        if (!response.ok) {
          return;
        }
        const { active } = await response.json();
        if (
          preparing &&
          mounted.current &&
          active?.status === 'preparing' &&
          active.workspaceId === workspaceId &&
          active.requirementId === selectedReq.id &&
          active.docType === docType
        ) {
          quickSyncId.current = active.quickSyncId || quickSyncId.current;
          setCurrentSync({ ...initialSync, ...active, id: initialSync.id, status: 'running' });
        }
      } catch (error) {
        // The POST request remains authoritative for preparation failures.
      } finally {
        preparationFetching = false;
      }
    }, 1000));
    pollRef.current = preparationTimer;

    try {
      let currentSessionId = '';
      try {
        const ctx = window.__DSH_CTX__;
        if (ctx) {
          const uiWorkspace = ctx.get?.('uiWorkspace');
          if (uiWorkspace?.selection && typeof uiWorkspace.selection.getSnapshot === 'function') {
            const selection = uiWorkspace.selection.getSnapshot();
            if (selection?.sessionId) {
              currentSessionId = selection.sessionId;
            }
          }
        }
      } catch (e) {
        // Continue without a session header when the optional live-session lookup fails.
      }

      const response = await fetch(`${ROUTE}/phased-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(currentSessionId ? { 'x-session-id': currentSessionId } : {}),
        },
        body: JSON.stringify({
          workspaceId,
          requirementId: selectedReq.id,
          docType,
          targetBranch: selectedReq.targetBranch,
          quick,
          ...(!quick && docType === 'design' && designReferencePath ? { designReferencePath } : {}),
          baseBranch: baseBranch.trim(),
          commitHashes: selectedCommits,
          branchTip: commitState.data.branchTip,
          baseCommit: commitState.data.baseline,
          includeWorkingChanges: quick ? false : includeWorkingChanges,
          knowledgeScopeIds,
          sessionIds: selectedSessionIds,
          sessionVersions: Object.fromEntries(
            selectedSessionIds.map((id) => [id, sessionVersions()[id]]),
          ),
        }),
      });
      preparing = false;
      clearInterval(preparationTimer);
      if (!mounted.current) {
        if (response.body) {
          await readSyncEvents(response.body, () => {});
        }
        return;
      }

      const contentType = response.headers.get('content-type');

      // A JSON response identifies an existing task; an SSE response starts a new stream.
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        if (data.skipped) {
          showToast({ text: data.message || t('SyncPanel.message059'), holdMs: 3000 });
          setCurrentSync(null);
          setView('select');
          if (setSyncing) {
            setSyncing(false);
          }
          return true;
        }
        if (data.active && data.sync) {
          if (response.status === 409) {
            throw new Error(data.message || t('SyncPanel.message060'));
          }
          setCurrentSync(data.sync);
          setView('progress');
          if (setSyncing) {
            setSyncing(true);
          }

          if (syncTaskModel.isSyncActive(data.sync)) {
            const completion = connectToSyncSSE(data.sync.id);
            if (quick) {
              return (await completion)?.status === 'completed';
            }
          } else {
            setSyncing(false);
            return data.sync.status === 'completed';
          }
        } else {
          throw new Error(data.error || data.message || t('SyncPanel.message061'));
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await readSyncEvents(response.body, async (event) => {
        if (!mounted.current) {
          return;
        }
        if (event.type === 'deleted') {
          taskDeleted = true;
          terminalReceived = true;
          setCurrentSync(null);
          setSyncing(false);
          setView('select');
          return;
        }
        if (event.quickSync?.id) {
          quickSyncId.current = event.quickSync.id;
        }
        if (event.type === 'sync_started') {
          window.dispatchEvent(new Event('req-hub-sync-change'));
          confirmedId = event.syncId;
          const docType = event.quickSync?.stage || latestSync.docType;
          latestSync = {
            ...latestSync,
            id: confirmedId,
            docType,
            docTypeName:
              docType === 'design' ? t('documents.design') : t('DocsViewerBody.message073'),
            status: 'running',
            steps: syncTaskModel.createSyncSteps({ sessionIds: selectedSessionIds }),
          };
        }
        if (event.sync) {
          latestSync = event.sync;
          confirmedId = event.sync.id;
          setCurrentSync(latestSync);
        } else if (event.type === 'step') {
          latestSync = structuredClone(latestSync);
          syncTaskModel.updateSyncTask(latestSync, {
            type: 'step',
            phase: event.phase,
            updates: event,
          });
        }
        setCurrentSync({ ...latestSync });
        if (event.type === 'error') {
          terminalReceived = event.quickSync
            ? event.quickSync.status !== 'running'
            : !syncTaskModel.isSyncActive(latestSync);
          setError(syncErrorText(event.error));
          if (!terminalReceived) {
            throw new Error(event.error);
          }
        }
        if (event.type === 'done') {
          terminalReceived = event.quickSync
            ? event.quickSync.status !== 'running'
            : !syncTaskModel.isSyncActive(latestSync);
          if (!terminalReceived) {
            throw new Error(t('SyncPanel.message062'));
          }
          refreshTree();
        }
      });
      if (!mounted.current || taskDeleted) {
        return;
      }
      if (!terminalReceived) {
        throw new Error(t('SyncPanel.message063'));
      }
      setSyncing(false);
      window.dispatchEvent(new Event('req-hub-sync-change'));
      return latestSync.status === 'completed';
    } catch (error) {
      if (!mounted.current || taskDeleted) {
        return;
      }
      setError(syncErrorText(error.message) || t('SyncPanel.message064'));
      if (quick && quickSyncId.current) {
        setSyncing(true);
        await connectToSyncSSE(confirmedId);
        return;
      }
      if (confirmedId) {
        try {
          const response = await fetch(
            `${ROUTE}/sync-detail?id=${confirmedId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`,
          );
          if (response.ok) {
            const data = await response.json();
            if (data.sync) {
              latestSync = data.sync;
            }
          }
        } catch (error) {
          // Keep polling the known task; a network error is not a terminal task failure.
        }
        setCurrentSync(latestSync);
        if (syncTaskModel.isSyncActive(latestSync)) {
          setSyncing(true);
          const completion = connectToSyncSSE(confirmedId);
          if (quick) {
            return (await completion)?.status === 'completed';
          }
        } else {
          setSyncing(false);
          if (latestSync.status === 'completed') {
            setError(null);
            return true;
          }
        }
      } else {
        setView('select');
        setCurrentSync(null);
        setSyncing(false);
      }
    } finally {
      preparing = false;
      clearInterval(preparationTimer);
    }
  };

  const quickStarted = useRef(false);
  const handlePhasedSync = async () => {
    if (!canSync || syncing) {
      return;
    }
    await runPhasedSync(activeTab);
  };
  useEffect(() => {
    if (quick && canSync && !syncing && !quickStarted.current) {
      quickStarted.current = true;
      void handlePhasedSync();
    }
  }, [quick, canSync, syncing]);

  // Secondary page: viewing session turns
  if (viewingSession) {
    return h(SessionTurnsView, {
      workspaceId,
      sessionId: viewingSession.id,
      sessionTitle: viewingSession.title || t('SyncPanel.message007'),
      snapshotVersion: sessionVersions()[viewingSession.id] || viewingSession.snapshotVersion,
      onBack: () => setViewingSession(null),
    });
  }

  // Secondary page: viewing a file
  if (view === 'file' && viewingFile) {
    return h(
      'div',
      { className: css.column },
      h(
        'div',
        { className: css.section2 },
        h(
          'div',
          { className: css.row16 },
          h(HeaderBack, {
            onBack: () => {
              setViewingFile(null);
              setView('progress');
            },
            label: t('common.back'),
          }),
          h('span', { className: css.row20 }, ' ', viewingFile.fileName),
        ),
      ),
      h(
        'div',
        { className: css.pane4 },
        h(FilePreview, {
          workspaceId,
          readOnly: true,
          sourceUrl: `${ROUTE}/sync-file?${new URLSearchParams({ workspaceId, requirementId: selectedReq.id, attemptId: currentSync.id, artifactId: viewingFile.artifactId })}`,
          name: viewingFile.fileName,
          requirement: null,
        }),
      ),
    );
  }

  // Progress view (active sync)
  if (view === 'progress' && currentSync) {
    return h(SyncProgressView, {
      sync:
        currentSync.status === 'preparing' ? { ...currentSync, status: 'running' } : currentSync,
      workspaceId,
      requirementId: selectedReq.id,
      requirementPath: selectedReq.path,
      onBack: () => {
        setView('select');
      },
      onViewFile: (fileName) => {
        setViewingFile(fileName);
        setView('file');
      },
      onSyncAborted: () => {
        setCurrentSync((previous) => {
          if (!previous) {
            return previous;
          }
          const next = structuredClone(previous);
          syncTaskModel.updateSyncTask(next, { type: 'cancel' });
          return next;
        });
      },
    });
  }

  // Main view: session selector + sync button
  const renderCommitSelection = () => {
    if (!branchInfo.targetBranch || !baseBranch.trim()) {
      return h('p', { className: 'rh-sync-hint' }, t('SyncPanel.message077'));
    } else if (commitState.loading || !commitState.key) {
      return h('p', { role: 'status', className: 'rh-sync-hint' }, t('SyncPanel.message078'));
    } else if (commitState.error) {
      return h('p', { role: 'alert', className: 'rh-error' }, commitState.error);
    } else {
      return (
        commitsReady &&
        h(
          React.Fragment,
          null,
          availableCommits.length > 0 &&
            h(Input, {
              className: 'rh-search-input',
              type: 'search',
              'aria-label': t('SyncPanel.message079'),
              placeholder: t('SyncPanel.message080'),
              value: commitSearch,
              onChange: (event) => setCommitSearch(event.target.value),
            }),
          h(
            'div',
            { className: 'rh-sync-commit-list' },
            visibleCommits.map((commit) =>
              h(
                'label',
                {
                  className: `rh-sync-commit${selectedCommits.includes(commit.hash) ? ' selected' : ''}`,
                  key: commit.hash,
                },
                h('input', {
                  type: 'checkbox',
                  checked: selectedCommits.includes(commit.hash),
                  disabled: syncing,
                  'aria-label': t('SyncPanel.message081', { value0: commit.shortHash }),
                  onChange: (event) =>
                    setSelectedCommits((previous) =>
                      event.target.checked
                        ? [...previous, commit.hash]
                        : previous.filter((hash) => hash !== commit.hash),
                    ),
                }),
                h(
                  'span',
                  { className: 'rh-sync-commit-content' },
                  h(
                    'span',
                    { className: 'rh-sync-commit-title', title: commit.subject },
                    h('code', null, commit.shortHash),
                    ' ',
                    commit.subject,
                  ),
                  h(
                    'span',
                    { className: 'rh-sync-hint' },
                    `${commit.author} · ${new Date(commit.date).toLocaleString()}${commit.merge ? t('SyncPanel.message082') : ''}`,
                  ),
                ),
              ),
            ),
          ),
          !availableCommits.length &&
            h('p', { className: 'rh-sync-hint' }, t('SyncPanel.message083')),
          availableCommits.length > 0 &&
            !visibleCommits.length &&
            h('p', { className: 'rh-sync-hint' }, t('SyncPanel.message084')),
          !quick &&
            commitState.data.hasUncommitted &&
            h(
              'div',
              { className: 'rh-sync-working-option' },
              h(Checkbox, {
                checked: includeWorkingChanges,
                disabled: syncing,
                onChange: (checked) => setIncludeWorkingChanges(checked),
                label: t('SyncPanel.message085'),
              }),
            ),
        )
      );
    }
  };
  const references = h(
    React.Fragment,
    null,
    !quick &&
      activeTab === 'design' &&
      h(
        'div',
        { className: css.referenceField },
        h('div', { className: css.referenceLabel }, t('sync.reference.label')),
        h(SyncBranchPicker, {
          key: workspaceId + ':' + selectedReq.id,
          kind: 'reference',
          workspaceId,
          requirementId: selectedReq.id,
          value: designReferencePath,
          onChange: setDesignReferencePath,
          onPendingChange: setReferencePending,
          disabled: syncing,
        }),
        h('div', { className: css.referenceHint }, t('sync.reference.hint')),
      ),
    h(KnowledgeContextPicker, {
      key: workspaceId,
      workspaceId,
      scopeIds: knowledgeScopeIds,
      onChange: setKnowledgeScopeIds,
      disabled: syncing,
      embedded: true,
    }),
  );
  const sources =
    !quick &&
    h(ConversationSources, {
      key: workspaceId + ':' + conversationRevision,
      workspaceId,
      tabbed: true,
      activeSource: sessionSource,
      onSourceChange: setSessionSource,
      dshSelection: { ids: selectedSessions, versions: selectedSessionVersions.current },
      codexSelection,
      onDshSelectionChange: (value) => {
        setSelectedSessions(value.ids);
        selectedSessionVersions.current = value.versions;
      },
      onCodexSelectionChange: setCodexSelection,
      onView: setViewingSession,
      disabled: syncing,
      onBusyChange: setLoadingSessions,
      onManage: () => setManagingConversations(true),
    });
  const commitActions = h(
    React.Fragment,
    null,
    h(
      Button,
      {
        size: 'sm',
        variant: 'ghost',
        disabled: !commitsReady || syncing,
        onClick: () => setSelectedCommits(availableCommits.map((commit) => commit.hash)),
      },
      t('LogPanel.message007'),
    ),
    h(
      Button,
      {
        size: 'sm',
        variant: 'ghost',
        disabled: !commitsReady || syncing,
        onClick: () => setSelectedCommits([]),
      },
      t('LogPanel.message002'),
    ),
    h(
      Button,
      {
        size: 'sm',
        variant: 'ghost',
        disabled: !baseBranch.trim() || !branchInfo.targetBranch || syncing,
        onClick: () => setCommitRevision((value) => value + 1),
      },
      t('SyncPanel.message075'),
    ),
  );
  const selectionSummary = h(
    React.Fragment,
    null,
    t('sync.layout.summary', {
      commits: selectedCommits.length,
      knowledge: knowledgeScopeIds.length,
      dsh: selectedSessions.length,
      codex: codexSelection.ids.length,
    }),
    !quick &&
      activeTab === 'design' &&
      ' · ' + t('sync.layout.referenceSummary', { count: designReferencePath ? 1 : 0 }),
    includeWorkingChanges &&
      commitsReady &&
      commitState.data.hasUncommitted &&
      ' · ' + t('SyncPanel.message085'),
  );
  return h(
    React.Fragment,
    null,
    h(SyncSetup, {
      title: t('sync.layout.title', { type: docTypeName }),
      outputName: quick ? 'requirement.md → design.md' : activeTab + '.md',
      requirementPath:
        selectedReq.path || [selectedReq.developer, selectedReq.id].filter(Boolean).join('/'),
      branchInfo,
      baseBranch,
      baseDisabled: syncing || quick,
      onBaseBranchChange: (value) => {
        baseBranchEdited.current = true;
        setBaseBranch(value);
      },
      commitSummary: t('SyncPanel.message074', {
        value0: selectedCommits.length,
        value1: availableCommits.length,
      }),
      commitActions,
      commitSelection: renderCommitSelection(),
      references,
      sources,
      selectionSummary,
      sourcesOpen,
      onSourcesOpenChange: setSourcesOpen,
      sourcesSummary: t('sync.layout.sourcesSummary', {
        dsh: selectedSessions.length,
        codex: codexSelection.ids.length,
      }),
      onBack: onClose,
      onStart: handlePhasedSync,
      startDisabled: syncing || !canSync,
      error,
      actionLabel: syncing
        ? t('SyncPanel.message092')
        : t(quick ? 'sync.quick.start' : 'SyncPanel.message093', { value0: docTypeName }),
      activeTask: isLiveSync(currentSync)
        ? h(ActiveSyncSummary, { task: currentSync, onOpen: () => setView('progress') })
        : null,
    }),
    managingConversations &&
      h(ConversationManager, {
        workspaceId,
        onClose: () => setManagingConversations(false),
        onChanged: () => {
          setSelectedSessions([]);
          selectedSessionVersions.current = {};
          setCodexSelection({ ids: [], versions: {} });
          setConversationRevision((value) => value + 1);
        },
      }),
  );
}

module.exports = { SyncPanel };
