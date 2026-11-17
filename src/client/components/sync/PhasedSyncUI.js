'use strict';
const { isLiveSync } = require('./Summary.js');
const { ActiveSyncSummary } = require('./Summary.js');
const { SessionTurnsView } = require('./SessionTurnsView.js');
const { SyncProgressView } = require('./Progress.js');
const { usePhasedSync } = require('./usePhasedSync.js');
const clientApi = require('../../api/index.js');
const { localizeMessage, clientError } = require('../../utils/serverMessage.js');
const { formatDateTime, useTimeZone } = require('../../time.js');
const { PagedList } = require('../shared/PagedList.js');
const { KnowledgeContextPicker } = require('../KnowledgeContextPicker.js');
const { SyncSetup } = require('../SyncSetup.js');
const { Checkbox } = require('../shared/controls.js');
const { t } = require('../../locale.js');
const css = require('../SyncPanel.module.css').default;
const { Button } = require('../shared/Button.js');
const { Input } = require('../shared/Input.js');
const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('../shared/HeaderBack.js');
const syncTaskModel = require('../../../shared/sync-task.cjs');
const { FilePreview } = require('../FilePreview.js');
const { SyncBranchPicker } = require('../SyncBranchPicker.js');
const { ConversationSources } = require('../ConversationSources.js');
const { ConversationManager } = require('../ConversationManager.js');
/**
 * Render the selected sync surface while its hook retains task ownership.
 * @param props - Scoped workspace and requirement properties.
 * @returns Preparation, progress, artifact or conversation content.
 */
function PhasedSyncUI(props) {
  const {
    workspaceId,
    selectedReq,
    activeTab,
    syncing,
    setSyncing,
    onClose,
    refreshTree,
    quick = false,
  } = props;
  const {
    selectedSessions,
    setSelectedSessions,
    codexSelection,
    setCodexSelection,
    setLoadingSessions,
    error,
    setError,
    viewingSession,
    setViewingSession,
    managingConversations,
    setManagingConversations,
    conversationRevision,
    setConversationRevision,
    sessionSource,
    setSessionSource,
    sourcesOpen,
    setSourcesOpen,
    selectedSessionVersions,
    sessionVersions,
    view,
    setView,
    currentSync,
    setCurrentSync,
    viewingFile,
    setViewingFile,
    branchInfo,
    baseBranch,
    setBaseBranch,
    baseBranchEdited,
    commitState,
    selectedCommits,
    setSelectedCommits,
    commitSearch,
    setCommitSearch,
    setCommitRevision,
    includeWorkingChanges,
    setIncludeWorkingChanges,
    knowledgeScopeIds,
    setKnowledgeScopeIds,
    designReferencePath,
    setDesignReferencePath,
    setReferencePending,
    docTypeName,
    commitsReady,
    availableCommits,
    visibleCommits,
    canSync,
    connectToSyncSSE,
    handlePhasedSync,
  } = usePhasedSync(props);
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
          sourceUrl: clientApi.endpoint(
            'sync-file',
            `${new URLSearchParams({ workspaceId, requirementId: selectedReq.id, attemptId: currentSync.id, artifactId: viewingFile.artifactId })}`,
          ),
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
      onRetry: (next) => {
        setCurrentSync(next);
        setError(null);
        setSyncing(true);
        void connectToSyncSSE(next.id, null, true);
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
      return h('p', { role: 'alert', className: 'rh-error' }, localizeMessage(commitState.error));
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
            h(
              PagedList,
              { resetKey: commitSearch, className: css.commitPages, inspect: false },
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
                      `${commit.author} · ${formatDateTime(commit.date)}${commit.merge ? t('SyncPanel.message082') : ''}`,
                    ),
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

module.exports = { PhasedSyncUI };
