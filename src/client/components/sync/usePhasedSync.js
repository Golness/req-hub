'use strict';
const { isLiveSync } = require('./Summary.js');
const clientApi = require('../../api/index.js');
const { localizeMessage, clientError } = require('../../utils/serverMessage.js');
const { formatDateTime, useTimeZone } = require('../../time.js');
const { t } = require('../../locale.js');
const React = require('react');
const { useState, useEffect, useRef } = React;
const syncTaskModel = require('../../../shared/sync-task.cjs');
const { readSyncEvents } = require('../../utils/syncEvents.js');
const { syncActivityText, syncErrorText, syncPhaseLabel } = require('../../utils/syncFeedback.js');
const { DocsViewerContext, SessionSelectionContext } = require('../../context.js');
const { showToast } = require('../shared/ToastContainer.js');
/**
 * Own sync preparation, execution and reconnection for one mounted workspace view.
 * @param props - Workspace, requirement and task callbacks supplied by the owning surface.
 * @returns Only the state and actions needed by the sync presentation.
 */
function usePhasedSync({
  workspaceId,
  selectedReq,
  activeTab,
  syncing,
  setSyncing,
  onClose,
  refreshTree,
  quick = false,
}) {
  const getSelectedSession = React.useContext(SessionSelectionContext);
  useTimeZone();
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
  const streamRequest = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      streamRequest.current?.abort();
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
    clientApi
      .request(
        clientApi.endpoint(
          'sync-branch-info',
          `workspaceId=${encodeURIComponent(workspaceId)}&requirementId=${encodeURIComponent(selectedReq.id)}${selectedReq.targetBranch ? `&targetBranch=${encodeURIComponent(selectedReq.targetBranch)}` : ''}`,
        ),
        { signal: controller.signal },
      )
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok || data.error) {
          throw clientError(data.error, t('SyncPanel.message054'));
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
        const res = await clientApi.request(clientApi.endpoint('sync-commits', `${params}`), {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw clientError(data.error, t('SyncPanel.message055'));
        }
        if (controller.signal.aborted) {
          return;
        }
        setCommitState({ data, error: null, loading: false, key: comparisonKey });
        setSelectedCommits(data.commits.map((commit) => commit.hash));
      } catch (error) {
        if (!controller.signal.aborted) {
          setCommitState({
            data: null,
            error: localizeMessage(error.message),
            loading: false,
            key: comparisonKey,
          });
        }
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [comparisonKey]);

  // Resolve only the identified task's persisted outcome after a transport interruption.
  const connectToSyncSSE = (syncId, sequenceId = quickSyncId.current, singleAttempt = false) => {
    const trackQuick = quick && !singleAttempt;
    observationRef.current?.();
    clearInterval(pollRef.current);
    const controller = new AbortController();
    let settle;
    const completion = new Promise((resolve) => {
      settle = resolve;
    });
    let stopped = false;
    let fetching = false;
    let failures = 0;
    let nextPollAt = 0;
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
      if (fetching || stopped || !mounted.current || Date.now() < nextPollAt) {
        return;
      }
      fetching = true;
      try {
        let url = clientApi.endpoint('sync-overview');
        if (trackQuick && sequenceId) {
          url = clientApi.endpoint(
            'quick-sync-status',
            `${new URLSearchParams({
              id: sequenceId,
              workspaceId,
              requirementId: selectedReq.id,
            })}`,
          );
        } else if (!trackQuick && syncId) {
          url = clientApi.endpoint(
            'sync-detail',
            `id=${syncId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`,
          );
        }
        const response = await clientApi.request(url, { signal: controller.signal });
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
        failures = 0;
        nextPollAt = 0;
        if (stopped || !mounted.current) {
          return;
        }
        let sequence = trackQuick ? data.quickSync : null;
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
              (trackQuick || task.docType === activeTab),
          );
        if ((!sync && !sequence) || (!trackQuick && syncId && sync?.id !== syncId)) {
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
          failures++;
          nextPollAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
          setError(localizeMessage(error.message));
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
    streamRequest.current?.abort();
    const request = new AbortController();
    streamRequest.current = request;
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
      id: window.crypto?.randomUUID?.() || `sync-${Date.now()}`,
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
        const response = await clientApi.request(clientApi.endpoint('sync-overview'), {
          signal: request.signal,
        });
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
          setCurrentSync({ ...initialSync, ...active, status: 'running' });
        }
      } catch (error) {
        // The POST request remains authoritative for preparation failures.
      } finally {
        preparationFetching = false;
      }
    }, 1000));
    pollRef.current = preparationTimer;

    try {
      const currentSessionId = getSelectedSession();

      const response = await clientApi.request(clientApi.endpoint('phased-sync'), {
        signal: request.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(currentSessionId ? { 'x-session-id': currentSessionId } : {}),
        },
        body: JSON.stringify({
          workspaceId,
          requirementId: selectedReq.id,
          docType,
          requestId: initialSync.id,
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
          await response.body.cancel();
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
        if (data.sync && !isLiveSync(data.sync)) {
          setCurrentSync(data.sync);
          setView('progress');
          setSyncing(false);
          setError(syncErrorText(data.error || data.sync.error));
          window.dispatchEvent(new Event('req-hub-sync-change'));
          return data.sync.status === 'completed';
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
          throw clientError(data.error || data.message, t('SyncPanel.message061'));
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      await readSyncEvents(
        response.body,
        async (event) => {
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
        },
        { signal: request.signal },
      );
      if (!mounted.current || request.signal.aborted || taskDeleted) {
        return;
      }
      if (!terminalReceived) {
        throw new Error(t('SyncPanel.message063'));
      }
      setSyncing(false);
      window.dispatchEvent(new Event('req-hub-sync-change'));
      return latestSync.status === 'completed';
    } catch (error) {
      if (!mounted.current || request.signal.aborted || taskDeleted) {
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
          const response = await clientApi.request(
            clientApi.endpoint(
              'sync-detail',
              `id=${confirmedId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`,
            ),
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

  return {
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
  };
}

module.exports = { usePhasedSync };
