'use strict';
const { t } = require('../locale.js');
const css = require('./DocsViewerBody.module.css').default;
const { cssValue } = require('./shared/presentation.js');
const { Button } = require('./shared/Button.js');
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Tooltip } = require('./shared/controls.js');

const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef } = React;

const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');
const { createIconComponents } = require('../icons.js');

const { IconPlus, IconSync, IconBooks, IconEdit, IconLog, IconSettings, IconReports, IconFile } =
  createIconComponents(h);
const { TaskReportsPanel } = require('./TaskReportsPanel.js');

const { parseBranchName } = require('../utils/parseBranchName.js');
const { findBranchRequirement } = require('../utils/findBranchRequirement.js');
const { TopBar } = require('./TopBar.js');
const { CreateDirForm } = require('./CreateDirForm.js');
const { FilePreview } = require('./FilePreview.js');
const { FileKnowledgeAction } = require('./FileKnowledgeAction.js');
const { DocumentAssist } = require('./ContextAssist.js');
const { SyncPanel } = require('./SyncPanel.js');
const { SyncStatusBar } = require('./SyncStatusBar.js');
const { useSyncMonitor } = require('../hooks/useSyncMonitor.js');
const { WritingPanel } = require('./WritingPanel.js');
const { LogPanel } = require('./LogPanel.js');
const { SettingsPanel } = require('./SettingsPanel.js');
const { WorkspaceModal } = require('./WorkspaceModal.js');
const { RequirementDirModal } = require('./RequirementDirModal.js');
const { FileTreeSidebar } = require('./FileTreeSidebar.js');
const { ConfirmModal } = require('./ConfirmModal.js'); // Retained for the legacy confirmation path; new actions use showConfirm().
const { KnowledgeWorkspace } = require('./knowledge/KnowledgeWorkspace.js');
const { EmptyState } = require('./shared/EmptyState.js');
const { Breadcrumb } = require('./shared/Breadcrumb.js');
const { HeaderBack } = require('./shared/HeaderBack.js');
const { showToast } = require('./shared/ToastContainer.js');
const { ConfirmDialogContainer, showConfirm } = require('./shared/ConfirmDialog.js');
const { setupKeyboardShortcuts } = require('../utils/keyboardShortcuts.js');

/**
 * @component DocsViewerBody
 * @description Main container component for the document viewer. Manages workspace state, requirement selection,
 * file preview, and multiple operation panels (create, sync, writing, log, settings).
 * Provides context for child components and handles cross-component communication.
 * @param {Object} props - Component props
 * @param {Object} props.workspace - The current workspace object with id, path, and title
 * @param {string} props.docsDir - The path to the documents directory
 * @param {Function} props.onConfigChange - Callback invoked when configuration changes
 * @param {Array<Object>} props.workspaces - Array of available workspace objects
 * @param {Function} props.onSelectWorkspace - Select a workspace with an optional resolved location.
 * @param {string} [props.initialReqId] - Initial requirement ID to restore selection from config
 * @param {Object} [props.initialLocation] - Resolved navigation transferred across workspace remounts.
 * @returns {JSX.Element} The complete document viewer interface with rail toolbar, panels, and modals
 */
function DocsViewerBody({
  workspace,
  docsDir,
  onConfigChange,
  workspaces,
  onSelectWorkspace,
  initialReqId,
  initialLocation,
}) {
  const [activePanel, setActivePanel] = useState(initialLocation?.createBranch ? 'create' : null);
  const [knowledgeTab, setKnowledgeTab] = useState('wiki');
  const [settingsTab, setSettingsTab] = useState('model');
  const [fileRevision, setFileRevision] = useState(0);
  const [fileDirty, setFileDirty] = useState(false);
  const writingMounted = useRef(false);
  if (activePanel === 'writing') {
    writingMounted.current = true;
  }
  const knowledgeMounted = useRef(false);
  if (activePanel === 'knowledge') {
    knowledgeMounted.current = true;
  }
  const syncMonitor = useSyncMonitor();
  const [focusedSync, setFocusedSync] = useState(null);
  const [reportTarget, setReportTarget] = useState(initialLocation?.reportTarget || null);
  const [focusedKnowledge, setFocusedKnowledge] = useState(null);
  const pendingSyncNavigation = useRef(null);
  const selectionRevision = useRef(0);
  const focusedSyncRef = useRef(null);
  focusedSyncRef.current = focusedSync;
  useEffect(() => {
    const removed = (event) => {
      const task = event.detail;
      setFocusedSync((previous) =>
        previous?.workspaceId === task.workspaceId &&
        previous?.requirementId === task.requirementId &&
        previous?.snapshotDir === task.snapshotDir
          ? null
          : previous,
      );
    };
    window.addEventListener('req-hub-sync-deleted', removed);
    return () => window.removeEventListener('req-hub-sync-deleted', removed);
  }, []);
  useEffect(() => {
    if (!focusedSync || pendingSyncNavigation.current !== focusedSync) {
      return;
    }
    if (focusedSync.workspaceId !== workspace.id) {
      const target = workspaces.find((item) => item.id === focusedSync.workspaceId);
      if (target) {
        onSelectWorkspace(target);
      } else {
        pendingSyncNavigation.current = null;
        setFocusedSync(null);
        showToast({ tone: 'warning', text: t('DocsViewerBody.message001') });
      }
      return;
    }
    setSelectedReq({
      id: focusedSync.requirementId,
      title: focusedSync.requirementId,
      path: focusedSync.requirementPath || focusedSync.requirementId,
    });
    setSelectedFile(null);
    setShowFileTree(false);
    setActivePanel('sync');
    pendingSyncNavigation.current = null;
  }, [focusedSync, workspace.id]);
  useEffect(() => {
    setSelectedFile(null);
    setFileDirty(false);
    setShowFileTree(activePanel === 'files');
  }, [workspace.id]);
  useEffect(() => {
    if (!reportTarget) {
      return;
    }
    if (reportTarget.workspaceId !== workspace.id) {
      const target = workspaces.find((item) => item.id === reportTarget.workspaceId);
      if (target) {
        onSelectWorkspace(target, { reportTarget });
      } else {
        setReportTarget(null);
        showToast({ tone: 'warning', text: t('DocsViewerBody.message001') });
      }
      return;
    }
    selectionRevision.current++;
    if (reportTarget.kind === 'sync') {
      pendingSyncNavigation.current = reportTarget.task;
      setFocusedSync(reportTarget.task);
    } else if (reportTarget.kind === 'knowledge') {
      setFocusedKnowledge(reportTarget);
      setKnowledgeTab('sources');
      setShowFileTree(false);
      setActivePanel('knowledge');
    } else {
      const task = reportTarget.task;
      focusedSyncRef.current = task;
      setFocusedSync(task);
      setSelectedReq({
        id: task.requirementId,
        path: task.requirementPath,
        title: task.requirementId,
      });
      setSelectedFile({
        workspaceId: workspace.id,
        path: `${task.requirementPath}/${task.docType === 'design' ? 'design.md' : 'requirement.md'}`,
        name: task.docType === 'design' ? 'design.md' : 'requirement.md',
        type: task.docType,
      });
      setShowFileTree(true);
      setActivePanel('files');
    }
    setReportTarget(null);
  }, [reportTarget, workspace.id]);
  const [writingToolbarTarget, setWritingToolbarTarget] = useState(null);
  const [previewToolbarTarget, setPreviewToolbarTarget] = useState(null);
  const [headerBackTarget, setHeaderBackTarget] = useState(null);
  const [selectedReq, setSelectedReq] = useState(initialLocation?.requirement || null);
  const [creationStatus, setCreationStatus] = useState(null);
  const [creationNotice, setCreationNotice] = useState(null);
  const createRequest = useRef(null);
  const locateRequest = useRef(null);
  const [creationRefresh, setCreationRefresh] = useState(0);
  useEffect(() => () => locateRequest.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setCreationStatus(null);
    setCreationNotice(null);
    fetch(`${ROUTE}/create-status?workspaceId=${encodeURIComponent(workspace.id)}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!controller.signal.aborted) {
          setCreationStatus(data);
        }
      })
      .catch((error) => {
        // Creation status is optional; keep creation unavailable until a later successful refresh.
      });
    return () => {
      controller.abort();
      createRequest.current?.abort();
    };
  }, [workspace.id, docsDir, selectedReq?.id, creationRefresh]);
  const openCreation = async () => {
    createRequest.current?.abort();
    const controller = new AbortController();
    createRequest.current = controller;
    try {
      const res = await fetch(
        `${ROUTE}/create-status?workspaceId=${encodeURIComponent(workspace.id)}`,
        { signal: controller.signal, cache: 'no-store' },
      );
      if (!res.ok) {
        throw new Error('CREATE_FAILED');
      }
      const data = await res.json();
      if (controller.signal.aborted) {
        return;
      }
      setCreationStatus(data);
      if (data.existingRequirement) {
        setCreationNotice(data);
        return;
      }
      setShowFileTree(false);
      setCreationRefresh((value) => value + 1);
      setActivePanel('create');
    } catch {
      if (!controller.signal.aborted) {
        showToast({ tone: 'error', text: t('create.statusFailed') });
      }
    }
  };
  const [selectedFile, setSelectedFile] = useState(null);
  const [syncHint, setSyncHint] = useState(null);
  const [totalReqs, setTotalReqs] = useState(0);
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [showReqDirModal, setShowReqDirModal] = useState(false);
  const [showFileTree, setShowFileTree] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState(null); // expanded rail group
  const [initialCreateBranch, setInitialCreateBranch] = useState(!!initialLocation?.createBranch);
  const threeZoneRef = useRef(null);

  // Refs for cross-component communication
  const refreshTreeRef = useRef(() => {});
  const refreshSelectedReqRef = useRef(() => {});

  // Recheck on returning home; only confirmed commits for this exact selection show a sync action.
  const syncHintKey = JSON.stringify([workspace.id, docsDir, selectedReq?.id]);
  const hasSyncCommits = syncHint?.key === syncHintKey && syncHint.hasCommits;
  useEffect(() => {
    if (!selectedReq || activePanel || selectedFile) {
      return;
    }
    const controller = new AbortController();
    setSyncHint(null);
    const params = new URLSearchParams({
      workspaceId: workspace.id,
      requirementId: selectedReq.id,
    });
    fetch(`${ROUTE}/sync-commits?${params}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!controller.signal.aborted) {
          setSyncHint({
            key: syncHintKey,
            hasCommits: Array.isArray(data?.commits) && data.commits.length > 0,
          });
        }
      })
      .catch((error) => {
        // An unavailable commit hint must not expose a sync action without confirmed commits.
      });
    return () => controller.abort();
  }, [syncHintKey, activePanel, selectedFile]);

  // Auto-select requirement from config (initialReqId) or first available
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (initialLocation) {
      isInitialMount.current = false;
      return;
    }
    let cancelled = false;
    const revision = selectionRevision.current;
    (async () => {
      try {
        const res = await fetch(
          `${ROUTE}/tree?workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`,
        );
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        if (cancelled || revision !== selectionRevision.current || !data.tree?.developers) {
          return;
        }

        let found = null;

        // Try to restore from config
        const restoreId =
          focusedSyncRef.current?.workspaceId === workspace.id
            ? focusedSyncRef.current.requirementId
            : initialReqId;
        if (restoreId) {
          for (const dev of data.tree.developers) {
            for (const req of dev.requirements) {
              if (req.id === restoreId) {
                found = { ...req, developer: dev.name };
                break;
              }
            }
            if (found) {
              break;
            }
          }
        }

        // Fallback: first requirement of first developer (only on initial mount)
        if (!found && isInitialMount.current && data.tree.developers.length > 0) {
          const firstDev = data.tree.developers[0];
          if (firstDev.requirements.length > 0) {
            found = { ...firstDev.requirements[0], developer: firstDev.name };
          }
        }

        isInitialMount.current = false;

        if (found) {
          setSelectedReq(found);
        } else {
          setSelectedReq(null);
        }
      } catch (error) {
        // Keep the current selection when the saved requirement cannot be restored.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace.id, initialReqId, initialLocation]);

  // Fetch total requirements count
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${ROUTE}/tree?workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`,
        );
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setTotalReqs(data.totalRequirements || 0);
          }
        }
      } catch (error) {
        // Requirement counts are optional; keep the last available count on refresh failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  // Setup keyboard shortcuts
  useEffect(() => {
    const cleanup = setupKeyboardShortcuts({
      focusSearch: () => {
        setActivePanel('knowledge');
        setKnowledgeTab('query');
        setShowFileTree(false);
        setExpandedGroup(null);
      },
      createDir: openCreation,
      sync:
        selectedFile && (!activePanel || activePanel === 'files')
          ? undefined
          : () => {
              setActivePanel('sync');
              setShowFileTree(false);
            },
      toggleFileTree: () => {
        if (activePanel !== 'files') {
          setActivePanel('files');
          setShowFileTree(true);
        } else {
          setShowFileTree((prev) => !prev);
        }
      },
      closePanel: () => {
        if (activePanel) {
          setSelectedFile(null);
          setActivePanel(null);
        } else if (showFileTree) {
          setShowFileTree(false);
        }
      },
    });
    return cleanup;
  }, [activePanel, showFileTree, selectedFile?.path, workspace.id]);

  const handleSelectReq = async (req) => {
    selectionRevision.current++;
    pendingSyncNavigation.current = null;
    setFocusedSync(null);
    setSelectedReq(req);
    setSelectedFile(null);
    // Persist the selection without reloading the current document.
    if (req) {
      try {
        await fetch(`${ROUTE}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: workspace.id,
            developerName: req.developer,
            requirementId: req.id,
          }),
        });
      } catch (error) {
        // Keep the local selection when saving its preference fails.
      }
    }
  };

  // Refresh selected requirement from server
  const refreshSelectedReq = async () => {
    if (!selectedReq) {
      return;
    }
    try {
      const res = await fetch(
        `${ROUTE}/tree?workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`,
      );
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      if (!data.tree?.developers) {
        return;
      }

      // Find the updated requirement
      for (const dev of data.tree.developers) {
        for (const req of dev.requirements) {
          if (
            req.id === selectedReq.id &&
            (!selectedReq.path ||
              req.path.replaceAll('\\', '/') === selectedReq.path.replaceAll('\\', '/'))
          ) {
            setSelectedReq({ ...req, developer: dev.name });
            return;
          }
        }
      }
    } catch (error) {
      // Keep the existing branch label when its optional refresh fails.
    }
  };

  // Store refresh function in ref for use in hooks
  useEffect(() => {
    refreshSelectedReqRef.current = refreshSelectedReq;
  }, [refreshSelectedReq]);

  const handleSelectFile = (file) => {
    setActivePanel('files');
    setSelectedFile(file);
  };

  const closeSelectedFile = () => {
    const file = selectedFile;
    setSelectedFile(null);
    setFileDirty(false);
    if (file?.returnPanel === 'knowledge') {
      setKnowledgeTab(file.returnKnowledgeTab || 'wiki');
      setActivePanel('knowledge');
      setShowFileTree(false);
    }
  };

  const handlePanelClose = () => {
    // A file opened from the knowledge workspace must return to its source tab.
    if (selectedFile && (!activePanel || activePanel === 'files')) {
      closeSelectedFile();
    } else {
      setSelectedFile(null);
      setActivePanel(null);
    }
  };

  const [showCreateConfirm, setShowCreateConfirm] = useState(!!initialLocation?.pendingCreateReq);
  const [pendingCreateReq, setPendingCreateReq] = useState(
    initialLocation?.pendingCreateReq || null,
  );

  const doCreateAndSwitch = async (targetWorkspace, developer, date, title, requirementId) => {
    try {
      const createRes = await fetch(`${ROUTE}/create-dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: targetWorkspace.id, developer, date, title }),
      });

      const createData = await createRes.json();
      if (!createRes.ok) {
        showToast({
          tone: 'error',
          text: t('DocsViewerBody.message003', {
            value0: createData.error || t('DocsViewerBody.message002'),
          }),
          holdMs: 5000,
        });
        return;
      }

      showToast({
        tone: 'success',
        text: t('DocsViewerBody.message004', { value0: developer, value1: requirementId }),
        holdMs: 3000,
      });
      await refreshTree();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const newTreeRes = await fetch(
        `${ROUTE}/tree?workspaceId=${encodeURIComponent(targetWorkspace.id)}&t=${Date.now()}`,
      );
      if (newTreeRes.ok) {
        const newTreeData = await newTreeRes.json();
        if (newTreeData.tree?.developers) {
          for (const dev of newTreeData.tree.developers) {
            if (dev.name === developer) {
              for (const req of dev.requirements) {
                if (req.id === requirementId) {
                  await handleSelectReq({ ...req, developer: dev.name });
                  return;
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(t('DocsViewerBody.message005'), e);
    }
  };

  const handleLocateSessionReq = async () => {
    selectionRevision.current++;
    locateRequest.current?.abort();
    const controller = new AbortController();
    locateRequest.current = controller;
    const { signal } = controller;
    const locateFetch = async (url, options = {}) => {
      const response = await fetch(url, { ...options, cache: 'no-store', signal });
      signal.throwIfAborted();
      return response;
    };
    console.log(t('DocsViewerBody.message006'));
    try {
      const ctx = window.__DSH_CTX__;
      if (!ctx) {
        console.error(t('DocsViewerBody.message007'));
        return;
      }

      let currentSessionId = null;
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace');
        if (uiWorkspace) {
          if (uiWorkspace.selection && typeof uiWorkspace.selection.getSnapshot === 'function') {
            const selection = uiWorkspace.selection.getSnapshot();
            console.log(t('DocsViewerBody.message008'), selection);
            if (selection?.sessionId) {
              currentSessionId = selection.sessionId;
            }
          }
        }
      } catch (e) {
        console.error(t('DocsViewerBody.message009'), e);
      }

      if (!currentSessionId) {
        console.error(t('DocsViewerBody.message012'));
        showToast({ tone: 'warning', text: t('locate.noSession') });
        return;
      }

      console.log(t('DocsViewerBody.message013'), currentSessionId);

      const sessionRes = await locateFetch(
        `${ROUTE}/session-info?sessionId=${encodeURIComponent(currentSessionId)}`,
      );
      if (!sessionRes.ok) {
        console.error(t('DocsViewerBody.message014'), sessionRes.status);
        return;
      }
      const sessionData = await sessionRes.json();
      signal.throwIfAborted();
      console.log(t('DocsViewerBody.message015'), sessionData);

      if (!sessionData.session) {
        console.error(t('DocsViewerBody.message016'));
        return;
      }

      const session = sessionData.session;
      const sessionCwd = session.cwd;
      console.log(t('DocsViewerBody.message017'), sessionCwd);

      if (!sessionCwd) {
        console.error(t('DocsViewerBody.message018'));
        return;
      }

      console.log(t('DocsViewerBody.message019'));
      console.log(
        t('DocsViewerBody.message020'),
        workspaces.map((w) => ({ id: w.id, path: w.path, title: w.title })),
      );

      let targetWorkspace = null;
      for (const ws of workspaces) {
        const wsPath = ws.path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        const cwdPath = sessionCwd.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
        if (wsPath === cwdPath) {
          targetWorkspace = ws;
          break;
        }
      }

      if (!targetWorkspace) {
        console.error(t('DocsViewerBody.message021'), sessionCwd);
        return;
      }

      console.log(t('DocsViewerBody.message022'), targetWorkspace);

      console.log(t('DocsViewerBody.message026'));
      const branchRes = await locateFetch(
        `${ROUTE}/git-branch?workspaceId=${encodeURIComponent(targetWorkspace.id)}`,
      );
      if (!branchRes.ok) {
        console.error(t('DocsViewerBody.message027'), branchRes.status);
        return;
      }
      const branchData = await branchRes.json();
      signal.throwIfAborted();
      console.log(t('DocsViewerBody.message028'), branchData);
      if (!branchData.branch) {
        console.error(t('DocsViewerBody.message029'));
        return;
      }

      const branch = branchData.branch;
      const parsed = parseBranchName(branch);
      console.log(t('DocsViewerBody.message030'), branch);
      console.log(t('DocsViewerBody.message031'), parsed);

      // The parser always returns an object; a recognized requirement needs both developer and date.
      const isValidBranch = parsed && parsed.developer && parsed.date;
      console.log(t('DocsViewerBody.message032'), isValidBranch);

      if (!isValidBranch) {
        console.warn(t('DocsViewerBody.message033'), branch);
        selectionRevision.current++;
        isInitialMount.current = false;
        pendingSyncNavigation.current = null;
        setFocusedSync(null);
        setSelectedReq(null);
        setSelectedFile(null);
        setFileDirty(false);
        setShowFileTree(false);
        setPendingCreateReq(null);
        setShowCreateConfirm(false);
        try {
          const cleared = await locateFetch(`${ROUTE}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceId: targetWorkspace.id,
              developerName: null,
              requirementId: null,
            }),
          });
          if (!cleared.ok) {
            throw new Error('CONFIG_SAVE_FAILED');
          }
        } catch (e) {
          console.error(t('DocsViewerBody.message047'), e);
        }
        signal.throwIfAborted();
        if (targetWorkspace.id !== workspace.id) {
          onSelectWorkspace(targetWorkspace, { createBranch: true });
          return;
        }
        setCreationRefresh((value) => value + 1);
        setActivePanel('create');
        setInitialCreateBranch(true);
        showToast({
          tone: 'warning',
          text: t('DocsViewerBody.message034', { value0: branch }),
          holdMs: 5000,
        });
        return;
      }

      console.log(t('DocsViewerBody.message035'));

      const { developer, date, title, requirementId } = parsed;
      console.log(
        t('DocsViewerBody.message036'),
        developer,
        t('DocsViewerBody.message037'),
        date,
        t('DocsViewerBody.message038'),
        title,
        t('DocsViewerBody.message039'),
        requirementId,
      );

      console.log(t('DocsViewerBody.message040'));
      const treeRes = await locateFetch(
        `${ROUTE}/tree?workspaceId=${encodeURIComponent(targetWorkspace.id)}&t=${Date.now()}`,
      );
      if (!treeRes.ok) {
        console.error(t('DocsViewerBody.message041'), treeRes.status);
        return;
      }
      const treeData = await treeRes.json();
      signal.throwIfAborted();
      console.log(t('DocsViewerBody.message042'), treeData);

      const { match: existingReq, ambiguous } = findBranchRequirement(
        treeData.tree,
        parsed,
        treeData.caseSensitivePaths !== false,
      );
      if (ambiguous) {
        showToast({ tone: 'warning', text: t('locate.ambiguous'), holdMs: 5000 });
        return;
      }

      if (existingReq) {
        console.log(t('DocsViewerBody.message046'), existingReq);

        try {
          await locateFetch(`${ROUTE}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceId: targetWorkspace.id,
              developerName: existingReq.developer,
              requirementId: existingReq.id,
            }),
          });
        } catch (e) {
          console.error(t('DocsViewerBody.message047'), e);
        }
        signal.throwIfAborted();
        if (targetWorkspace.id !== workspace.id) {
          onSelectWorkspace(targetWorkspace, { requirement: existingReq });
          return;
        }
        pendingSyncNavigation.current = null;
        setFocusedSync(null);
        setSelectedReq(existingReq);
        setSelectedFile(null);
        console.log(t('DocsViewerBody.message048'));
        return;
      }

      console.log(t('DocsViewerBody.message049'));

      const pending = { workspace: targetWorkspace, developer, date, title, requirementId };
      if (targetWorkspace.id !== workspace.id) {
        await locateFetch(`${ROUTE}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: targetWorkspace.id,
            developerName: null,
            requirementId: null,
          }),
        });
        signal.throwIfAborted();
        onSelectWorkspace(targetWorkspace, { pendingCreateReq: pending });
        return;
      }
      setPendingCreateReq(pending);
      setShowCreateConfirm(true);
    } catch (e) {
      if (!signal.aborted) {
        console.error(t('DocsViewerBody.message050'), e);
      }
    }
  };

  // Context value for child components
  const contextValue = {
    syncActivity: syncMonitor.active,
    headerBackTarget,
    refreshTree: () => refreshTreeRef.current?.(),
    refreshSelectedReq: () => refreshSelectedReqRef.current?.(),
  };

  // Rail buttons config
  const topButtons = [
    { id: 'create', icon: h(IconPlus, { size: 18 }), label: t('DocsViewerBody.message051') },
    { id: 'writing', icon: h(IconEdit, { size: 18 }), label: t('DocsViewerBody.message056') },
    { id: 'files', icon: h(IconFile, { size: 18 }), label: t('files.title') },
    { id: 'knowledge', icon: h(IconBooks, { size: 18 }), label: t('kb.title') },
    { id: 'sync', icon: h(IconSync, { size: 18 }), label: t('DocsViewerBody.message052') },
  ];
  const bottomButtons = [
    { id: 'reports', icon: h(IconReports, { size: 18 }), label: t('reports.title') },
    { id: 'log', icon: h(IconLog, { size: 18 }), label: t('DocsViewerBody.message057') },
    { id: 'settings', icon: h(IconSettings, { size: 18 }), label: t('DocsViewerBody.message058') },
  ];

  const renderDocumentPreview = () => {
    if (!selectedFile) {
      return null;
    }
    return h(FilePreview, {
      workspaceId: selectedFile.workspaceId || workspace.id,
      relPath: selectedFile.path,
      name: selectedFile.name,
      requirement:
        selectedFile.requirement ||
        (selectedReq
          ? { title: selectedReq.title, date: selectedReq.date, type: selectedFile.type }
          : null),
      onBack: closeSelectedFile,
      showToc,
      onToggleToc: () => setShowToc(!showToc),
      toolbarTarget: previewToolbarTarget,
      onSaved: () => {
        setFileRevision((value) => value + 1);
      },
      onDirtyChange: setFileDirty,
      active: !activePanel || activePanel === 'files',
      assist: h(DocumentAssist, {
        assistant: true,
        key: `${selectedFile.workspaceId || workspace.id}:${selectedFile.path}`,
        workspaceId: selectedFile.workspaceId || workspace.id,
        path: selectedFile.path,
        revision: fileRevision,
        dirty: fileDirty,
        onOpenSource: (source) =>
          setSelectedFile({
            path: source.relativePath,
            name: source.relativePath.split('/').at(-1),
            workspaceId: source.workspaceId,
            requirement: selectedFile.requirement,
          }),
      }),
    });
  };

  const renderPanel = () => {
    if (!activePanel) {
      return null;
    }
    if (activePanel === 'create') {
      return h(CreateDirForm, {
        workspaceId: workspace.id,
        docsDir,
        onClose: handlePanelClose,
        initialCreateBranch,
        refreshVersion: creationRefresh,
        onExisting: (req, branch) => {
          const data = { branch, existingRequirement: req };
          setCreationStatus(data);
          setCreationNotice(data);
        },
        onCreated: async (info) => {
          setInitialCreateBranch(false);

          await new Promise((resolve) => setTimeout(resolve, 500));
          const treeRes = await fetch(
            `${ROUTE}/tree?workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`,
          );
          if (treeRes.ok) {
            const treeData = await treeRes.json();
            if (treeData.tree?.developers) {
              for (const dev of treeData.tree.developers) {
                if (dev.name === info.developer) {
                  for (const req of dev.requirements) {
                    if (req.id === info.requirementId) {
                      await handleSelectReq({ ...req, developer: dev.name });
                      return;
                    }
                  }
                }
              }
            }
          }
        },
      });
    }
    if (activePanel === 'sync') {
      return h(SyncPanel, {
        key: `${workspace.id}:${selectedReq?.id}:${focusedSync?.snapshotDir || ''}`,
        focusedSync: focusedSync?.requirementId === selectedReq?.id ? focusedSync : null,
        workspaceId: workspace.id,
        selectedReq,
        onClose: handlePanelClose,
      });
    }
    if (activePanel === 'log') {
      return h(LogPanel, {
        onClose: handlePanelClose,
      });
    }
    if (activePanel === 'reports') {
      return h(TaskReportsPanel, { onClose: handlePanelClose, onNavigate: setReportTarget });
    }
    if (activePanel === 'settings') {
      return h(SettingsPanel, {
        workspaceId: workspace.id,
        onClose: handlePanelClose,
        initialTab: settingsTab,
      });
    }
    return null;
  };

  // Right panel content
  const renderRightContent = () => {
    if (activePanel === 'files') {
      return selectedFile
        ? renderDocumentPreview()
        : h(EmptyState, {
            title: t('files.empty'),
            description: t('files.emptyHint'),
          });
    }
    if (activePanel) {
      return renderPanel();
    }
    if (selectedFile) {
      return renderDocumentPreview();
    }
    // An existing requirement needs next-step guidance, not another creation prompt.
    if (selectedReq) {
      return h(EmptyState, {
        title: t('DocsViewerBody.message059'),
        description: t('DocsViewerBody.message061', {
          value0: selectedReq.title || selectedReq.id,
          value1: hasSyncCommits ? t('DocsViewerBody.message060') : '',
        }),
        actions: [
          {
            label: t('DocsViewerBody.message062'),
            variant: 'primary',
            onClick: () => {
              setActivePanel('writing');
              setShowFileTree(false);
            },
          },
          {
            label: t('DocsViewerBody.message063'),
            onClick: () => {
              setActivePanel('files');
              setShowFileTree(true);
            },
          },
          ...(hasSyncCommits
            ? [
                {
                  label: t('DocsViewerBody.message064'),
                  onClick: () => {
                    setActivePanel('sync');
                    setShowFileTree(false);
                  },
                },
              ]
            : []),
        ],
      });
    }
    // No requirement selected yet: select an existing directory or create one.
    return h(EmptyState, {
      title: t('DocsViewerBody.message065'),
      description: t('DocsViewerBody.message066'),
      actions: [
        {
          label: t('DocsViewerBody.message067'),
          variant: 'primary',
          onClick: () => setShowReqDirModal(true),
        },
        {
          label: t('DocsViewerBody.message068'),
          onClick: () => {
            setActivePanel('create');
            setShowFileTree(false);
          },
        },
      ],
    });
  };

  let rightHeaderTitle;
  if (activePanel) {
    if (activePanel === 'create') {
      rightHeaderTitle = t('DocsViewerBody.message069');
    } else if (activePanel === 'knowledge') {
      rightHeaderTitle = t('kb.title');
    } else if (activePanel === 'files') {
      rightHeaderTitle = t('files.title');
    } else if (activePanel === 'writing') {
      rightHeaderTitle = t('DocsViewerBody.message056');
    } else if (activePanel === 'log') {
      rightHeaderTitle = t('DocsViewerBody.message070');
    } else if (activePanel === 'settings') {
      rightHeaderTitle = t('DocsViewerBody.message058');
    } else {
      rightHeaderTitle = '';
    }
  } else {
    rightHeaderTitle = '';
  }

  // Build breadcrumb items for file preview (shown in header instead of FilePreview)
  const showingDocument = !!selectedFile && (!activePanel || activePanel === 'files');
  const filePreviewBreadcrumb = showingDocument
    ? [
        {
          label: selectedFile.workspaceTitle || t('DocsViewerBody.message071'),
          onClick: () => setSelectedFile(null),
        },
        ...(selectedFile.requirement || selectedReq
          ? [
              {
                label:
                  (selectedFile.requirement || selectedReq).title || t('DocsViewerBody.message072'),
              },
            ]
          : []),
        { label: selectedFile.name },
      ]
    : null;

  return h(
    DocsViewerContext.Provider,
    { value: contextValue },
    showingDocument &&
      h(HeaderBack, {
        onBack: closeSelectedFile,
      }),
    h(
      'div',
      { className: 'rh-root' },
      // ── Top bar ──
      h(TopBar, {
        docsDir,
        currentWorkspace: workspace,
        currentReq: selectedReq,
        onEditDocsDir: onConfigChange,
        onChangeWorkspace: () => setShowWorkspaceModal(true),
        onChangeReq: () => setShowReqDirModal(true),
        onLocateSessionReq: handleLocateSessionReq,
      }),

      h(
        'div',
        { className: 'rh-three-zone', ref: threeZoneRef },
        // ── Left: Rail toolbar ──
        h(
          'div',
          { className: 'rh-rail' },
          topButtons.map((btn) => {
            // Group button with sub-buttons
            if (btn.group) {
              const isGroupExpanded = expandedGroup === btn.group;
              const isSubActive = btn.subButtons.some((sb) => activePanel === sb.id);
              return h(
                'div',
                { key: btn.id, className: 'rh-rail-group' },
                h(
                  'button',
                  {
                    className: `rh-rail-btn${isSubActive ? ' active' : ''}${isGroupExpanded ? ' expanded' : ''}`,
                    type: 'button',
                    'aria-expanded': isGroupExpanded,
                    onClick: () => {
                      if (isGroupExpanded) {
                        setExpandedGroup(null);
                      } else {
                        setExpandedGroup(btn.group);
                      }
                    },
                  },
                  h('span', null, btn.icon),
                  h('span', { className: 'rh-rail-label' }, btn.label),
                  h(
                    'span',
                    { className: 'rh-rail-action', 'aria-hidden': true },
                    t(isGroupExpanded ? 'disclosure.collapse' : 'disclosure.expand'),
                  ),
                ),
                isGroupExpanded &&
                  h(
                    'div',
                    { className: 'rh-rail-sub' },
                    btn.subButtons.map((sb) =>
                      h(
                        'button',
                        {
                          key: sb.id,
                          className: `rh-rail-sub-btn${activePanel === sb.id ? ' active' : ''}`,
                          onClick: () => setActivePanel(activePanel === sb.id ? null : sb.id),
                        },
                        h('span', null, sb.icon),
                        h('span', { className: 'rh-rail-label' }, sb.label),
                      ),
                    ),
                  ),
              );
            }
            // Regular button
            return h(
              'button',
              {
                key: btn.id,
                className: `rh-rail-btn${activePanel === btn.id ? ' active' : ''}${btn.id === 'create' && creationStatus?.existingRequirement ? ` ${css.creationUnavailable}` : ''}`,
                'aria-disabled':
                  (btn.id === 'create' && !!creationStatus?.existingRequirement) || undefined,
                onClick: () => {
                  if (btn.id === 'create') {
                    openCreation();
                    return;
                  }
                  setExpandedGroup(null);
                  if (activePanel === btn.id) {
                    setSelectedFile(null);
                    setActivePanel(null);
                    setShowFileTree(false);
                  } else {
                    setShowFileTree(btn.id === 'files');
                    setActivePanel(btn.id);
                  }
                },
              },
              h('span', null, btn.icon),
              h('span', { className: 'rh-rail-label' }, btn.label),
            );
          }),
          h(
            'div',
            { className: 'rh-rail-bottom' },
            bottomButtons.map((btn) =>
              h(
                'button',
                {
                  key: btn.id,
                  className: `rh-rail-btn${activePanel === btn.id ? ' active' : ''}`,
                  onClick: () => {
                    setExpandedGroup(null);
                    // Toggle: if already active, close everything
                    if (activePanel === btn.id) {
                      setActivePanel(null);
                      setShowFileTree(false);
                    } else {
                      setShowFileTree(false);
                      setActivePanel(btn.id);
                    }
                  },
                },
                h('span', null, btn.icon),
                h('span', { className: 'rh-rail-label' }, btn.label),
              ),
            ),
          ),
        ),

        h(
          'div',
          { className: css.workspace },
          h(
            'div',
            { className: css.workspaceBody },
            // ── File Tree Sidebar (only when the files view is active) ──
            activePanel === 'files' &&
              h(FileTreeSidebar, {
                expanded: showFileTree,
                onExpandedChange: setShowFileTree,
                id: 'files-tree',
                workspaceId: workspace.id,
                selectedReq,
                key: workspace.id,
                onSelectFile: handleSelectFile,
              }),

            // ── Right: Trace / Operations / File Preview ──
            h(
              'div',
              {
                className: 'rh-right-panel' + ' ' + css.content,
              },
              activePanel !== 'sync' &&
                activePanel !== 'log' &&
                activePanel !== 'settings' &&
                activePanel !== 'knowledge' &&
                h(
                  'div',
                  {
                    className: `rh-right-header${activePanel === 'writing' ? ` ${css.writingHeader}` : ''}`,
                  },
                  h('div', { className: 'rh-header-back-slot', ref: setHeaderBackTarget }),
                  h(
                    'div',
                    { className: 'rh-right-header-main' },
                    filePreviewBreadcrumb
                      ? h(Breadcrumb, { items: filePreviewBreadcrumb })
                      : activePanel !== 'writing' &&
                          h(
                            'span',
                            { className: 'rh-right-header-title' },
                            rightHeaderTitle || t('DocsViewerBody.message073'),
                          ),
                    filePreviewBreadcrumb &&
                      /\.(md|markdown|txt|text|html?)$/i.test(selectedFile.name) &&
                      h(FileKnowledgeAction, {
                        key: `${selectedFile.workspaceId || workspace.id}:${selectedFile.path}`,
                        workspaceId: selectedFile.workspaceId || workspace.id,
                        path: selectedFile.path,
                        revision: fileRevision,
                        dirty: fileDirty,
                      }),
                    activePanel === 'writing' &&
                      h('div', { className: css.writingToolbarSlot, ref: setWritingToolbarTarget }),
                    filePreviewBreadcrumb &&
                      h('div', { className: 'rh-preview-actions', ref: setPreviewToolbarTarget }),
                  ),
                  (activePanel || selectedFile) &&
                    h(
                      Button,
                      {
                        type: 'button',
                        className: 'rh-btn rh-btn-ghost rh-btn-sm rh-right-close',
                        onClick: handlePanelClose,
                        'aria-label': t('DocsViewerBody.message076'),
                      },
                      t('common.close'),
                    ),
                ),
              knowledgeMounted.current &&
                h(
                  'div',
                  {
                    key: `knowledge:${workspace.id}`,
                    className: css.size,
                    style: {
                      '--rh-display-0': cssValue(activePanel === 'knowledge' ? 'flex' : 'none'),
                    },
                  },
                  h(KnowledgeWorkspace, {
                    workspaceId: workspace.id,
                    tab: knowledgeTab,
                    onTabChange: setKnowledgeTab,
                    active: activePanel === 'knowledge',
                    docsDir,
                    initialSourceId:
                      focusedKnowledge?.workspaceId === workspace.id
                        ? focusedKnowledge.documentId
                        : null,
                    onOpenFile: (relativePath) => {
                      setSelectedFile({
                        path: relativePath,
                        name: relativePath.split('/').at(-1),
                        workspaceId: workspace.id,
                        returnPanel: 'knowledge',
                        returnKnowledgeTab: knowledgeTab,
                      });
                      setActivePanel('files');
                      setShowFileTree(true);
                    },
                  }),
                ),
              writingMounted.current &&
                h(
                  'div',
                  {
                    key: `writing:${workspace.id}`,
                    className: css.size,
                    style: {
                      '--rh-display-0': cssValue(activePanel === 'writing' ? 'flex' : 'none'),
                    },
                  },
                  h(WritingPanel, {
                    active: activePanel === 'writing',
                    toolbarTarget: activePanel === 'writing' ? writingToolbarTarget : null,
                    docsDir,
                    workspaceId: workspace.id,
                    requirement: selectedReq,
                    onSaved: () => refreshSelectedReqRef.current(),
                  }),
                ),
              activePanel !== 'writing' &&
                activePanel !== 'knowledge' &&
                (selectedFile && (!activePanel || activePanel === 'files')
                  ? renderRightContent()
                  : h(
                      'div',
                      {
                        className: `rh-right-body${['reports', 'log', 'sync'].includes(activePanel) ? ` ${css.knowledgeBody}` : ''}`,
                      },
                      renderRightContent(),
                    )),
            ),
          ),
        ),
      ),

      // ── Status bar (4.24) ──
      h(
        'div',
        { className: 'rh-statusbar' },
        h('span', null, t('common.versionLabel')),
        h(SyncStatusBar, {
          monitor: syncMonitor,
          onOpen: (task) => {
            selectionRevision.current++;
            pendingSyncNavigation.current = task;
            setFocusedSync(task);
          },
        }),
        h(
          'span',
          null,
          t('shell.docsPath', { value0: docsDir }),
          h('span', { className: css.heading }, t('shell.requirementCount', { value0: totalReqs })),
        ),
      ),

      creationNotice &&
        h(
          ModalFrame,
          { 'aria-label': t('create.existingTitle'), onClick: () => setCreationNotice(null) },
          h(
            'div',
            { className: 'rh-confirm-dialog', onClick: (event) => event.stopPropagation() },
            h(
              'div',
              { className: 'rh-confirm-header' },
              h('h3', { className: 'rh-confirm-title' }, t('create.existingTitle')),
            ),
            h(
              'div',
              { className: `rh-confirm-body ${css.creationNoticeBody}` },
              h(
                'dl',
                { className: css.creationDetails },
                [
                  [t('create.existingBranch'), creationNotice.branch],
                  [t('create.existingDirectory'), creationNotice.existingRequirement.path],
                ].map(([label, value]) =>
                  h(
                    React.Fragment,
                    { key: label },
                    h('dt', null, label),
                    h(
                      'dd',
                      null,
                      h(
                        Tooltip,
                        { label: value, className: css.creationDetailTooltip },
                        h('span', { className: css.creationDetailValue, tabIndex: 0 }, value),
                      ),
                    ),
                  ),
                ),
              ),
              h('p', { className: css.creationNoticeHint }, t('create.existingHint')),
            ),
            h(
              'div',
              { className: 'rh-confirm-footer' },
              h(Button, { onClick: () => setCreationNotice(null) }, t('common.confirm')),
            ),
          ),
        ),

      // ── Workspace modal ──
      showWorkspaceModal &&
        h(WorkspaceModal, {
          workspaces,
          selectedId: workspace.id,
          onSelect: async (ws) => {
            onSelectWorkspace(ws);
            // Save to config and clear requirement selection
            try {
              await fetch(`${ROUTE}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  workspaceId: ws.id,
                  developerName: null,
                  requirementId: null,
                }),
              });
              onConfigChange();
            } catch (error) {
              // Keep the selected workspace locally when preference persistence fails.
            }
          },
          onClose: () => setShowWorkspaceModal(false),
        }),

      // ── Requirement directory modal ──
      showReqDirModal &&
        h(RequirementDirModal, {
          workspaceId: workspace.id,
          selectedReqId: selectedReq?.id || null,
          onSelect: handleSelectReq,
          onClose: () => setShowReqDirModal(false),
        }),

      showCreateConfirm &&
        pendingCreateReq &&
        h(ConfirmModal, {
          title: t('DocsViewerBody.message069'),
          message: t('DocsViewerBody.message077', {
            value0: pendingCreateReq.developer,
            value1: pendingCreateReq.requirementId,
          }),
          onConfirm: () => {
            setShowCreateConfirm(false);
            const { workspace: ws, developer, date, title, requirementId } = pendingCreateReq;
            setPendingCreateReq(null);
            doCreateAndSwitch(ws, developer, date, title, requirementId);
          },
          onCancel: () => {
            setShowCreateConfirm(false);
            setPendingCreateReq(null);
          },
        }),

      // ── Global Toast and Confirm containers ──

      h(ConfirmDialogContainer, null),
    ),
  );
}

module.exports = { DocsViewerBody };
