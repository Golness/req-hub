'use strict';
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
const { SyncVersionCompare } = require('./shared/SyncVersionCompare.js');
const { DeleteSyncTaskButton } = require('./shared/DeleteSyncTaskButton.js');
const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');
const { FilePreview } = require('./FilePreview.js');
const { showToast } = require('./shared/ToastContainer.js');
const { ConversationSources } = require('./ConversationSources.js');
const { ConversationManager } = require('./ConversationManager.js');
const { createIconComponents } = require('../icons.js');

const { IconSync, IconError, IconCheck, IconSkip, IconCancel, IconHourglass, IconChevronDown } = createIconComponents(h);

// ─── SyncPanel ───────────────────────────────────────────────────
// Sync requirement or design docs with code changes from git branch
// Default to phased sync with two buttons: "同步需求文档" and "同步技术方案"
/**
 * @component
 * Main sync panel for synchronizing requirement or design documentation with code changes
 * from a git branch. Provides two sync modes: requirement docs and design docs.
 * Supports viewing sync history, sync details, and managing active sync operations.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The workspace ID for sync operations
 * @param {Object|null} props.selectedReq - The currently selected requirement object, or null if none selected
 * @param {Function} props.onClose - Callback invoked to close the panel
 * @returns {JSX.Element}
 */
function SyncPanel({ workspaceId, selectedReq, onClose, focusedSync }) {
  const [syncDocType, setSyncDocType] = useState(focusedSync && syncTaskModel.isSyncActive(focusedSync) ? focusedSync.docType : null);
  const [syncing, setSyncing] = useState(false);
  const [view, setView] = useState(focusedSync && !syncTaskModel.isSyncActive(focusedSync) ? 'detail' : 'main');
  const [selectedHistorySync, setSelectedHistorySync] = useState(focusedSync || null);
  const { refreshTree, syncActivity } = React.useContext(DocsViewerContext);
  useEffect(() => {
    const removed = event => {
      const task = event.detail;
      if (task.workspaceId !== workspaceId || task.requirementId !== selectedReq?.id) return;
      if (syncDocType || selectedHistorySync?.snapshotDir === task.snapshotDir) {
        setSyncDocType(null); setSyncing(false); setSelectedHistorySync(null); setView('main');
      }
    };
    window.addEventListener('req-hub-sync-deleted', removed);
    return () => window.removeEventListener('req-hub-sync-deleted', removed);
  }, [workspaceId, selectedReq?.id, syncDocType, selectedHistorySync]);
  useEffect(() => {
    if (!focusedSync) return;
    const active = syncTaskModel.isSyncActive(focusedSync);
    setSelectedHistorySync(focusedSync); setView(active ? 'main' : 'detail');
    setSyncDocType(active ? focusedSync.docType : null); setSyncing(active);
  }, [focusedSync]);

  // Check for active sync on mount — if a running sync exists, skip directly to progress view
  useEffect(() => {
    if (!selectedReq?.id || !workspaceId) return;
    fetch(`${ROUTE}/sync-active?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && data.active && data.sync && syncTaskModel.isSyncActive(data.sync)) {
          setSyncDocType(data.sync.docType);
          setSyncing(true);
        }
      })
      .catch(() => {});
  }, [workspaceId, selectedReq?.id]);

  if (!selectedReq) {
    return h('div', { className: 'rh-op-panel' },
      h('div', { className: css.spacing },
        t("SyncPanel.message001")),
      h(Button, { className: 'rh-btn', onClick: onClose }, t("common.close"))
    );
  }

  // View sync history
  if (view === 'history') {
    return h(SyncHistoryView, {
      workspaceId,
      requirementId: selectedReq.id,
      onBack: () => {
        setView('main');
        setSelectedHistorySync(null);
      },
      onSelectSync: (sync) => {
        setSelectedHistorySync(sync);
        setView('detail');
      },
    });
  }

  // View sync detail
  if (view === 'detail' && selectedHistorySync) {
    return h(SyncDetailView, {
      sync: selectedHistorySync,
      workspaceId,
      requirementPath: selectedReq.path,
      onBack: () => {
        setView('history');
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
      refreshTree
    });
  }

  // Main view - Aligned with AnalyzePanel style
  return h('div', { className: 'rh-op-panel' },
    syncActivity && h('p', { className: 'rh-sync-hint', role: 'status' }, t("SyncPanel.message002")),
    // Requirement card (same as AnalyzePanel)
    selectedReq && h('div', { className: 'rh-req-card' },
      h('div', { className: 'rh-req-card-title' }, selectedReq.title),
      h('div', { className: 'rh-req-card-row' }, t("AnalyzePanel.message014"), selectedReq.developer),
      h('div', { className: 'rh-req-card-row' }, t("AnalyzePanel.message015"), selectedReq.date),
      h('div', { className: 'rh-req-card-row' }, t("AnalyzePanel.message016"), selectedReq.fileCount)
    ),

    // Sync type buttons
    h('div', { className: ('rh-btn-stack') + ' ' + css.spacing2 },
      h(Button, {
        className: 'rh-btn',
        disabled: !!syncActivity,
        onClick: () => setSyncDocType('requirement'),
      }, t("SyncPanel.message003")),
      h(Button, {
        className: 'rh-btn',
        disabled: !!syncActivity,
        onClick: () => setSyncDocType('design'),
      }, t("SyncPanel.message004"))
    ),

    // History button
    h('div', { className: 'rh-btn-stack' },
      h(Button, {
        className: 'rh-btn',
        onClick: () => setView('history'),
      }, t("SyncPanel.message005"))
    )
  );
}

// ─── SessionTurnsView - 会话轮次内容查看器（二级页面）─────────────
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
      const res = await fetch(`${ROUTE}/session-turns?${new URLSearchParams({ workspaceId, sessionId, version: snapshotVersion })}`);
      const data = await res.json();
      if (res.ok) {
        if (data.success) {
          setTurnsData(data);
        } else {
          setError(data.error || t("AnalyzePanel.message001"));
        }
      } else {
        setError(data.error || t("AnalyzePanel.message001"));
      }
    } catch (e) {
      console.error('Failed to load session turns:', e);
      setError(e.message || t("AnalyzePanel.message001"));
    } finally {
      setLoading(false);
    }
  };

  const toggleTurn = (turnNumber) => {
    setExpandedTurns(prev => {
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
      setExpandedTurns(new Set(turnsData.turns.map(t => t.turnNumber)));
    }
  };

  const collapseAll = () => {
    setExpandedTurns(new Set());
  };

  if (loading) {
    return h('div', { className: css.centered },
      h(HeaderBack, { onBack }),
      h('div', { className: css.mutedText }, t("common.loading"))
    );
  }

  if (error) {
    return h('div', { className: css.section },
      h(HeaderBack, { onBack }),
      h('div', { className: css.row }, h(IconError, { size: 14 }), error)
    );
  }

  if (!turnsData || !turnsData.turns || turnsData.turns.length === 0) {
    return h('div', { className: css.section },
      h(HeaderBack, { onBack: onBack, label: t("common.back") }),
      h('div', { className: css.mutedText2 },
        t("SyncPanel.message006"))
    );
  }

  return h('div', { className: css.column },
    // Header
    h('div', { className: css.section2},
      h('div', { className: css.row2},
        h(HeaderBack, { onBack: onBack, label: t("common.back") }),
        h('span', { className: css.heading }, sessionTitle || t("SyncPanel.message007"))
      ),
      h('div', { className: css.row3},
        h('span', null, t("SyncPanel.message008", { value0: turnsData.turnCount || turnsData.turns?.length || 0 })),
        h('span', null, `•`),
        h('span', null, t("SyncPanel.message009", { value0: ((turnsData.totalTokens || 0) / 1000).toFixed(1) })),
        h('span', { className: css.spacing3},
          expandedTurns.size === turnsData.turnCount
            ? h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: collapseAll}, t("SyncPanel.message010"))
            : h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: expandAll}, t("SyncPanel.message011"))
        )
      )
    ),

    // Turns list
    h('div', { className: css.pane},
      turnsData.turns.map((turn, idx) => {
        const isExpanded = expandedTurns.has(turn.turnNumber);
        const time = turn.time ? new Date(turn.time).toLocaleString() : '';
        const userInput = turn.messages?.find(message => message.role === 'user')?.text || '';

        return h('div', {
          key: idx,
          className: css.pane2
        },
          // Turn header
          h('div', {
            onClick: () => toggleTurn(turn.turnNumber),
            className: css.row4, style: { "--rh-background-1": cssValue(isExpanded ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)') }
          },
            h('span', { className: css.heading2}, t("SyncPanel.message012", { value0: turn.turnNumber })),
            h('span', { className: css.pane3}, userInput.substring(0, 100)),
            !turn.syncable && h('span', { className: css.mutedText3 }, t("SyncPanel.message013")),
            h('span', { className: css.mutedText4}, time),
            h('span', { className: css.mutedText5, style: { "--rh-transform-2": cssValue(isExpanded ? 'rotate(180deg)' : 'rotate(0deg)') }}, h(IconChevronDown, { size: 12 }))
          ),

          // Turn content (expanded)
          isExpanded && h('div', { className: css.section3},
            (turn.messages || []).map((message, messageIndex) => h('div', {
              key: messageIndex, className: css.spacing2,
            },
              h('div', { className: css.heading3 }, message.label),
              h('div', { className: css.section4, style: { "--rh-border-left-7": cssValue('3px solid ' + (message.kind === 'final' ? 'var(--dsw-alias-state-success-primary)' : 'var(--rh-accent)')) } }, message.text)
            ))
          )
        );
      })
    )
  );
}

// ─── SyncStepList - Reusable step progress display ──────────────
// Used by both active sync view and history detail view
/**
 * @component
 * Reusable component that displays a list of sync steps with their status,
 * progress indicators, generated files, processing chunks, and execution logs.
 * Each step can be expanded to show detailed information.
 * @param {Object} props - Component props
 * @param {Array<Object>} props.steps - List of step objects with phase, label, status, text, files, chunks, and log properties
 * @param {Array<Object>} [props.generatedFiles] - List of generated file objects with phase and fileName properties
 * @param {string} props.workspaceId - The workspace ID
 * @param {string} props.requirementId - The requirement ID
 * @param {Function} props.onViewFile - Callback invoked when a generated file link is clicked
 * @returns {JSX.Element}
 */
function SyncStepList({ steps, generatedFiles, workspaceId, requirementId, onViewFile }) {
  const [expandedSteps, setExpandedSteps] = useState({});
  const [expandedChunks, setExpandedChunks] = useState({});

  const toggleStep = (phase) => {
    setExpandedSteps(prev => ({
      ...prev,
      [phase]: !prev[phase]
    }));
  };

  const toggleChunks = (phase) => {
    setExpandedChunks(prev => ({
      ...prev,
      [phase]: !prev[phase]
    }));
  };

  const getStepIcon = (status) => {
    switch (status) {
      case 'completed': return h('span', { className: css.row5 }, h(IconCheck, { size: 16 }));
      case 'running': return h('span', { className: ('rh-spinner') + ' ' + css.size });
      case 'failed': return h('span', { className: css.row6 }, h(IconError, { size: 16 }));
      case 'skipped': return h('span', { className: css.row7 }, h(IconSkip, { size: 16 }));
      default: return h('span', { className: css.row7 }, h(IconHourglass, { size: 16 }));
    }
  };

  const getStepColor = (status) => {
    switch (status) {
      case 'completed': return 'var(--dsw-alias-state-success-primary)';
      case 'running': return 'var(--rh-accent)';
      case 'failed': return 'var(--dsw-alias-state-error-primary)';
      case 'skipped': return 'var(--dsw-alias-label-secondary)';
      default: return 'var(--dsw-alias-label-secondary)';
    }
  };

  // 格式化 token 数
  const formatTokens = (tokens) => {
    if (!tokens) return '0';
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return tokens.toString();
  };

  // Group files by phase
  const filesByPhase = {};
  if (generatedFiles) {
    for (const f of generatedFiles) {
      if (!filesByPhase[f.phase]) filesByPhase[f.phase] = [];
      filesByPhase[f.phase].push(f.fileName);
    }
  }
  // Also include files from step definition
  if (steps) {
    for (const step of steps) {
      if (step.files && step.files.length > 0) {
        if (!filesByPhase[step.phase]) filesByPhase[step.phase] = [];
        for (const f of step.files) {
          if (!filesByPhase[step.phase].includes(f)) {
            filesByPhase[step.phase].push(f);
          }
        }
      }
    }
  }

  return h('div', { className: css.column2},
    (steps || []).map((step, idx) => {
      const phaseFiles = filesByPhase[step.phase] || [];
      const hasChunks = step.chunks && step.chunks.length > 0;
      const isChunksExpanded = expandedChunks[step.phase];
      const isStepExpanded = expandedSteps[step.phase];

      return h('div', {
        key: idx,
        className: ('rh-sync-step') + ' ' + css.content,
        style: { "--rh-background-0": cssValue(step.status === 'running' ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)'), "--rh-border-1": cssValue(step.status === 'running' ? '1px solid var(--rh-accent)' : '1px solid var(--dsw-alias-border-l1)') }
      },
        // Step header (clickable to expand)
        h('div', {
          className: 'rh-sync-step-header',
          onClick: () => toggleStep(step.phase),
        },
          getStepIcon(step.status),
          h('span', { className: ('rh-sync-step-label') + ' ' + css.content2}, step.label),
          // Liveness indicator
          step.status === 'running' && step.livenessStage && h('span', {
            className: css.row8, style: { "--rh-color-1": cssValue(step.livenessStage === 'liveness_stale' ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-state-success-primary)') }
          }, step.livenessStage === 'liveness_stale' ? t("SyncPanel.message014") : t("SyncPanel.message015"), ` ${step.lastActivityDesc || ''}`),
          // 分块次数标签
          hasChunks && h('span', {
            onClick: (e) => { e.stopPropagation(); toggleChunks(step.phase); },
            className: css.section5
          }, t("SyncPanel.message016", { value0: step.chunks.length })),
          // Token 数标签
          step.totalTokens && h('span', {
            className: css.mutedText6
          }, `${formatTokens(step.totalTokens)} tokens`),
          // Expand arrow
          h('span', { className: `rh-sync-step-arrow${isStepExpanded ? ' expanded' : ''}` }, '▾')
        ),
        // Step text (always visible)
        step.text && h('div', {
          className: css.mutedText7
        }, step.text),

        // Expanded detail section
        isStepExpanded && h('div', { className: 'rh-sync-step-detail' },
          // Files section
          phaseFiles.length > 0 && h('div', { className: 'rh-sync-step-files' },
            h('div', { className: css.heading4 }, t("SyncPanel.message017")),
            phaseFiles.map((fileName, fi) =>
              h('a', {
                key: fi,
                className: 'rh-sync-step-file-link',
                href: '#',
                onClick: (e) => { e.preventDefault(); onViewFile && onViewFile(fileName); },
              }, fileName)
            )
          ),

          // Chunks 详情（可展开）
          hasChunks && h('div', { className: css.spacing4 },
            h('div', {
              className: css.heading5,
              onClick: () => toggleChunks(step.phase)
            }, t("SyncPanel.message018", { value0: step.chunks.length, value1: isChunksExpanded ? '▾' : '▸' })),

            isChunksExpanded && h('div', { className: css.column3 },
              // 分块总览
              h('div', { className: css.mutedText8}, t("SyncPanel.message019", { value0: step.chunks.length, value1: formatTokens(step.totalTokens) })),

              // 每块详情
              step.chunks.map((chunk, ci) =>
                h('div', {
                  key: ci,
                  className: css.section6, style: { "--rh-border-left-4": cssValue(chunk.status === 'running' ? '2px solid var(--rh-accent)'
                      : chunk.status === 'failed' ? '2px solid var(--dsw-alias-state-error-primary)'
                      : chunk.status === 'aborted' ? '2px solid var(--dsw-alias-state-warning-primary)'
                      : chunk.status === 'completed' ? '2px solid var(--dsw-alias-state-success-primary)'
                      : '2px solid transparent') }
                },
                  // 块头部：状态图标 + 块号 + 状态文字 + token 数
                  h('div', { className: css.row9, style: { "--rh-margin-bottom-3": cssValue(chunk.sessionId ? 3 : 4) }},
                    // 状态图标
                    chunk.status === 'queued' && h(IconHourglass, { size: 12, color: 'var(--dsw-alias-label-secondary)' }),
                    chunk.status === 'running' && h(IconSync, { size: 12, color: 'var(--rh-accent)', className: 'rh-spin' }),
                    chunk.status === 'completed' && h(IconCheck, { size: 12, color: 'var(--dsw-alias-state-success-primary)' }),
                    chunk.status === 'failed' && h(IconError, { size: 12, color: 'var(--dsw-alias-state-error-primary)' }),
                    chunk.status === 'aborted' && h(IconCancel, { size: 12, color: 'var(--dsw-alias-state-warning-primary)' }),
                    // 块号 + 状态文字
                    h('span', { className: css.heading6},
                      t("SyncPanel.message020", { value0: ci + 1 }),
                      chunk.status && chunk.status !== 'completed'
                        ? h('span', { className: css.heading7, style: { "--rh-color-1": cssValue(chunk.status === 'running' ? 'var(--rh-accent)'
                            : chunk.status === 'failed' ? 'var(--dsw-alias-state-error-primary)'
                            : chunk.status === 'aborted' ? 'var(--dsw-alias-state-warning-primary)'
                            : 'var(--dsw-alias-label-secondary)') },
                          }, chunk.status === 'queued' ? t("KnowledgePanel.message010")
                            : chunk.status === 'running' ? t("SyncPanel.message021")
                            : chunk.status === 'failed' ? t("KnowledgePanel.message005")
                            : chunk.status === 'aborted' ? t("SyncPanel.message022")
                            : '')
                        : null
                    ),
                    // token 数
                    h('span', { className: css.mutedText9}, `${formatTokens(chunk.tokens)} tokens`),
                  ),
                  // sessionId（紧凑展示）
                  chunk.sessionId && h('div', {
                    className: css.spacing5,
                    title: `Subagent Session: ${chunk.sessionId}`,
                  }, t("SyncPanel.message023", { value0: chunk.sessionId.slice(0, 20) })),
                  // 错误信息
                  chunk.status === 'failed' && chunk.error && h('div', {
                    className: css.spacing6,
                  }, chunk.error),
                  // 文件列表
                  chunk.files && h('div', { className: css.row10},
                    chunk.files.slice(0, 5).map((f, fi) =>
                      h('span', {
                        key: fi,
                        className: css.section7
                      }, f.file || f)
                    ),
                    chunk.files.length > 5 && h('span', {
                      className: css.mutedText3
                    }, t("SyncPanel.message024", { value0: chunk.files.length - 5 }))
                  ),
                  // 消息列表
                  chunk.messages && h('div', { className: css.column4},
                    chunk.messages.slice(0, 3).map((m, mi) =>
                      h('div', {
                        key: mi,
                        className: css.content3, style: { "--rh-color-0": cssValue(m.role === 'user' ? 'var(--dsw-alias-state-info-primary)' : 'var(--rh-accent)') }
                      }, h('span', { className: css.row11 }, m.role === 'user' ? t("SyncPanel.message025") : t("SyncPanel.message026"), ` ${m.preview?.substring(0, 30) || ''}...`))
                    ),
                    chunk.messages.length > 3 && h('span', {
                      className: css.mutedText3
                    }, t("SyncPanel.message027", { value0: chunk.messages.length - 3 }))
                  )
                )
              )
            )
          ),

          // Log section (if available)
          step.log && h('div', { className: css.spacing4 },
            h('div', { className: css.heading4 }, t("SyncPanel.message028")),
            h('pre', { className: 'rh-sync-step-log' }, step.log)
          )
        )
      );
    })
  );
}

// ─── SyncProgressView - Active sync progress display ────────────
/**
 * @component
 * Displays the progress of an active sync operation including a progress bar,
 * step list, estimated remaining time, and an abort button with confirmation dialog.
 * @param {Object} props - Component props
 * @param {Object} props.sync - The sync operation object with status, steps, and metadata
 * @param {Function} props.onBack - Callback invoked to return to the previous view
 * @param {Function} props.onViewFile - Callback invoked when a generated file is clicked
 * @param {string} props.workspaceId - The workspace ID
 * @param {string} props.requirementId - The requirement ID
 * @param {Function} [props.onSyncAborted] - Callback invoked after a sync is successfully aborted
 * @returns {JSX.Element}
 */
function SyncProgressView({ sync, onBack, onViewFile, workspaceId, requirementId, onSyncAborted }) {
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const [aborting, setAborting] = useState(false);

  // Calculate progress — skipped steps are excluded from the count
  const allSteps = sync.steps || [];
  const skippedSteps = allSteps.filter(s => s.status === 'skipped');
  const activeSteps = allSteps.filter(s => s.status !== 'skipped');
  const totalSteps = activeSteps.length;
  const completedSteps = activeSteps.filter(s => s.status === 'completed').length;
  const failedSteps = activeSteps.filter(s => s.status === 'failed').length;
  const runningSteps = activeSteps.filter(s => s.status === 'running').length;
  const progress = totalSteps > 0 ? Math.round(((completedSteps + failedSteps) / totalSteps) * 100) : 0;

  // Estimate remaining time (rough: 2 min per remaining step)
  const remainingSteps = totalSteps - completedSteps - failedSteps;
  const etaMinutes = Math.ceil(remainingSteps * 2);

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
        showToast({ tone: 'warning', text: data.status === 'cancelling' ? t("SyncPanel.message029") : t("SyncPanel.message030"), holdMs: 3000 });
        onSyncAborted?.();
      } else {
        showToast({ tone: 'error', text: data.error || t("SyncPanel.message031"), holdMs: 3000 });
      }
    } catch (e) {
      showToast({ tone: 'error', text: t("SyncPanel.message032") + e.message, holdMs: 3000 });
    } finally {
      setAborting(false);
    }
  };

  return h('div', { className: css.column},
    // Header
    h('div', { className: css.section2},
      h('div', { className: css.row12},
        h(HeaderBack, { onBack }),
        h('span', { className: css.row13 },
          syncTaskModel.isSyncActive(sync)
            ? h('span', { className: css.row11 }, h(IconSync, { size: 14 }), sync.status === 'cancelling' ? t("SyncPanel.message033") : t("SyncPanel.message034"))
            : sync.status === 'completed'
              ? h('span', { className: css.row11 }, h(IconCheck, { size: 14 }), t("SyncPanel.message035"))
              : sync.status === 'aborted'
                ? h('span', { className: css.row14 }, h(IconCancel, { size: 14 }), t("SyncPanel.message036"))
                : h('span', { className: css.row11 }, h(IconError, { size: 14 }), t("SyncPanel.message037"))
        ),
        h(DeleteSyncTaskButton, { task: { ...sync, workspaceId, requirementId }, onDeleted: onBack }),
      ),
      h('div', { className: css.row15},
        h('span', null, t("AnalyzePanel.message006"), sync.docTypeName),
        h('span', null, t("SyncPanel.message038"), new Date(sync.startedAt).toLocaleString()),
        sync.completedAt && h('span', null, t("SyncPanel.message039"), new Date(sync.completedAt).toLocaleString()),
        sync.abortedAt && h('span', null, t("SyncPanel.message040"), new Date(sync.abortedAt).toLocaleString()),
      ),
      // Progress bar
      h('div', { className: ('rh-sync-progress') + ' ' + css.section8 },
        h('div', { className: 'rh-sync-progress-header' },
          h('span', null, t("SyncPanel.message041", { value0: completedSteps, value1: totalSteps })),
          h('span', { className: 'rh-sync-progress-percent' }, `${progress}%`)
        ),
        h('div', { className: 'rh-sync-progress-bar' },
          h('div', {
            className: ('rh-sync-progress-fill') + ' ' + css.size2,
            style: { "--rh-width-0": cssValue(`${progress}%`), "--rh-background-1": cssValue(sync.status === 'aborted' ? 'var(--dsw-alias-state-warning-primary)' : undefined) },
            role: 'progressbar',
            'aria-valuenow': progress,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          })
        ),
        sync.status === 'running' && remainingSteps > 0 && h('div', { className: 'rh-sync-progress-eta' },
          t("SyncPanel.message042", { value0: etaMinutes })
        )
      )
    ),
    // Steps
    h('div', { className: css.pane},
      sync.error && h('div', { className: 'rh-knowledge-error', role: 'alert' }, sync.error),
      ['failed', 'aborted'].includes(sync.status) && sync.publishState === 'state_committed' && h('div', { className: 'rh-op-info' }, t("SyncPanel.message043")),
      h(SyncStepList, {
        steps: sync.steps,
        generatedFiles: sync.generatedFiles,
        workspaceId: sync.workspaceId,
        requirementId: sync.requirementId,
        onViewFile: onViewFile,
      })
    ),
    // Abort button — only shown when sync is running
    sync.status === 'running' && h('div', {
      className: css.section9
    },
      h(Button, {
        className: ('rh-btn rh-btn-danger-outline') + ' ' + css.size3,
        onClick: () => setShowAbortConfirm(true),
      }, t("SyncPanel.message044"))
    ),
    // Abort confirmation dialog
    showAbortConfirm && h(ModalFrame, {
      className: 'rh-confirm-overlay',
      onClick: () => !aborting && setShowAbortConfirm(false),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t("SyncPanel.message045"),
    },
      h('div', {
        className: 'rh-confirm-dialog',
        onClick: e => e.stopPropagation(),
      },
        h('div', { className: 'rh-confirm-header' },

          h('h3', { className: 'rh-confirm-title' }, t("SyncPanel.message046")),
        ),
        h('div', { className: 'rh-confirm-body' },
          h('p', { className: 'rh-confirm-message' },
            t("SyncPanel.message047")),
        ),
        h('div', { className: 'rh-confirm-footer' },
          h(Button, {
            className: 'rh-btn',
            onClick: () => setShowAbortConfirm(false),
            disabled: aborting,
          }, t("common.cancel")),
          h(Button, {
            className: 'rh-btn rh-btn-danger',
            onClick: handleAbort,
            disabled: aborting,
          }, aborting ? t("SyncPanel.message048") : t("SyncPanel.message049")),
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
 * @param {Function} props.onBack - Callback invoked to return to the previous view
 * @param {Function} props.onSelectSync - Callback invoked when a sync history entry is clicked
 * @param {string} props.workspaceId - The workspace ID
 * @param {string} props.requirementId - The requirement ID
 * @returns {JSX.Element}
 */
function SyncHistoryView({ onBack, onSelectSync, workspaceId, requirementId }) {
  const [history, setHistory] = useState([]);
  const [historyDocType, setHistoryDocType] = useState('requirement');
  const visibleHistory = history.filter(sync => sync.docType === historyDocType);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${ROUTE}/sync-history?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(requirementId)}`)
      .then(res => res.ok ? res.json() : { history: [] })
      .then(data => setHistory(data.history || []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [workspaceId, requirementId]);

  return h('div', { className: css.column},
    // Header
    h('div', { className: css.section2},
      h('div', { className: css.row16},
        h(HeaderBack, { onBack }),
        h('span', { className: css.heading }, t("SyncPanel.message005"))
      )
    ),
    // List
    h('div', { className: css.pane},
      !loading && history.length > 0 && h(SyncVersionCompare, { history, workspaceId, requirementId, docType: historyDocType, onDocTypeChange: setHistoryDocType }),
      loading
        ? h('div', { className: css.mutedText10}, t("common.loading"))
        : visibleHistory.length === 0
          ? h('div', { role: 'status', className: css.mutedText11}, t("SyncPanel.message050", { value0: historyDocType === 'design' ? t("DocumentDropdown.message005") : t("DocsViewerBody.message073") }))
          : h('div', { className: css.column5},
              visibleHistory.map(sync =>
                h('div', {
                  key: sync.id,
                  onClick: () => onSelectSync(sync),
                  className: css.section10
                },
                  h('div', { className: css.row17},
                    h('span', { className: css.row18},
                      sync.status === 'completed' ? h(IconCheck, { size: 16, color: 'var(--dsw-alias-state-success-primary)' })
                        : sync.status === 'failed' ? h(IconError, { size: 16, color: 'var(--dsw-alias-state-error-primary)' })
                        : sync.status === 'aborted' ? h(IconCancel, { size: 16, color: 'var(--dsw-alias-state-warning-primary)' })
                        : h(IconSync, { size: 16, color: 'var(--rh-accent)' })
                    ),
                    h('span', { className: css.heading}, sync.docTypeName),
                    h('span', { className: css.mutedText12},
                      new Date(sync.startedAt).toLocaleString()
                    ),
                    h(DeleteSyncTaskButton, { task: { ...sync, workspaceId, requirementId }, onDeleted: task => setHistory(previous => previous.filter(item => item.snapshotDir !== task.snapshotDir || item.id !== task.id)) })
                  ),
                  h('div', { className: css.row19},
                    h('span', null, (() => {
                      const active = (sync.steps || []).filter(s => s.status !== 'skipped');
                      const done = active.filter(s => s.status === 'completed').length;
                      return t("SyncPanel.message051", { value0: done, value1: active.length });
                    })()),
                    sync.generatedFiles && sync.generatedFiles.length > 0 && h('span', null, t("SyncPanel.message052", { value0: sync.generatedFiles.length })),
                    sync.stats && h('span', null, t("SyncPanel.message053", { value0: sync.stats.totalLLMCalls || 0 })),
                  )
                )
              )
            )
    )
  );
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
function SyncDetailView({ sync, onBack, workspaceId, requirementPath }) {
  const [viewingFile, setViewingFile] = useState(null);

  if (viewingFile) {
    return h('div', { className: css.column},
      h('div', { className: css.section2},
        h('div', { className: css.row16},
          h(HeaderBack, { onBack: () => setViewingFile(null), label: t("common.back") }),
          h('span', { className: css.row20 }, ' ', viewingFile.split('/').pop())
        )
      ),
      h('div', { className: css.pane4},
        h(FilePreview, {
          workspaceId,
          relPath: `${requirementPath}/${viewingFile}`,
          name: viewingFile.split('/').pop(),
          requirement: null,
        })
      )
    );
  }

  return h(SyncProgressView, {
    sync,
    workspaceId: sync.workspaceId,
    requirementId: sync.requirementId,
    onBack,
    onViewFile: (fileName) => setViewingFile(fileName),
    onSyncAborted: () => {
      // Reload to refresh history
      window.location.reload();
    },
  });
}

// ─── PhasedSyncUI - Main sync UI with session selector ──────────
/**
 * @component
 * Main phased sync UI that provides session selection, branch info display,
 * and multi-phase sync execution with real-time progress tracking via SSE.
 * Supports viewing sync progress, history, detail, and generated files across
 * multiple views.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The workspace ID
 * @param {Object} props.selectedReq - The selected requirement object
 * @param {string} props.activeTab - The active document type ('requirement' or 'design')
 * @param {boolean} props.syncing - Whether a sync is currently in progress
 * @param {Function} props.setSyncing - State setter for the syncing flag
 * @param {Function} props.onClose - Callback invoked to close the panel
 * @param {Function} props.refreshTree - Callback to refresh the document tree after sync
 * @returns {JSX.Element}
 */
function PhasedSyncUI({ workspaceId, selectedReq, activeTab, syncing, setSyncing, onClose, refreshTree }) {
  const { syncActivity } = React.useContext(DocsViewerContext);
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [codexSelection, setCodexSelection] = useState({ ids: [], versions: {} });
  const selectedSessionIds = [...selectedSessions, ...codexSelection.ids];
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState(null);
  const [viewingSession, setViewingSession] = useState(null);
  const [managingConversations, setManagingConversations] = useState(false);
  const [conversationRevision, setConversationRevision] = useState(0);
  const selectedSessionVersions = useRef({});
  const sessionVersions = () => ({ ...selectedSessionVersions.current, ...codexSelection.versions });
  useEffect(() => { setSelectedSessions([]); selectedSessionVersions.current = {}; setCodexSelection({ ids: [], versions: {} }); }, [workspaceId]);
  const pollRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => clearInterval(pollRef.current), []);
  const [view, setView] = useState('select'); // 'select' | 'progress' | 'history' | 'detail' | 'file'
  const [currentSync, setCurrentSync] = useState(null);
  const [selectedHistorySync, setSelectedHistorySync] = useState(null);
  const [viewingFile, setViewingFile] = useState(null);
  const [branchInfo, setBranchInfo] = useState({ targetBranch: null, baseBranch: null });
  const [baseBranch, setBaseBranch] = useState('');
  const baseBranchEdited = React.useRef(false);
  const [commitState, setCommitState] = useState({ data: null, error: null, loading: false, key: null });
  const [selectedCommits, setSelectedCommits] = useState([]);
  const [commitSearch, setCommitSearch] = useState('');
  const [commitRevision, setCommitRevision] = useState(0);
  const [includeWorkingChanges, setIncludeWorkingChanges] = useState(true);

  const docTypeName = activeTab === 'requirement' ? t("DocsViewerBody.message073") : t("DocumentDropdown.message005");

  // Check for active sync on mount
  useEffect(() => {
    if (!selectedReq?.id) return;
    fetch(`${ROUTE}/sync-active?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && data.active && data.sync) {
          setCurrentSync(data.sync);
          setView('progress');
          if (setSyncing) setSyncing(true);
          // If sync is still running, connect to SSE to get updates
          if (syncTaskModel.isSyncActive(data.sync)) {
            connectToSyncSSE(data.sync.id);
          }
        }
      })
      .catch(() => {});
  }, [workspaceId, selectedReq?.id]);

  // Load branch info
  useEffect(() => {
    if (!selectedReq?.id) return;
    const controller = new AbortController();
    baseBranchEdited.current = false;
    setBranchInfo({ targetBranch: null, baseBranch: null }); setBaseBranch('');
    fetch(`${ROUTE}/sync-branch-info?workspaceId=${encodeURIComponent(workspaceId)}&requirementId=${encodeURIComponent(selectedReq.id)}`, { signal: controller.signal })
      .then(async res => { const data = await res.json(); if (!res.ok || data.error) throw new Error(data.error || t("SyncPanel.message054")); return data; })
      .then(data => {
        if (controller.signal.aborted) return;
        setBranchInfo(data);
        if (!baseBranchEdited.current) setBaseBranch(data.baseBranch || '');
      })
      .catch(error => { if (!controller.signal.aborted) setBranchInfo({ targetBranch: null, baseBranch: null, targetBranchError: error.message }); });
    return () => controller.abort();
  }, [workspaceId, selectedReq?.id]);

  const comparisonKey = JSON.stringify([workspaceId, selectedReq?.id, branchInfo.targetBranch, baseBranch.trim(), commitRevision]);
  const commitsReady = !!commitState.data && commitState.key === comparisonKey && !commitState.loading;
  const availableCommits = commitsReady ? commitState.data.commits : [];
  const visibleCommits = availableCommits.filter(commit => `${commit.hash} ${commit.subject} ${commit.author}`.toLowerCase().includes(commitSearch.toLowerCase().trim()));
  const canSync = !loadingSessions && !syncActivity && !!branchInfo.targetBranch && !!baseBranch.trim() && commitsReady && (selectedCommits.length > 0 || selectedSessionIds.length > 0 || includeWorkingChanges && commitState.data.hasUncommitted);

  useEffect(() => {
    setSelectedCommits([]);
    if (!branchInfo.targetBranch || !baseBranch.trim()) { setCommitState({ data: null, error: null, loading: false, key: comparisonKey }); return; }
    const controller = new AbortController();
    setCommitState({ data: null, error: null, loading: true, key: comparisonKey });
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ workspaceId, requirementId: selectedReq.id, baseBranch: baseBranch.trim() });
        const res = await fetch(`${ROUTE}/sync-commits?${params}`, { signal: controller.signal });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || t("SyncPanel.message055"));
        if (controller.signal.aborted) return;
        setCommitState({ data, error: null, loading: false, key: comparisonKey });
        setSelectedCommits(data.commits.map(commit => commit.hash));
      } catch (error) { if (!controller.signal.aborted) setCommitState({ data: null, error: error.message, loading: false, key: comparisonKey }); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [comparisonKey]);

  const connectToSyncSSE = syncId => {
    clearInterval(pollRef.current);
    let fetching = false;
    const poll = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch(`${ROUTE}/sync-detail?id=${syncId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`);
        if (!response.ok) throw new Error(t("SyncPanel.message057"));
        const { sync } = await response.json();
        if (!sync) throw new Error(t("SyncPanel.message058"));
        setCurrentSync(sync);
        if (!syncTaskModel.isSyncActive(sync)) {
          clearInterval(pollRef.current); setSyncing(false); refreshTree();
        }
      } catch (error) { setError(error.message); }
      finally { fetching = false; }
    };
    pollRef.current = setInterval(poll, 1000);
    return pollRef.current;
  };

  const handlePhasedSync = async () => {
    if (!canSync || syncing) return;
    window.dispatchEvent(new Event('req-hub-sync-change'));
    setError(null);
    setView('progress');
    if (setSyncing) setSyncing(true);

    const steps = syncTaskModel.createSyncSteps({ sessionIds: selectedSessionIds });

    const initialSync = {
      id: `sync-${Date.now()}`,
      workspaceId,
      requirementId: selectedReq.id,
      docType: activeTab,
      docTypeName,
      sessionIds: selectedSessionIds,
      sessionVersions: Object.fromEntries(selectedSessionIds.map(id => [id, sessionVersions()[id]])),
      startedAt: Date.now(),
      status: 'running',
      steps,
      generatedFiles: [],
    };
    setCurrentSync(initialSync);
    let latestSync = initialSync, confirmedId = null;
    let terminalReceived = false;
    let taskDeleted = false;

    try {
      // 获取当前会话 ID
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
        // 忽略错误
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
          docType: activeTab,
          baseBranch: baseBranch.trim(),
          commitHashes: selectedCommits,
          branchTip: commitState.data.branchTip,
          baseCommit: commitState.data.baseline,
          includeWorkingChanges,
          sessionIds: selectedSessionIds,
          sessionVersions: Object.fromEntries(selectedSessionIds.map(id => [id, sessionVersions()[id]])),
        }),
      });
      if (!mounted.current) {
        if (response.body) await readSyncEvents(response.body, () => {});
        return;
      }

      // 检查响应类型
      const contentType = response.headers.get('content-type');

      // 如果返回 JSON，说明有正在进行的任务
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        if (data.skipped) {
          showToast({ text: data.message || t("SyncPanel.message059"), holdMs: 3000 });
          setCurrentSync(null);
          setView('select');
          if (setSyncing) setSyncing(false);
          return;
        }
        if (data.active && data.sync) {
          if (response.status === 409) throw new Error(data.message || t("SyncPanel.message060"));
          setCurrentSync(data.sync);
          setView('progress');
          if (setSyncing) setSyncing(true);
          // 如果任务还在运行，开始轮询
          if (syncTaskModel.isSyncActive(data.sync)) {
            connectToSyncSSE(data.sync.id);
          }
        } else {
          throw new Error(data.error || data.message || t("SyncPanel.message061"));
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // SSE 流处理
      await readSyncEvents(response.body, async event => {
        if (!mounted.current) return;
        if (event.type === 'deleted') {
          taskDeleted = true; terminalReceived = true;
          setCurrentSync(null); setSyncing(false); setView('select');
          return;
        }
        if (event.type === 'sync_started') {
          window.dispatchEvent(new Event('req-hub-sync-change'));
          confirmedId = event.syncId;
          latestSync = { ...latestSync, id: confirmedId };
        }
        if (event.sync) {
          latestSync = event.sync; confirmedId = event.sync.id;
          setCurrentSync(latestSync);
        } else if (event.type === 'step') {
          latestSync = structuredClone(latestSync);
          syncTaskModel.updateSyncTask(latestSync, { type: 'step', phase: event.phase, updates: event });
        }
        setCurrentSync({ ...latestSync });
        if (event.type === 'error') {
          terminalReceived = !syncTaskModel.isSyncActive(latestSync);
          setError(event.error);
          if (!terminalReceived) throw new Error(event.error);
        }
        if (event.type === 'done') {
          terminalReceived = !syncTaskModel.isSyncActive(latestSync);
          if (!terminalReceived) throw new Error(t("SyncPanel.message062"));
          refreshTree();
        }
      });
      if (!mounted.current || taskDeleted) return;
      if (!terminalReceived) throw new Error(t("SyncPanel.message063"));
      setSyncing(false);
      window.dispatchEvent(new Event('req-hub-sync-change'));
    } catch (error) {
      if (!mounted.current || taskDeleted) return;
      setError(error.message || t("SyncPanel.message064"));
      if (confirmedId) {
        try {
          const response = await fetch(`${ROUTE}/sync-detail?id=${confirmedId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`);
          if (response.ok) { const data = await response.json(); if (data.sync) latestSync = data.sync; }
        } catch { /* Keep polling a known task; a network error is not a task failure. */ }
        setCurrentSync(latestSync);
        if (syncTaskModel.isSyncActive(latestSync)) { setSyncing(true); connectToSyncSSE(confirmedId); }
        else setSyncing(false);
      } else {
        setView('select'); setCurrentSync(null); setSyncing(false);
      }
    }

  };

  // Secondary page: viewing session turns
  if (viewingSession) {
    return h(SessionTurnsView, {
      workspaceId,
      sessionId: viewingSession.id,
      sessionTitle: viewingSession.title || t("SyncPanel.message007"),
      snapshotVersion: sessionVersions()[viewingSession.id] || viewingSession.snapshotVersion,
      onBack: () => setViewingSession(null),
    });
  }

  // Secondary page: viewing a file
  if (view === 'file' && viewingFile) {
    return h('div', { className: css.column},
      h('div', { className: css.section2},
        h('div', { className: css.row16},
          h(HeaderBack, { onBack: () => {
            setViewingFile(null);
            setView('progress');
          }, label: t("common.back") }),
          h('span', { className: css.row20 }, ' ', viewingFile.split('/').pop())
        )
      ),
      h('div', { className: css.pane4},
        h(FilePreview, {
          workspaceId,
          relPath: `${selectedReq.path}/${viewingFile}`,
          name: viewingFile.split('/').pop(),
          requirement: null,
        })
      )
    );
  }

  // Secondary page: sync history
  if (view === 'history') {
    return h(SyncHistoryView, {
      workspaceId,
      requirementId: selectedReq.id,
      onBack: () => setView('select'),
      onSelectSync: (sync) => {
        setSelectedHistorySync(sync);
        setView('detail');
      },
    });
  }

  // Secondary page: sync detail (from history)
  if (view === 'detail' && selectedHistorySync) {
    return h(SyncDetailView, {
      sync: selectedHistorySync,
      onBack: () => {
        setView('history');
        setSelectedHistorySync(null);
      },
    });
  }

  // Progress view (active sync)
  if (view === 'progress' && currentSync) {
    return h(SyncProgressView, {
      sync: currentSync,
      workspaceId,
      requirementId: selectedReq.id,
      onBack: () => {
        setView('select');
        setCurrentSync(null);
      },
      onViewFile: (fileName) => {
        setViewingFile(fileName);
        setView('file');
      },
      onSyncAborted: () => {
        setCurrentSync(previous => {
          if (!previous) return previous;
          const next = structuredClone(previous);
          syncTaskModel.updateSyncTask(next, { type: 'cancel' });
          return next;
        });
      },
    });
  }

  // Main view: session selector + sync button
  return h('div', { className: 'rh-op-panel' },
    // Back button
    h(HeaderBack, { onBack: onClose, label: t("common.back") }),

    h('div', { className: ('rh-op-info') + ' ' + css.spacing2 },
      h('div', null, t("SyncPanel.message065"), h('code', null, `${selectedReq.developer}/${selectedReq.id}`)),
      h('div', { className: css.mutedText13 },
        t("SyncPanel.message066", { value0: docTypeName }))
    ),

    // Branch info display
    h('div', { className: css.section11},
      h('div', { className: ('rh-sync-branch-row') + ' ' + css.row12},
        h('span', { className: ('rh-sync-branch-label') + ' ' + css.row21}, t("SyncPanel.message067")),
        h('code', { className: css.content4, style: { "--rh-color-1": cssValue(branchInfo.targetBranch ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)') }}, branchInfo.targetBranch || t("SyncPanel.message068"))
      ),
      h('div', { className: ('rh-sync-branch-row') + ' ' + css.row16},
        h('span', { className: ('rh-sync-branch-label') + ' ' + css.row21}, t("SyncPanel.message069")),
        h(Input, { className: 'rh-search-input', 'aria-label': t("SyncPanel.message070"), placeholder: t("SyncPanel.message071"), value: baseBranch, disabled: syncing, onChange: event => { baseBranchEdited.current = true; setBaseBranch(event.target.value); } })
      ),
      !baseBranch.trim() && branchInfo.baseBranchHint && h('p', { className: 'rh-sync-hint', role: 'status' }, branchInfo.baseBranchHint),
      branchInfo.targetBranchError && h('p', { className: 'rh-error', role: 'alert' }, branchInfo.targetBranchError)
    ),

    h('section', { className: 'rh-sync-source-section rh-sync-commits', 'aria-label': t("SyncPanel.message072") },
      h('div', { className: 'rh-sync-section-heading rh-sync-commits-heading' },
        h('h3', { className: 'rh-sync-section-title' }, t("SyncPanel.message073")),
        h('span', { className: 'rh-sync-hint' }, t("SyncPanel.message074", { value0: selectedCommits.length, value1: availableCommits.length })),
        h(Button, { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !commitsReady || syncing, onClick: () => setSelectedCommits(availableCommits.map(commit => commit.hash)) }, t("LogPanel.message007")),
        h(Button, { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !commitsReady || syncing, onClick: () => setSelectedCommits([]) }, t("LogPanel.message002")),
        h(Button, { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !baseBranch.trim() || !branchInfo.targetBranch || syncing, onClick: () => setCommitRevision(value => value + 1) }, t("SyncPanel.message075"))),
      h('p', { className: 'rh-sync-hint' }, t("SyncPanel.message076")),
      !branchInfo.targetBranch || !baseBranch.trim() ? h('p', { className: 'rh-sync-hint' }, t("SyncPanel.message077"))
        : commitState.loading || !commitState.key ? h('p', { role: 'status', className: 'rh-sync-hint' }, t("SyncPanel.message078"))
        : commitState.error ? h('p', { role: 'alert', className: 'rh-error' }, commitState.error)
        : commitsReady && h(React.Fragment, null,
          availableCommits.length > 0 && h(Input, { className: 'rh-search-input', type: 'search', 'aria-label': t("SyncPanel.message079"), placeholder: t("SyncPanel.message080"), value: commitSearch, onChange: event => setCommitSearch(event.target.value) }),
          h('div', { className: 'rh-sync-commit-list' }, visibleCommits.map(commit => h('label', { className: `rh-sync-commit${selectedCommits.includes(commit.hash) ? ' selected' : ''}`, key: commit.hash },
            h('input', { type: 'checkbox', checked: selectedCommits.includes(commit.hash), disabled: syncing, 'aria-label': t("SyncPanel.message081", { value0: commit.shortHash }), onChange: event => setSelectedCommits(previous => event.target.checked ? [...previous, commit.hash] : previous.filter(hash => hash !== commit.hash)) }),
            h('span', { className: 'rh-sync-commit-content' },
              h('span', { className: 'rh-sync-commit-title', title: commit.subject }, h('code', null, commit.shortHash), ' ', commit.subject),
              h('span', { className: 'rh-sync-hint' }, `${commit.author} · ${new Date(commit.date).toLocaleString()}${commit.merge ? t("SyncPanel.message082") : ''}`))))),
          !availableCommits.length && h('p', { className: 'rh-sync-hint' }, t("SyncPanel.message083")),
          availableCommits.length > 0 && !visibleCommits.length && h('p', { className: 'rh-sync-hint' }, t("SyncPanel.message084")),
          commitState.data.hasUncommitted && h('div', { className: 'rh-sync-working-option' }, h(Checkbox, { checked: includeWorkingChanges, disabled: syncing, onChange: checked => setIncludeWorkingChanges(checked), label: t("SyncPanel.message085") })))),

    // Both document sync and knowledge import use this acquisition entry.
    h(ConversationSources, { key: `${workspaceId}:${conversationRevision}`, workspaceId,
      dshSelection: { ids: selectedSessions, versions: selectedSessionVersions.current }, codexSelection,
      onDshSelectionChange: value => { setSelectedSessions(value.ids); selectedSessionVersions.current = value.versions; },
      onCodexSelectionChange: setCodexSelection, onView: setViewingSession, disabled: syncing,
      onBusyChange: setLoadingSessions, onManage: () => setManagingConversations(true) }),
    managingConversations && h(ConversationManager, { workspaceId, onClose: () => setManagingConversations(false), onChanged: () => { setSelectedSessions([]); selectedSessionVersions.current = {}; setCodexSelection({ ids: [], versions: {} }); setConversationRevision(value => value + 1); } }),

    // Action buttons
    h('div', { className: css.spacing2 },
      h(Button, {
        className: ('rh-btn rh-btn-primary') + ' ' + css.size3,
        onClick: handlePhasedSync,
        disabled: syncing || !canSync,
      }, syncing ? t("SyncPanel.message092") : t("SyncPanel.message093", { value0: docTypeName }))
    ),

    error && h('div', { className: css.row22 }, h(IconError, { size: 14 }), error),
  );
}

module.exports = { SyncPanel };
