'use strict';
const { t } = require('../locale.js');
const css = require('./DocsViewerBody.module.css').default;
const { cssValue } = require('./shared/presentation.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef } = React;

const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');
const { createIconComponents } = require('../icons.js');

const { IconPlus, IconSync, IconBooks, IconEdit, IconLog, IconSettings } = createIconComponents(h);

const { parseBranchName } = require('../utils/parseBranchName.js');
const { TopBar } = require('./TopBar.js');
const { CreateDirForm } = require('./CreateDirForm.js');
const { FilePreview } = require('./FilePreview.js');
const { FileKnowledgeAction } = require('./FileKnowledgeAction.js');
const { SyncPanel } = require('./SyncPanel.js');
const { SyncStatusBar } = require('./SyncStatusBar.js');
const { useSyncMonitor } = require('../hooks/useSyncMonitor.js');
const { WritingPanel } = require('./WritingPanel.js');
const { LogPanel } = require('./LogPanel.js');
const { SettingsPanel } = require('./SettingsPanel.js');
const { WorkspaceModal } = require('./WorkspaceModal.js');
const { RequirementDirModal } = require('./RequirementDirModal.js');
const { FileTreeSidebar } = require('./FileTreeSidebar.js');
const { ConfirmModal } = require('./ConfirmModal.js');  // 保留兼容，新代码使用 showConfirm()
const { KnowledgePanel } = require('./KnowledgePanel.js');
const { KnowledgeTabs } = require('./KnowledgeTabs.js');
const { useKnowledge } = require('../hooks/useKnowledge.js');
const { SearchPanel } = require('./SearchPanel.js');
const { EmptyState } = require('./shared/EmptyState.js');
const { Breadcrumb } = require('./shared/Breadcrumb.js');
const { HeaderBack } = require('./shared/HeaderBack.js');
const { showToast } = require('./shared/ToastContainer.js');
const { ConfirmDialogContainer, showConfirm } = require('./shared/ConfirmDialog.js');
const { Skeleton } = require('./shared/Skeleton.js');
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
 * @param {Function} props.onSelectWorkspace - Callback invoked when a workspace is selected
 * @param {string} [props.initialReqId] - Initial requirement ID to restore selection from config
 * @returns {JSX.Element} The complete document viewer interface with rail toolbar, panels, and modals
 */
function DocsViewerBody({ workspace, docsDir, onConfigChange, workspaces, onSelectWorkspace, initialReqId }) {
  const [activePanel, setActivePanel] = useState(null);
  const [knowledgeTab, setKnowledgeTab] = useState('documents');
  const [fileRevision, setFileRevision] = useState(0);
  const [fileDirty, setFileDirty] = useState(false);
  const isKnowledgeSearch = activePanel === 'knowledge' && knowledgeTab === 'search';
  const hasKnowledgeTree = ['documents', 'files'].includes(knowledgeTab);
  const changeKnowledgeTab = tab => { setKnowledgeTab(tab); setShowFileTree(['documents', 'files'].includes(tab)); };
  const writingMounted = useRef(false);
  if (activePanel === 'writing') writingMounted.current = true;
  const knowledge = useKnowledge(workspace.id);
  const syncMonitor = useSyncMonitor();
  const [focusedSync, setFocusedSync] = useState(null);
  const pendingSyncNavigation = useRef(null), selectionRevision = useRef(0), focusedSyncRef = useRef(null);
  focusedSyncRef.current = focusedSync;
  useEffect(() => {
    const removed = event => {
      const task = event.detail;
      setFocusedSync(previous => previous?.workspaceId === task.workspaceId && previous?.requirementId === task.requirementId && previous?.snapshotDir === task.snapshotDir ? null : previous);
    };
    window.addEventListener('req-hub-sync-deleted', removed);
    return () => window.removeEventListener('req-hub-sync-deleted', removed);
  }, []);
  useEffect(() => {
    if (!focusedSync || pendingSyncNavigation.current !== focusedSync) return;
    if (focusedSync.workspaceId !== workspace.id) {
      const target = workspaces.find(item => item.id === focusedSync.workspaceId);
      if (target) onSelectWorkspace(target);
      else { pendingSyncNavigation.current = null; setFocusedSync(null); showToast({ tone: 'warning', text: t("DocsViewerBody.message001") }); }
      return;
    }
    setSelectedReq({ id: focusedSync.requirementId, title: focusedSync.requirementId, path: focusedSync.requirementPath || focusedSync.requirementId });
    setSelectedFile(null); setShowFileTree(false); setActivePanel('sync');
    pendingSyncNavigation.current = null;
  }, [focusedSync, workspace.id]);
  useEffect(() => { setSelectedFile(null); setFileDirty(false); setShowFileTree(activePanel === 'knowledge' && hasKnowledgeTree); }, [workspace.id]);
  const [previewToolbarTarget, setPreviewToolbarTarget] = useState(null);
  const [headerBackTarget, setHeaderBackTarget] = useState(null);
  const [selectedReq, setSelectedReq] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [syncHint, setSyncHint] = useState(null);
  const [totalReqs, setTotalReqs] = useState(0);
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [showReqDirModal, setShowReqDirModal] = useState(false);
  const [showFileTree, setShowFileTree] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState(null); // expanded rail group
  const [initialCreateBranch, setInitialCreateBranch] = useState(false); // 新建面板是否默认勾选"新建分支"
  const threeZoneRef = useRef(null);

  // Refs for cross-component communication
  const refreshTreeRef = useRef(() => {});
  const refreshSelectedReqRef = useRef(() => {});

  // Recheck on returning home; only confirmed commits for this exact selection show a sync action.
  const syncHintKey = JSON.stringify([workspace.id, docsDir, selectedReq?.id]);
  const hasSyncCommits = syncHint?.key === syncHintKey && syncHint.hasCommits;
  useEffect(() => {
    if (!selectedReq || activePanel || selectedFile) return;
    const controller = new AbortController();
    setSyncHint(null);
    const params = new URLSearchParams({ workspaceId: workspace.id, requirementId: selectedReq.id });
    fetch(`${ROUTE}/sync-commits?${params}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!controller.signal.aborted) setSyncHint({ key: syncHintKey, hasCommits: Array.isArray(data?.commits) && data.commits.length > 0 });
      }).catch(() => {});
    return () => controller.abort();
  }, [syncHintKey, activePanel, selectedFile]);

  // Auto-select requirement from config (initialReqId) or first available
  const isInitialMount = useRef(true);
  useEffect(() => {
    let cancelled = false;
    const revision = selectionRevision.current;
    (async () => {
      try {
        const res = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || revision !== selectionRevision.current || !data.tree?.developers) return;

        let found = null;

        // Try to restore from config
        const restoreId = focusedSyncRef.current?.workspaceId === workspace.id ? focusedSyncRef.current.requirementId : initialReqId;
        if (restoreId) {
          for (const dev of data.tree.developers) {
            for (const req of dev.requirements) {
              if (req.id === restoreId) {
                found = { ...req, developer: dev.name };
                break;
              }
            }
            if (found) break;
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

        if (found) setSelectedReq(found);
        else setSelectedReq(null);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [workspace.id, initialReqId]);

  // Fetch total requirements count
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setTotalReqs(data.totalRequirements || 0);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [workspace.id]);

  // Setup keyboard shortcuts
  useEffect(() => {
    const cleanup = setupKeyboardShortcuts({
      focusSearch: () => {
        setActivePanel('knowledge');
        setKnowledgeTab('search');
        setShowFileTree(false);
        setExpandedGroup(null);
      },
      createDir: () => { setActivePanel('create'); setShowFileTree(false); },
      sync: selectedFile && (!activePanel || activePanel === 'knowledge' && knowledgeTab === 'documents') ? undefined : () => { setActivePanel('sync'); setShowFileTree(false); },
      toggleFileTree: () => {
        if (activePanel !== 'knowledge' || !hasKnowledgeTree) { setActivePanel('knowledge'); setKnowledgeTab('documents'); setShowFileTree(true); }
        else setShowFileTree(prev => !prev);
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
  }, [activePanel, showFileTree, knowledgeTab, selectedFile?.path]);

  const handleSelectReq = async (req) => {
    selectionRevision.current++; pendingSyncNavigation.current = null; setFocusedSync(null);
    setSelectedReq(req);
    setSelectedFile(null);
    // Save to config (只保存需求选择，不触发重新加载)
    if (req) {
      try {
        await fetch(`${ROUTE}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: workspace.id,
            developerName: req.developer,
            requirementId: req.id
          }),
        });
      } catch { /* ignore */ }
    }
  };

  // Refresh selected requirement from server
  const refreshSelectedReq = async () => {
    if (!selectedReq) return;
    try {
      const res = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.tree?.developers) return;

      // Find the updated requirement
      for (const dev of data.tree.developers) {
        for (const req of dev.requirements) {
          if (req.id === selectedReq.id) {
            setSelectedReq({ ...req, developer: dev.name });
            return;
          }
        }
      }
    } catch { /* ignore */ }
  };

  // Store refresh function in ref for use in hooks
  useEffect(() => {
    refreshSelectedReqRef.current = refreshSelectedReq;
  }, [refreshSelectedReq]);

  const handleSelectFile = (file) => {
    setKnowledgeTab('documents');
    setActivePanel('knowledge');
    setSelectedFile(file);
  };

  const handlePanelClose = () => {
    // If viewing a file, just close the file preview
    if (selectedFile && (!activePanel || activePanel === 'knowledge' && knowledgeTab === 'documents')) {
      setSelectedFile(null);
    } else {
      // Otherwise close the active panel
      setSelectedFile(null);
      setActivePanel(null);
    }
  };

  // 定位到当前会话需求目录
  const [showCreateConfirm, setShowCreateConfirm] = useState(false);
  const [pendingCreateReq, setPendingCreateReq] = useState(null);

  const doCreateAndSwitch = async (targetWorkspace, developer, date, title, requirementId) => {
    try {
      const createRes = await fetch(`${ROUTE}/create-dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: targetWorkspace.id, developer, date, title }),
      });

      const createData = await createRes.json();
      if (!createRes.ok) {
        showToast({ tone: 'error', text: t("DocsViewerBody.message003", { value0: createData.error || t("DocsViewerBody.message002") }), holdMs: 5000 });
        return;
      }

      showToast({ tone: 'success', text: t("DocsViewerBody.message004", { value0: developer, value1: requirementId }), holdMs: 3000 });
      await refreshTree();
      await new Promise(resolve => setTimeout(resolve, 300));

      const newTreeRes = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(targetWorkspace.id)}&t=${Date.now()}`);
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
      console.error(t("DocsViewerBody.message005"), e);
    }
  };

  const handleLocateSessionReq = async () => {
    console.log(t("DocsViewerBody.message006"));
    try {
      // 1. 获取当前会话 ID（从 DSH 上下文获取）
      const ctx = window.__DSH_CTX__;
      if (!ctx) {
        console.error(t("DocsViewerBody.message007"));
        return;
      }

      // 从 uiWorkspace.selection 获取当前选择的会话（当前页面显示的会话）
      let currentSessionId = null;
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace');
        if (uiWorkspace) {
          // 尝试从 selection 属性获取
          if (uiWorkspace.selection && typeof uiWorkspace.selection.getSnapshot === 'function') {
            const selection = uiWorkspace.selection.getSnapshot();
            console.log(t("DocsViewerBody.message008"), selection);
            if (selection?.sessionId) {
              currentSessionId = selection.sessionId;
            }
          }
        }
      } catch (e) {
        console.error(t("DocsViewerBody.message009"), e);
      }

      // 备用方案：从 sessions 服务获取最新的主会话
      if (!currentSessionId) {
        try {
          const sessions = ctx.get?.('sessions');
          if (sessions && typeof sessions.list?.getSnapshot === 'function') {
            const snapshot = sessions.list.getSnapshot();
            console.log(t("DocsViewerBody.message010"), snapshot?.ids?.slice(0, 3));
            if (snapshot?.ids && snapshot.ids.length > 0) {
              currentSessionId = snapshot.ids[0];
            }
          }
        } catch (e) {
          console.error(t("DocsViewerBody.message011"), e);
        }
      }

      if (!currentSessionId) {
        console.error(t("DocsViewerBody.message012"));
        return;
      }

      console.log(t("DocsViewerBody.message013"), currentSessionId);

      // 2. 获取会话详情
      const sessionRes = await fetch(`${ROUTE}/session-info?sessionId=${encodeURIComponent(currentSessionId)}`);
      if (!sessionRes.ok) {
        console.error(t("DocsViewerBody.message014"), sessionRes.status);
        return;
      }
      const sessionData = await sessionRes.json();
      console.log(t("DocsViewerBody.message015"), sessionData);

      if (!sessionData.session) {
        console.error(t("DocsViewerBody.message016"));
        return;
      }

      const session = sessionData.session;
      const sessionCwd = session.cwd;
      console.log(t("DocsViewerBody.message017"), sessionCwd);

      if (!sessionCwd) {
        console.error(t("DocsViewerBody.message018"));
        return;
      }

      // 3. 根据会话的工作目录找到对应的工作区
      console.log(t("DocsViewerBody.message019"));
      console.log(t("DocsViewerBody.message020"), workspaces.map(w => ({ id: w.id, path: w.path, title: w.title })));

      let targetWorkspace = null;
      for (const ws of workspaces) {
        // 比较路径（可能需要处理路径格式差异）
        const wsPath = ws.path.replace(/\\/g, '/').toLowerCase();
        const cwdPath = sessionCwd.replace(/\\/g, '/').toLowerCase();
        if (wsPath === cwdPath || wsPath.endsWith('/' + cwdPath) || cwdPath.endsWith('/' + wsPath)) {
          targetWorkspace = ws;
          break;
        }
      }

      if (!targetWorkspace) {
        console.error(t("DocsViewerBody.message021"), sessionCwd);
        return;
      }

      console.log(t("DocsViewerBody.message022"), targetWorkspace);

      // 4. 如果工作区不匹配，先切换工作区并持久化
      if (targetWorkspace.id !== workspace.id) {
        console.log(t("DocsViewerBody.message023"), targetWorkspace.id);

        // 更新配置（持久化工作区选择）
        try {
          await fetch(`${ROUTE}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: targetWorkspace.id }),
          });
          console.log(t("DocsViewerBody.message024"));
        } catch (e) {
          console.error(t("DocsViewerBody.message025"), e);
        }

        // 切换工作区（更新 React 状态）
        onSelectWorkspace(targetWorkspace);

        // 等待状态更新
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // 5. 获取工作区的 Git 分支
      console.log(t("DocsViewerBody.message026"));
      const branchRes = await fetch(`${ROUTE}/git-branch?workspaceId=${encodeURIComponent(targetWorkspace.id)}`);
      if (!branchRes.ok) {
        console.error(t("DocsViewerBody.message027"), branchRes.status);
        return;
      }
      const branchData = await branchRes.json();
      console.log(t("DocsViewerBody.message028"), branchData);
      if (!branchData.branch) {
        console.error(t("DocsViewerBody.message029"));
        return;
      }

      // 6. 解析分支名（支持三种格式）
      const branch = branchData.branch;
      const parsed = parseBranchName(branch);
      console.log(t("DocsViewerBody.message030"), branch);
      console.log(t("DocsViewerBody.message031"), parsed);

      // parseBranchName 总是返回对象，需要检查 developer 和 date 是否存在
      const isValidBranch = parsed && parsed.developer && parsed.date;
      console.log(t("DocsViewerBody.message032"), isValidBranch);

      if (!isValidBranch) {
        // 分支名不符合规范 → 跳转到新建功能，默认勾选新建分支
        console.warn(t("DocsViewerBody.message033"), branch);
        if (targetWorkspace.id !== workspace.id) {
          // 等待工作区切换完成
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        setActivePanel('create');
        setInitialCreateBranch(true);
        showToast({
          tone: 'warning',
          text: t("DocsViewerBody.message034", { value0: branch }),
          holdMs: 5000,
        });
        return;
      }

      console.log(t("DocsViewerBody.message035"));

      const { developer, date, title, requirementId } = parsed;
      console.log(t("DocsViewerBody.message036"), developer, t("DocsViewerBody.message037"), date, t("DocsViewerBody.message038"), title, t("DocsViewerBody.message039"), requirementId);

      // 7. 获取目录树
      console.log(t("DocsViewerBody.message040"));
      const treeRes = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(targetWorkspace.id)}&t=${Date.now()}`);
      if (!treeRes.ok) {
        console.error(t("DocsViewerBody.message041"), treeRes.status);
        return;
      }
      const treeData = await treeRes.json();
      console.log(t("DocsViewerBody.message042"), treeData);

      // 7. 查找需求目录
      let existingReq = null;
      if (treeData.tree?.developers) {
        // 如果 developer 为 null（格式 3），在所有开发者中查找
        const devsToSearch = developer
          ? treeData.tree.developers.filter(dev => dev.name === developer)
          : treeData.tree.developers;

        for (const dev of devsToSearch) {
          console.log(t("DocsViewerBody.message043"), dev.name);
          for (const req of dev.requirements) {
            console.log(t("DocsViewerBody.message044"), req.id, 'vs', requirementId);
            if (req.id === requirementId) {
              existingReq = { ...req, developer: dev.name };
              console.log(t("DocsViewerBody.message045"), existingReq);
              break;
            }
          }
          if (existingReq) break;
        }
      }

      if (existingReq) {
        console.log(t("DocsViewerBody.message046"), existingReq);
        setSelectedReq(existingReq);
        setSelectedFile(null);
        // 保存到配置
        try {
          await fetch(`${ROUTE}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceId: targetWorkspace.id,
              developerName: existingReq.developer,
              requirementId: existingReq.id
            }),
          });
        } catch (e) {
          console.error(t("DocsViewerBody.message047"), e);
        }
        console.log(t("DocsViewerBody.message048"));
        return;
      }

      console.log(t("DocsViewerBody.message049"));
      // 8. 目录不存在，弹出确认弹窗
      setPendingCreateReq({ workspace: targetWorkspace, developer, date, title, requirementId });
      setShowCreateConfirm(true);
    } catch (e) {
      console.error(t("DocsViewerBody.message050"), e);
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
    { id: 'create', icon: h(IconPlus, { size: 18 }), label: t("DocsViewerBody.message051") },
    { id: 'writing', icon: h(IconEdit, { size: 18 }), label: t("DocsViewerBody.message056") },
    { id: 'knowledge', icon: h(IconBooks, { size: 18 }), label: t("DocsViewerBody.message054") },
    { id: 'sync', icon: h(IconSync, { size: 18 }), label: t("DocsViewerBody.message052") },
  ];
  const bottomButtons = [
    { id: 'log', icon: h(IconLog, { size: 18 }), label: t("DocsViewerBody.message057") },
    { id: 'settings', icon: h(IconSettings, { size: 18 }), label: t("DocsViewerBody.message058") },
  ];

  const renderDocumentPreview = () => {
    if (!selectedFile) return null;
    return h(FilePreview, {
        workspaceId: selectedFile.workspaceId || workspace.id,
        relPath: selectedFile.path,
        name: selectedFile.name,
        requirement: selectedFile.requirement || (selectedReq ? { title: selectedReq.title, date: selectedReq.date, type: selectedFile.type } : null),
        onBack: () => setSelectedFile(null),
        showToc,
        onToggleToc: () => setShowToc(!showToc),
        toolbarTarget: previewToolbarTarget,
        onSaved: () => { setFileRevision(value => value + 1); knowledge.refresh(); },
        onDirtyChange: setFileDirty,
        active: !activePanel || activePanel === 'knowledge' && knowledgeTab === 'documents',
      });
  };

  const renderPanel = () => {
    if (!activePanel) return null;
    if (activePanel === 'create') {
      return h(CreateDirForm, {
        workspaceId: workspace.id,
        docsDir,
        onClose: handlePanelClose,
        initialCreateBranch,
        onCreated: async (info) => {
          // 创建成功后：自动选中新需求、保存配置、刷新分支显示
          setInitialCreateBranch(false);
          // 等待 tree 刷新后选中新需求
          await new Promise(resolve => setTimeout(resolve, 500));
          const treeRes = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(workspace.id)}&t=${Date.now()}`);
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
    if (activePanel === 'knowledge') {
      return h(KnowledgePanel, { key: workspace.id, workspaceId: workspace.id, knowledge, tab: knowledgeTab, selectedFile, documentView: renderDocumentPreview() });
    }
    if (activePanel === 'sync') {
      return h(SyncPanel, {
        key: `${workspace.id}:${selectedReq?.id}:${focusedSync?.snapshotDir || ''}`,
        focusedSync: focusedSync?.requirementId === selectedReq?.id ? focusedSync : null,
        workspaceId: workspace.id, selectedReq,
        onClose: handlePanelClose,
      });
    }
    if (activePanel === 'log') {
      return h(LogPanel, { onClose: handlePanelClose });
    }
    if (activePanel === 'settings') {
      return h(SettingsPanel, { workspaceId: workspace.id, onClose: handlePanelClose });
    }
    return null;
  };

  // Right panel content
  const renderRightContent = () => {
    if (activePanel) {
      return renderPanel();
    }
    if (selectedFile) return renderDocumentPreview();
    // An existing requirement needs next-step guidance, not another creation prompt.
    if (selectedReq) return h(EmptyState, {
      title: t("DocsViewerBody.message059"),
      description: t("DocsViewerBody.message061", { value0: selectedReq.title || selectedReq.id, value1: hasSyncCommits ? t("DocsViewerBody.message060") : '' }),
      actions: [
        { label: t("DocsViewerBody.message062"), variant: 'primary', onClick: () => { setActivePanel('writing'); setShowFileTree(false); } },
        { label: t("DocsViewerBody.message063"), onClick: () => { setActivePanel('knowledge'); setShowFileTree(true); } },
        ...(hasSyncCommits ? [{ label: t("DocsViewerBody.message064"), onClick: () => { setActivePanel('sync'); setShowFileTree(false); } }] : []),
      ],
    });
    // No requirement selected yet: select an existing directory or create one.
    return h(EmptyState, {
      title: t("DocsViewerBody.message065"),
      description: t("DocsViewerBody.message066"),
      actions: [
        { label: t("DocsViewerBody.message067"), variant: 'primary', onClick: () => setShowReqDirModal(true) },
        { label: t("DocsViewerBody.message068"), onClick: () => { setActivePanel('create'); setShowFileTree(false); } },
      ],
    });
  };

  const rightHeaderTitle = activePanel
    ? (activePanel === 'create' ? t("DocsViewerBody.message069")
      : activePanel === 'knowledge' ? t("DocsViewerBody.message054")
      : activePanel === 'writing' ? t("DocsViewerBody.message056")
      : activePanel === 'sync' ? t("DocsViewerBody.message064")
      : activePanel === 'log' ? t("DocsViewerBody.message070")
      : activePanel === 'settings' ? t("DocsViewerBody.message058")
      : '')
    : '';

  // Build breadcrumb items for file preview (shown in header instead of FilePreview)
  const showingDocument = !!selectedFile && (!activePanel || activePanel === 'knowledge' && knowledgeTab === 'documents');
  const filePreviewBreadcrumb = showingDocument ? [
    { label: selectedFile.workspaceTitle || t("DocsViewerBody.message071"), onClick: () => setSelectedFile(null) },
    ...((selectedFile.requirement || selectedReq) ? [{ label: (selectedFile.requirement || selectedReq).title || t("DocsViewerBody.message072") }] : []),
    { label: selectedFile.name },
  ] : null;

  return h(DocsViewerContext.Provider, { value: contextValue },
    showingDocument && h(HeaderBack, {
      onBack: () => {
        const returnPanel = selectedFile.returnPanel;
        const returnKnowledgeTab = selectedFile.returnKnowledgeTab;
        setSelectedFile(null);
        if (returnPanel) setActivePanel(returnPanel);
        if (returnKnowledgeTab) changeKnowledgeTab(returnKnowledgeTab);
      },
    }),
    h('div', { className: 'rh-root' },
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

      h('div', { className: 'rh-three-zone', ref: threeZoneRef },
        // ── Left: Rail toolbar ──
        h('div', { className: 'rh-rail' },
          topButtons.map(btn => {
            // Group button with sub-buttons
            if (btn.group) {
              const isGroupExpanded = expandedGroup === btn.group;
              const isSubActive = btn.subButtons.some(sb => activePanel === sb.id);
              return h('div', { key: btn.id, className: 'rh-rail-group' },
                h('button', {
                  className: `rh-rail-btn${isSubActive ? ' active' : ''}${isGroupExpanded ? ' expanded' : ''}`,
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
                h('span', { className: 'rh-rail-arrow' }, isGroupExpanded ? '▾' : '▸')
                ),
                isGroupExpanded && h('div', { className: 'rh-rail-sub' },
                  btn.subButtons.map(sb =>
                    h('button', {
                      key: sb.id,
                      className: `rh-rail-sub-btn${activePanel === sb.id ? ' active' : ''}`,
                      onClick: () => setActivePanel(activePanel === sb.id ? null : sb.id),
                    },
                    h('span', null, sb.icon),
                    h('span', { className: 'rh-rail-label' }, sb.label)
                    )
                  )
                )
              );
            }
            // Regular button
            return h('button', {
              key: btn.id,
              className: `rh-rail-btn${activePanel === btn.id ? ' active' : ''}`,
              onClick: () => {
                setExpandedGroup(null);
                if (activePanel === btn.id) { setSelectedFile(null); setActivePanel(null); setShowFileTree(false); }
                else { setShowFileTree(btn.id === 'knowledge' && hasKnowledgeTree); setActivePanel(btn.id); }
              },
            },
              h('span', null, btn.icon),
              h('span', { className: 'rh-rail-label' }, btn.label)
            );
          }),
          h('div', { className: 'rh-rail-bottom' },
            bottomButtons.map(btn =>
              h('button', {
                key: btn.id,
                className: `rh-rail-btn${activePanel === btn.id ? ' active' : ''}`,
                onClick: () => {
                  setExpandedGroup(null);
                  // Toggle: if already active, close everything
                  if (activePanel === btn.id) {
                    setActivePanel(null);
                    setShowFileTree(false);
                  } else {
                    setShowFileTree(btn.id === 'knowledge');
                    setActivePanel(btn.id);
                  }
                },
              },
                h('span', null, btn.icon),
                h('span', { className: 'rh-rail-label' }, btn.label)
              )
            )
          )
        ),

        h('div', { className: css.workspace },
          activePanel === 'knowledge' && h(KnowledgeTabs, { tab: knowledgeTab, onTabChange: changeKnowledgeTab }),
          h('div', { className: css.workspaceBody },
        // ── File Tree Sidebar (only when view is active) ──
        activePanel === 'knowledge' && hasKnowledgeTree && h(FileTreeSidebar, {
          expanded: showFileTree,
          onExpandedChange: setShowFileTree,
          id: 'knowledge-file-tree',
          workspaceId: workspace.id,
          selectedReq,
          key: `${workspace.id}:${knowledgeTab}`,
          multiSelect: knowledgeTab === 'files',
          selectedPaths: knowledge.selected,
          onSelectionChange: knowledge.setSelected,
          onSelectFile: handleSelectFile,
        }),

        // ── Right: Trace / Operations / File Preview ──
        h('div', {
          className: ('rh-right-panel') + ' ' + css.content
        },
          h('div', { className: 'rh-right-header' },
            h('div', { className: 'rh-header-back-slot', ref: setHeaderBackTarget }),
            h('div', { className: 'rh-right-header-main' },
              filePreviewBreadcrumb
                ? h(Breadcrumb, { items: filePreviewBreadcrumb })
                : h('span', { className: 'rh-right-header-title' }, rightHeaderTitle || t("DocsViewerBody.message073")),
              filePreviewBreadcrumb && /\.(md|txt|text|html?|json|pdf|docx|xlsx)$/i.test(selectedFile.name) && h(FileKnowledgeAction, {
                key: `${selectedFile.workspaceId || workspace.id}:${selectedFile.path}`, workspaceId: selectedFile.workspaceId || workspace.id, path: selectedFile.path, revision: fileRevision, dirty: fileDirty, onChanged: knowledge.refresh }),
              filePreviewBreadcrumb && h('div', { className: 'rh-preview-actions', ref: setPreviewToolbarTarget }),
              activePanel === 'knowledge' && knowledgeTab === 'files' && h(Button, { className: 'rh-btn rh-btn-primary',
                disabled: !knowledge.selected.length || knowledge.running,
                onClick: () => knowledge.start(),
              }, knowledge.running ? t('knowledgeLayout.importing') : t('knowledgeLayout.importMany', { count: knowledge.selected.length }))
            ),
            (activePanel || selectedFile) && h(Button, { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm rh-right-close', onClick: handlePanelClose, 'aria-label': t("DocsViewerBody.message076") }, t("common.close"))
          ),
          // Skip rh-right-body wrapper for file preview to avoid extra layer
          h('div', { key: 'knowledge-search', className: css.size, style: { "--rh-display-0": cssValue(isKnowledgeSearch ? 'flex' : 'none') }, id: isKnowledgeSearch ? 'knowledge-content' : undefined, role: isKnowledgeSearch ? 'tabpanel' : undefined, 'aria-labelledby': isKnowledgeSearch ? 'knowledge-tab-search' : undefined },
            h(SearchPanel, { active: isKnowledgeSearch,
              onOpenKnowledge: () => { setKnowledgeTab('files'); setActivePanel('knowledge'); setShowFileTree(true); },
              onOpenSource: source => {
                const parts = source.relativePath.split('/');
                const requirement = { id: parts[1], path: parts.slice(0, 2).join('/'), developer: parts[0], title: parts[1].slice(11), date: parts[1].slice(0, 10) };
                const local = !source.workspaceId || source.workspaceId === workspace.id;
                if (local) setSelectedReq(requirement);
                setSelectedFile({ path: source.relativePath, name: parts.at(-1), workspaceId: source.workspaceId, workspaceTitle: source.workspaceTitle, requirement, returnPanel: 'knowledge', returnKnowledgeTab: 'search' });
                setKnowledgeTab('documents'); setActivePanel('knowledge'); setShowFileTree(local);
              } })),
          writingMounted.current && h('div', { key: `writing:${workspace.id}`, className: css.size, style: { "--rh-display-0": cssValue(activePanel === 'writing' ? 'flex' : 'none') } }, h(WritingPanel, { workspaceId: workspace.id })),
          activePanel !== 'writing' && (selectedFile && !activePanel
            ? renderRightContent()
            : h('div', { className: `rh-right-body${isKnowledgeSearch ? ' ' + css.inactive : ''}` }, renderRightContent()))
        )))
      ),

      // ── Status bar (4.24) ──
      h('div', { className: 'rh-statusbar' },
        h('span', null, t("common.versionLabel")),
        h(SyncStatusBar, { monitor: syncMonitor, onOpen: task => { selectionRevision.current++; pendingSyncNavigation.current = task; setFocusedSync(task); } }),
        h('span', null,
          t("shell.docsPath", { value0: docsDir }),
          h('span', { className: css.heading }, t("shell.requirementCount", { value0: totalReqs }))
        )
      ),

      // ── Workspace modal ──
      showWorkspaceModal && h(WorkspaceModal, {
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
                requirementId: null
              }),
            });
            onConfigChange();
          } catch { /* ignore */ }
        },
        onClose: () => setShowWorkspaceModal(false),
      }),

      // ── Requirement directory modal ──
      showReqDirModal && h(RequirementDirModal, {
        workspaceId: workspace.id,
        selectedReqId: selectedReq?.id || null,
        onSelect: handleSelectReq,
        onClose: () => setShowReqDirModal(false),
      }),

      // ─ Create requirement confirm modal (使用全局 showConfirm) ──
      // 注意：showCreateConfirm 状态仍保留用于兼容，新流程直接调用 showConfirm()
      showCreateConfirm && pendingCreateReq && h(ConfirmModal, {
        title: t("DocsViewerBody.message069"),
        message: t("DocsViewerBody.message077", { value0: pendingCreateReq.developer, value1: pendingCreateReq.requirementId }),
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

      h(ConfirmDialogContainer, null)
    )
  );
}

module.exports = { DocsViewerBody };
