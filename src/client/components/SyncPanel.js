'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');
const { FilePreview } = require('./FilePreview.js');
const { showToast } = require('./shared/ToastContainer.js');
const { createIconComponents } = require('../icons.js');

const { IconFile, IconSync, IconError, IconCheck, IconSkip, IconHourglass, IconUser, IconRobot, IconMerge, IconChart, IconCheckboxOn, IconCheckboxOff, IconBrain, IconWrench, IconComment, IconCode, IconChevronDown } = createIconComponents(h);

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
function SyncPanel({ workspaceId, selectedReq, onClose }) {
  const [syncDocType, setSyncDocType] = useState(null); // null | 'requirement' | 'design'
  const [syncing, setSyncing] = useState(false);
  const [view, setView] = useState('main'); // 'main' | 'history' | 'detail'
  const [selectedHistorySync, setSelectedHistorySync] = useState(null);
  const { refreshTree } = React.useContext(DocsViewerContext);

  // Check for active sync on mount — if a running sync exists, skip directly to progress view
  useEffect(() => {
    if (!selectedReq?.id || !workspaceId) return;
    fetch(`${ROUTE}/sync-active?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && data.active && data.sync && data.sync.status === 'running') {
          setSyncDocType(data.sync.docType);
          setSyncing(true);
        }
      })
      .catch(() => {});
  }, [workspaceId, selectedReq?.id]);

  if (!selectedReq) {
    return h('div', { className: 'rh-op-panel' },
      h('div', { style: { color: 'var(--dsw-alias-state-warning-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 12 } },
        '请先在左侧目录树中选择一个需求目录'),
      h('button', { className: 'rh-btn', onClick: onClose }, '关闭')
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
    // Requirement card (same as AnalyzePanel)
    selectedReq && h('div', { className: 'rh-req-card' },
      h('div', { className: 'rh-req-card-title' }, selectedReq.title),
      h('div', { className: 'rh-req-card-row' }, '开发者：', selectedReq.developer),
      h('div', { className: 'rh-req-card-row' }, '日期：', selectedReq.date),
      h('div', { className: 'rh-req-card-row' }, '文档数：', selectedReq.fileCount)
    ),

    // Sync type buttons
    h('div', { className: 'rh-btn-stack', style: { marginBottom: 12 } },
      h('button', {
        className: 'rh-btn',
        onClick: () => setSyncDocType('requirement'),
      }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconSync, { size: 14 }), ' 同步需求文档')),
      h('button', {
        className: 'rh-btn',
        onClick: () => setSyncDocType('design'),
      }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconSync, { size: 14 }), ' 同步技术方案'))
    ),

    // History button
    h('div', { className: 'rh-btn-stack' },
      h('button', {
        className: 'rh-btn',
        onClick: () => setView('history'),
      }, '同步历史')
    )
  );
}

// ─── SessionTurnsView - 会话轮次内容查看器（二级页面）─────────────
/**
 * @component
 * Displays the conversation turns of a session in an expandable list format.
 * Each turn shows user input and summary with timestamps, and can be expanded/collapsed.
 * Supports expand all / collapse all functionality.
 * @param {Object} props - Component props
 * @param {string} props.sessionId - The session ID to load turns for
 * @param {string} props.sessionTitle - Display title for the session
 * @param {Function} props.onBack - Callback invoked to return to the previous view
 * @returns {JSX.Element}
 */
function SessionTurnsView({ sessionId, sessionTitle, onBack }) {
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
      const res = await fetch(`${ROUTE}/session-turns?sessionId=${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setTurnsData(data);
        } else {
          setError(data.error || '加载失败');
        }
      } else {
        setError('加载失败');
      }
    } catch (e) {
      console.error('Failed to load session turns:', e);
      setError(e.message || '加载失败');
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
    return h('div', { style: { padding: 20, textAlign: 'center' } },
      h('div', { style: { fontSize: 'var(--rh-font-size-title)', color: 'var(--dsw-alias-label-secondary)' } }, '加载中...')
    );
  }

  if (error) {
    return h('div', { style: { padding: 20 } },
      h('button', { className: 'rh-btn', onClick: onBack, style: { marginBottom: 12 } }, '← 返回'),
      h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', display: 'flex', alignItems: 'center', gap: 6 } }, h(IconError, { size: 14 }), error)
    );
  }

  if (!turnsData || !turnsData.turns || turnsData.turns.length === 0) {
    return h('div', { style: { padding: 20 } },
      h('button', { className: 'rh-btn', onClick: onBack, style: { marginBottom: 12 } }, '← 返回'),
      h('div', { style: { fontSize: 'var(--rh-font-size)', color: 'var(--dsw-alias-label-secondary)', fontStyle: 'italic' } },
        '该会话没有对话内容')
    );
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    // Header
    h('div', { style: {
      padding: '8px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      flexShrink: 0,
    }},
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }},
        h('button', { className: 'rh-btn', onClick: onBack, style: { fontSize: 'var(--rh-font-size-sm)', padding: '3px 8px' } }, '← 返回'),
        h('span', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, flex: 1 } }, sessionTitle || '会话内容')
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)' }},
        h('span', null, `共 ${turnsData.turnCount || turnsData.turns?.length || 0} 个轮次`),
        h('span', null, `•`),
        h('span', null, `约 ${((turnsData.totalTokens || 0) / 1000).toFixed(1)}k tokens`),
        h('span', { style: { marginLeft: 'auto' }},
          expandedTurns.size === turnsData.turnCount
            ? h('button', { className: 'rh-btn', onClick: collapseAll, style: { fontSize: 'var(--rh-font-size-sm)', padding: '2px 8px' }}, '全部收起')
            : h('button', { className: 'rh-btn', onClick: expandAll, style: { fontSize: 'var(--rh-font-size-sm)', padding: '2px 8px' }}, '全部展开')
        )
      )
    ),

    // Turns list
    h('div', { style: { flex: 1, overflow: 'auto', padding: 16 }},
      turnsData.turns.map((turn, idx) => {
        const isExpanded = expandedTurns.has(turn.turnNumber);
        const time = turn.time ? new Date(turn.time).toLocaleString() : '';
        const endTime = turn.endTime ? new Date(turn.endTime).toLocaleString() : '';
        // 兼容两种数据格式：sessionQuery 返回 content，sessions 服务返回 userInput
        const userInput = turn.userInput || turn.content || '';
        const summary = turn.summary || '';

        return h('div', {
          key: idx,
          style: {
            marginBottom: 12,
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            overflow: 'hidden',
          }
        },
          // Turn header
          h('div', {
            onClick: () => toggleTurn(turn.turnNumber),
            style: {
              padding: '10px 14px',
              background: isExpanded ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }
          },
            h('span', { style: {
              fontSize: 'var(--rh-font-size-sm)',
              fontWeight: 600,
              color: 'var(--rh-accent)',
              minWidth: 50,
            }}, `轮次 ${turn.turnNumber}`),
            h('span', { style: {
              flex: 1,
              fontSize: 'var(--rh-font-size)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--dsw-alias-label-primary)',
            }}, (turn.userInput || turn.content || '').substring(0, 100)),
            h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 }}, time),
            h('span', { style: {
              fontSize: 'var(--rh-font-size-sm)',
              color: 'var(--dsw-alias-label-secondary)',
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
            }}, h(IconChevronDown, { size: 12, style: { transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}))
          ),

          // Turn content (expanded)
          isExpanded && h('div', { style: { padding: '12px 14px', background: 'var(--dsw-alias-bg-layer-1)' }},
            // User input
            h('div', { style: { marginBottom: 12 }},
              h('div', { style: {
                fontSize: 'var(--rh-font-size-sm)',
                fontWeight: 600,
                color: 'var(--dsw-alias-label-secondary)',
                marginBottom: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }},
                h('span', { style: { color: 'var(--rh-accent)' }}, '●'),
                '用户输入'
              ),
              h('div', {
                style: {
                  fontSize: 'var(--rh-font-size)',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: '10px 12px',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  borderRadius: 6,
                  borderLeft: '3px solid var(--rh-accent)',
                }
              }, turn.userInput || turn.content || '(无内容)')
            ),

            // Summary
            turn.summary && h('div', null,
              h('div', { style: {
                fontSize: 'var(--rh-font-size-sm)',
                fontWeight: 600,
                color: 'var(--dsw-alias-label-secondary)',
                marginBottom: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }},
                h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' }}, '●'),
                '轮次总结'
              ),
              h('div', {
                style: {
                  fontSize: 'var(--rh-font-size)',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  padding: '10px 12px',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  borderRadius: 6,
                  borderLeft: '3px solid var(--dsw-alias-state-success-primary)',
                }
              }, turn.summary || '(无总结)'),
              endTime && h('div', {
                style: {
                  fontSize: 'var(--rh-font-size-sm)',
                  color: 'var(--dsw-alias-label-secondary)',
                  marginTop: 6,
                  textAlign: 'right',
                }
              }, `结束时间: ${endTime}`)
            )
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
      case 'completed': return h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 16, display: 'inline-flex' } }, h(IconCheck, { size: 16 }));
      case 'running': return h('span', { className: 'rh-spinner', style: { display: 'inline-block', width: 14, height: 14, borderWidth: 2 } });
      case 'failed': return h('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 16, display: 'inline-flex' } }, h(IconError, { size: 16 }));
      case 'skipped': return h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 16, display: 'inline-flex' } }, h(IconSkip, { size: 16 }));
      default: return h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 16, display: 'inline-flex' } }, h(IconHourglass, { size: 16 }));
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

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }},
    (steps || []).map((step, idx) => {
      const phaseFiles = filesByPhase[step.phase] || [];
      const hasChunks = step.chunks && step.chunks.length > 0;
      const isChunksExpanded = expandedChunks[step.phase];
      const isStepExpanded = expandedSteps[step.phase];

      return h('div', {
        key: idx,
        className: 'rh-sync-step',
        style: {
          background: step.status === 'running' ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
          border: step.status === 'running' ? '1px solid var(--rh-accent)' : '1px solid var(--dsw-alias-border-l1)',
        }
      },
        // Step header (clickable to expand)
        h('div', {
          className: 'rh-sync-step-header',
          onClick: () => toggleStep(step.phase),
        },
          getStepIcon(step.status),
          h('span', { className: 'rh-sync-step-label', style: { flex: 1 }}, step.label),
          // Liveness indicator
          step.status === 'running' && step.livenessStage && h('span', {
            style: {
              fontSize: 'var(--rh-font-size-sm)',
              color: step.livenessStage === 'liveness_stale' ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-state-success-primary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              padding: '2px 6px',
              borderRadius: 4,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }
          }, step.livenessStage === 'liveness_stale' ? '⚠' : '●', ` ${step.lastActivityDesc || ''}`),
          // 分块次数标签
          hasChunks && h('span', {
            onClick: (e) => { e.stopPropagation(); toggleChunks(step.phase); },
            style: {
              fontSize: 'var(--rh-font-size-sm)',
              color: 'var(--rh-accent)',
              background: 'var(--dsw-alias-bg-layer-2)',
              padding: '2px 6px',
              borderRadius: 4,
              cursor: 'pointer',
            }
          }, `${step.chunks.length} 块`),
          // Token 数标签
          step.totalTokens && h('span', {
            style: {
              fontSize: 'var(--rh-font-size-sm)',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              padding: '2px 6px',
              borderRadius: 4,
            }
          }, `${formatTokens(step.totalTokens)} tokens`),
          // Expand arrow
          h('span', { className: `rh-sync-step-arrow${isStepExpanded ? ' expanded' : ''}` }, '▾')
        ),
        // Step text (always visible)
        step.text && h('div', {
          style: {
            fontSize: 'var(--rh-font-size-sm)',
            color: 'var(--dsw-alias-label-secondary)',
            padding: '0 12px 8px 38px',
            lineHeight: 1.5,
          }
        }, step.text),

        // Expanded detail section
        isStepExpanded && h('div', { className: 'rh-sync-step-detail' },
          // Files section
          phaseFiles.length > 0 && h('div', { className: 'rh-sync-step-files' },
            h('div', { style: { fontSize: 'var(--rh-font-size-sm)', fontWeight: 600, marginBottom: 6, color: 'var(--dsw-alias-label-primary)' } }, '生成的文件：'),
            phaseFiles.map((fileName, fi) =>
              h('a', {
                key: fi,
                className: 'rh-sync-step-file-link',
                href: '#',
                onClick: (e) => { e.preventDefault(); onViewFile && onViewFile(fileName); },
              }, `📄 ${fileName}`)
            )
          ),

          // Chunks 详情（可展开）
          hasChunks && h('div', { style: { marginTop: 12 } },
            h('div', {
              style: { fontSize: 'var(--rh-font-size-sm)', fontWeight: 600, marginBottom: 8, color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
              onClick: () => toggleChunks(step.phase)
            }, `处理分块 (${step.chunks.length}) ${isChunksExpanded ? '▾' : '▸'}`),

            isChunksExpanded && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              // 分块总览
              h('div', { style: {
                fontSize: 'var(--rh-font-size-sm)',
                color: 'var(--dsw-alias-label-secondary)',
                borderBottom: '1px solid var(--dsw-alias-border-l1)',
                paddingBottom: 4,
                marginBottom: 4,
              }}, `共 ${step.chunks.length} 块，约 ${formatTokens(step.totalTokens)} tokens`),

              // 每块详情
              step.chunks.map((chunk, ci) =>
                h('div', {
                  key: ci,
                  style: {
                    background: 'var(--dsw-alias-bg-layer-1)',
                    borderRadius: 4,
                    padding: '6px 8px',
                    fontSize: 'var(--rh-font-size-sm)',
                    borderLeft: chunk.status === 'running' ? '2px solid var(--rh-accent)'
                      : chunk.status === 'failed' ? '2px solid var(--dsw-alias-state-error-primary)'
                      : chunk.status === 'aborted' ? '2px solid var(--dsw-alias-state-warning-primary)'
                      : chunk.status === 'completed' ? '2px solid var(--dsw-alias-state-success-primary)'
                      : '2px solid transparent',
                  }
                },
                  // 块头部：状态图标 + 块号 + 状态文字 + token 数
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: chunk.sessionId ? 3 : 4 }},
                    // 状态图标
                    chunk.status === 'queued' && h(IconHourglass, { size: 12, color: 'var(--dsw-alias-label-secondary)' }),
                    chunk.status === 'running' && h(IconSync, { size: 12, color: 'var(--rh-accent)', className: 'rh-spin' }),
                    chunk.status === 'completed' && h(IconCheck, { size: 12, color: 'var(--dsw-alias-state-success-primary)' }),
                    chunk.status === 'failed' && h(IconError, { size: 12, color: 'var(--dsw-alias-state-error-primary)' }),
                    chunk.status === 'aborted' && h(IconSkip, { size: 12, color: 'var(--dsw-alias-state-warning-primary)' }),
                    // 块号 + 状态文字
                    h('span', { style: { fontWeight: 600, fontSize: 'var(--rh-font-size-sm)' }},
                      `块 ${ci + 1}`,
                      chunk.status && chunk.status !== 'completed'
                        ? h('span', { style: { fontWeight: 400, color:
                            chunk.status === 'running' ? 'var(--rh-accent)'
                            : chunk.status === 'failed' ? 'var(--dsw-alias-state-error-primary)'
                            : chunk.status === 'aborted' ? 'var(--dsw-alias-state-warning-primary)'
                            : 'var(--dsw-alias-label-secondary)',
                            marginLeft: 6, fontSize: 'var(--rh-font-size-sm)' },
                          }, chunk.status === 'queued' ? '排队中'
                            : chunk.status === 'running' ? '处理中'
                            : chunk.status === 'failed' ? '失败'
                            : chunk.status === 'aborted' ? '已终止'
                            : '')
                        : null
                    ),
                    // token 数
                    h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginLeft: 'auto' }}, `${formatTokens(chunk.tokens)} tokens`),
                  ),
                  // sessionId（紧凑展示）
                  chunk.sessionId && h('div', {
                    style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'var(--rh-font-code)', marginBottom: 4 },
                    title: `Subagent Session: ${chunk.sessionId}`,
                  }, `🤖 ${chunk.sessionId.slice(0, 20)}...`),
                  // 错误信息
                  chunk.status === 'failed' && chunk.error && h('div', {
                    style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-state-error-primary)', marginTop: 2 },
                  }, `❌ ${chunk.error}`),
                  // 文件列表
                  chunk.files && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 }},
                    chunk.files.slice(0, 5).map((f, fi) =>
                      h('span', {
                        key: fi,
                        style: {
                          color: 'var(--rh-accent)',
                          background: 'var(--dsw-alias-bg-layer-2)',
                          padding: '1px 4px',
                          borderRadius: 2,
                        }
                      }, f.file || f)
                    ),
                    chunk.files.length > 5 && h('span', {
                      style: { color: 'var(--dsw-alias-label-secondary)' }
                    }, `+${chunk.files.length - 5} 个文件`)
                  ),
                  // 消息列表
                  chunk.messages && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }},
                    chunk.messages.slice(0, 3).map((m, mi) =>
                      h('div', {
                        key: mi,
                        style: {
                          color: m.role === 'user' ? 'var(--dsw-alias-state-info-primary)' : 'var(--rh-accent)',
                        }
                      }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, m.role === 'user' ? h(IconUser, { size: 12 }) : h(IconRobot, { size: 12 }), ` ${m.preview?.substring(0, 30) || ''}...`))
                    ),
                    chunk.messages.length > 3 && h('span', {
                      style: { color: 'var(--dsw-alias-label-secondary)' }
                    }, `+${chunk.messages.length - 3} 条消息`)
                  )
                )
              )
            )
          ),

          // Log section (if available)
          step.log && h('div', { style: { marginTop: 12 } },
            h('div', { style: { fontSize: 'var(--rh-font-size-sm)', fontWeight: 600, marginBottom: 6, color: 'var(--dsw-alias-label-primary)' } }, '执行日志：'),
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
        }),
      });
      const data = await res.json();
      if (data.success) {
        setShowAbortConfirm(false);
        showToast({ tone: 'warning', text: '同步任务已终止', holdMs: 3000 });
        onSyncAborted?.();
      } else {
        showToast({ tone: 'error', text: data.error || '终止失败', holdMs: 3000 });
      }
    } catch (e) {
      showToast({ tone: 'error', text: '终止请求失败: ' + e.message, holdMs: 3000 });
    } finally {
      setAborting(false);
    }
  };

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' }},
    // Header
    h('div', { style: {
      padding: '8px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      flexShrink: 0,
    }},
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }},
        h('button', { className: 'rh-btn', onClick: onBack, style: { fontSize: 'var(--rh-font-size-sm)', padding: '3px 8px' } }, '← 返回'),
        h('span', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, flex: 1, display: 'flex', alignItems: 'center', gap: 4 } },
          sync.status === 'running'
            ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconSync, { size: 14 }), ' 同步进行中')
            : sync.status === 'completed'
              ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconCheck, { size: 14 }), ' 同步完成')
              : sync.status === 'aborted'
                ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--dsw-alias-state-warning-primary)' } }, '⬛', ' 已终止')
                : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconError, { size: 14 }), ' 同步失败')
        ),
      ),
      h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 16 }},
        h('span', null, '类型：', sync.docTypeName),
        h('span', null, '开始：', new Date(sync.startedAt).toLocaleString()),
        sync.completedAt && h('span', null, '完成：', new Date(sync.completedAt).toLocaleString()),
        sync.abortedAt && h('span', null, '终止：', new Date(sync.abortedAt).toLocaleString()),
      ),
      // Progress bar
      h('div', { className: 'rh-sync-progress', style: { marginTop: 12, padding: 0, background: 'transparent', borderBottom: 'none' } },
        h('div', { className: 'rh-sync-progress-header' },
          h('span', null, `同步进度 ${completedSteps}/${totalSteps} 阶段`),
          h('span', { className: 'rh-sync-progress-percent' }, `${progress}%`)
        ),
        h('div', { className: 'rh-sync-progress-bar' },
          h('div', {
            className: 'rh-sync-progress-fill',
            style: {
              width: `${progress}%`,
              background: sync.status === 'aborted' ? 'var(--dsw-alias-state-warning-primary)' : undefined,
            },
            role: 'progressbar',
            'aria-valuenow': progress,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          })
        ),
        sync.status === 'running' && remainingSteps > 0 && h('div', { className: 'rh-sync-progress-eta' },
          `预计剩余时间：约 ${etaMinutes} 分钟`
        )
      )
    ),
    // Steps
    h('div', { style: { flex: 1, overflow: 'auto', padding: 16 }},
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
      style: {
        padding: '12px 16px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        flexShrink: 0,
      }
    },
      h('button', {
        className: 'rh-btn rh-btn-danger-outline',
        style: {
          width: '100%',
          padding: '10px 16px',
          fontSize: 'var(--rh-font-size)',
          fontWeight: 600,
        },
        onClick: () => setShowAbortConfirm(true),
      }, '终止同步任务')
    ),
    // Abort confirmation dialog
    showAbortConfirm && h('div', {
      className: 'rh-confirm-overlay',
      onClick: () => !aborting && setShowAbortConfirm(false),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '确认终止同步',
    },
      h('div', {
        className: 'rh-confirm-dialog',
        onClick: e => e.stopPropagation(),
      },
        h('div', { className: 'rh-confirm-header' },
          h('span', { className: 'rh-confirm-warning-icon', style: { fontSize: 18 } }, '⚠'),
          h('h3', { className: 'rh-confirm-title' }, '确认终止同步？'),
        ),
        h('div', { className: 'rh-confirm-body' },
          h('p', { className: 'rh-confirm-message' },
            '终止后当前同步进度将丢失，已生成的文件不会被回滚。'),
        ),
        h('div', { className: 'rh-confirm-footer' },
          h('button', {
            className: 'rh-btn',
            onClick: () => setShowAbortConfirm(false),
            disabled: aborting,
          }, '取消'),
          h('button', {
            className: 'rh-btn rh-btn-danger',
            onClick: handleAbort,
            disabled: aborting,
          }, aborting ? '终止中...' : '确认终止'),
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${ROUTE}/sync-history?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(requirementId)}`)
      .then(res => res.ok ? res.json() : { history: [] })
      .then(data => setHistory(data.history || []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false));
  }, [workspaceId, requirementId]);

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' }},
    // Header
    h('div', { style: {
      padding: '8px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      flexShrink: 0,
    }},
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }},
        h('button', { className: 'rh-btn', onClick: onBack, style: { fontSize: 'var(--rh-font-size-sm)', padding: '3px 8px' } }, '← 返回'),
        h('span', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, flex: 1 } }, '同步历史')
      )
    ),
    // List
    h('div', { style: { flex: 1, overflow: 'auto', padding: 16 }},
      loading
        ? h('div', { style: { textAlign: 'center', padding: 40, color: 'var(--dsw-alias-label-secondary)' }}, '加载中...')
        : history.length === 0
          ? h('div', { style: { textAlign: 'center', padding: 40, color: 'var(--dsw-alias-label-secondary)', fontStyle: 'italic' }}, '暂无同步记录')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 }},
              history.map(sync =>
                h('div', {
                  key: sync.id,
                  onClick: () => onSelectSync(sync),
                  style: {
                    padding: '12px 16px',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: 'var(--dsw-alias-bg-layer-1)',
                  }
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }},
                    h('span', { style: { fontSize: 16, display: 'inline-flex' }},
                      sync.status === 'completed' ? h(IconCheck, { size: 16, color: 'var(--dsw-alias-state-success-primary)' })
                        : sync.status === 'failed' ? h(IconError, { size: 16, color: 'var(--dsw-alias-state-error-primary)' })
                        : sync.status === 'aborted' ? h('span', { style: { fontSize: 'var(--rh-font-size-title)', color: 'var(--dsw-alias-state-warning-primary)' } }, '⬛')
                        : h(IconSync, { size: 16, color: 'var(--rh-accent)' })
                    ),
                    h('span', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, flex: 1 }}, sync.docTypeName),
                    h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)' }},
                      new Date(sync.startedAt).toLocaleString()
                    )
                  ),
                  h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 12 }},
                    h('span', null, (() => {
                      const active = (sync.steps || []).filter(s => s.status !== 'skipped');
                      const done = active.filter(s => s.status === 'completed').length;
                      return `步骤: ${done}/${active.length}`;
                    })()),
                    sync.generatedFiles && sync.generatedFiles.length > 0 && h('span', null, `文件: ${sync.generatedFiles.length} 个`),
                    sync.stats && h('span', null, `LLM: ${sync.stats.totalLLMCalls || 0} 次`),
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
    return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' }},
      h('div', { style: {
        padding: '8px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        flexShrink: 0,
      }},
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }},
          h('button', { className: 'rh-btn', onClick: () => setViewingFile(null), style: { fontSize: 'var(--rh-font-size-sm)', padding: '3px 8px' } }, '← 返回'),
          h('span', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, flex: 1, display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconFile, { size: 14 }), ' ', viewingFile.split('/').pop())
        )
      ),
      h('div', { style: { flex: 1, overflow: 'hidden' }},
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
 * multiple views. Allows optional post-sync operations like analysis and indexing.
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
  const [sessions, setSessions] = useState([]);
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [sessionSearch, setSessionSearch] = useState('');
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState(null);
  const [viewingSession, setViewingSession] = useState(null);
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
  const [runAnalysis, setRunAnalysis] = useState(false);
  const [runIndex, setRunIndex] = useState(false);

  const docTypeName = activeTab === 'requirement' ? '需求文档' : '技术方案';

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
          if (data.sync.status === 'running') {
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
      .then(async res => { const data = await res.json(); if (!res.ok || data.error) throw new Error(data.error || '读取分支失败'); return data; })
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
  const canSync = !!branchInfo.targetBranch && !!baseBranch.trim() && commitsReady && (selectedCommits.length > 0 || selectedSessions.length > 0 || includeWorkingChanges && commitState.data.hasUncommitted);

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
        if (!res.ok || data.error) throw new Error(data.error || '加载 commit 列表失败');
        if (controller.signal.aborted) return;
        setCommitState({ data, error: null, loading: false, key: comparisonKey });
        setSelectedCommits(data.commits.map(commit => commit.hash));
      } catch (error) { if (!controller.signal.aborted) setCommitState({ data: null, error: error.message, loading: false, key: comparisonKey }); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [comparisonKey]);

  // Load sessions
  useEffect(() => {
    loadSessions();
  }, [workspaceId, sessionSearch]);

  const loadSessions = async () => {
    setLoadingSessions(true);
    try {
      const params = new URLSearchParams({ workspaceId, limit: '30' });
      if (sessionSearch.trim()) params.set('query', sessionSearch.trim());
      const res = await fetch(`${ROUTE}/sessions?${params}`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (e) {
      console.error('Failed to load sessions:', e);
      showToast({ tone: 'error', text: '加载会话列表失败', holdMs: 3000 });
    } finally {
      setLoadingSessions(false);
    }
  };

  const toggleSession = (sessionId) => {
    setSelectedSessions(prev =>
      prev.includes(sessionId)
        ? prev.filter(id => id !== sessionId)
        : [...prev, sessionId]
    );
  };

  const connectToSyncSSE = async (syncId) => {
    // The SSE connection is already established by the POST request
    // We just need to poll for updates since SSE is tied to the POST
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${ROUTE}/sync-active?workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.active && data.sync) {
            setCurrentSync({ ...data.sync });
            if (data.sync.status !== 'running') {
              clearInterval(pollInterval);
              if (setSyncing) setSyncing(false);
              refreshTree();
              // Toast 通知：同步完成/失败
              if (data.sync.status === 'completed') {
                showToast({
                  tone: 'success',
                  text: `${data.sync.docTypeName || '文档'}同步完成`,
                  holdMs: 4000,
                  actions: [{ label: '查看详情', onClick: () => {} }],
                });
              } else if (data.sync.status === 'failed') {
                showToast({ tone: 'error', text: '同步失败，请检查日志', holdMs: 5000 });
              }
            }
          } else {
            // Sync completed, fetch from history
            clearInterval(pollInterval);
            if (setSyncing) setSyncing(false);
            // Try to get the completed sync
            const histRes = await fetch(`${ROUTE}/sync-detail?id=${syncId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`);
            if (histRes.ok) {
              const histData = await histRes.json();
              if (histData.sync) {
                setCurrentSync(histData.sync);
              }
            }
            refreshTree();
          }
        }
      } catch (e) {
        console.error('Poll error:', e);
      }
    }, 1000);
    return pollInterval;
  };

  const handlePhasedSync = async () => {
    if (!canSync || syncing) return;
    setError(null);
    setView('progress');
    if (setSyncing) setSyncing(true);

    // Initialize with pending steps — only include session-related steps when sessions are selected
    const hasSessions = selectedSessions.length > 0;
    const steps = [
      { phase: 'init', label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconWrench, { size: 14 }), ' 同步检查'), status: 'running', text: '正在启动...', files: [], chunks: null },
      { phase: 'code_analysis', label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconCode, { size: 14 }), ' 代码差异分析'), status: 'pending', text: '', files: [], chunks: null },
      ...(hasSessions ? [
        { phase: 'discussion_analysis', label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconComment, { size: 14 }), ' 讨论差异分析'), status: 'pending', text: '', files: [], chunks: null },
      ] : []),
      { phase: 'merge', label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconMerge, { size: 14 }), ' 增量合并'), status: 'pending', text: '', files: [], chunks: null },
      { phase: 'validate', label: '补丁与字节校验', status: 'pending', text: '', files: [], chunks: null },
      { phase: 'publish', label: '一致性发布', status: 'pending', text: '', files: [], chunks: null },
    ];
    if (runAnalysis) steps.push({ phase: 'analysis', label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconBrain, { size: 14 }), ' 构建分析'), status: 'pending', text: '', files: [] });
    if (runIndex) steps.push({ phase: 'index', label: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconChart, { size: 14 }), ' 构建索引'), status: 'pending', text: '', files: [] });

    const initialSync = {
      id: `sync-${Date.now()}`,
      workspaceId,
      requirementId: selectedReq.id,
      docType: activeTab,
      docTypeName,
      sessionIds: selectedSessions,
      startedAt: Date.now(),
      status: 'running',
      steps,
      generatedFiles: [],
      runAnalysis,
      runIndex,
    };
    setCurrentSync(initialSync);

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
          sessionIds: selectedSessions,
          runAnalysis,
          runIndex,
        }),
      });

      // 检查响应类型
      const contentType = response.headers.get('content-type');

      // 如果返回 JSON，说明有正在进行的任务
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        if (data.skipped) {
          showToast({ text: data.message || '当前 commit 无需同步', holdMs: 3000 });
          setCurrentSync(null);
          setView('select');
          if (setSyncing) setSyncing(false);
          return;
        }
        if (data.active && data.sync) {
          setCurrentSync(data.sync);
          setView('progress');
          if (setSyncing) setSyncing(true);
          // 如果任务还在运行，开始轮询
          if (data.sync.status === 'running') {
            connectToSyncSSE(data.sync.id);
          }
        } else {
          throw new Error(data.error || data.message || '同步请求失败');
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // SSE 流处理
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const eventData = JSON.parse(line.slice(6));

            if (eventData.type === 'sync_started') {
              // Server confirms the actual syncId — update local state so abort uses the correct ID
              setCurrentSync(prev => prev ? { ...prev, id: eventData.syncId } : prev);
            } else if (eventData.type === 'chunk_status') {
              // Chunk-level subagent status update
              setCurrentSync(prev => {
                if (!prev) return prev;
                const newSteps = prev.steps.map(s => {
                  if (s.phase !== eventData.phase || !s.chunks) return s;
                  const newChunks = [...s.chunks];
                  if (newChunks[eventData.chunkIndex]) {
                    newChunks[eventData.chunkIndex] = {
                      ...newChunks[eventData.chunkIndex],
                      status: eventData.status,
                      sessionId: eventData.sessionId || newChunks[eventData.chunkIndex].sessionId,
                      error: eventData.error,
                    };
                  }
                  return { ...s, chunks: newChunks };
                });
                return { ...prev, steps: newSteps };
              });
            } else if (eventData.type === 'step') {
              // Update step in current sync
              setCurrentSync(prev => {
                if (!prev) return prev;
                const newSteps = prev.steps.map(s => {
                  if (s.phase === eventData.phase) {
                    return { ...s, ...eventData };
                  }
                  return s;
                });
                return { ...prev, steps: newSteps };
              });
            } else if (eventData.type === 'liveness') {
              // Liveness event — update the step's liveness info
              setCurrentSync(prev => {
                if (!prev) return prev;
                const newSteps = prev.steps.map(s => {
                  if (s.phase === eventData.phase) {
                    return {
                      ...s,
                      livenessStage: eventData.livenessStage,
                      lastActivityDesc: eventData.lastActivityDesc,
                      staleCount: eventData.staleCount,
                      stalenessDuration: eventData.stalenessDuration,
                    };
                  }
                  return s;
                });
                return { ...prev, steps: newSteps };
              });
            } else if (eventData.type === 'file') {
              // Add file to current sync
              setCurrentSync(prev => {
                if (!prev) return prev;
                const newGeneratedFiles = [...(prev.generatedFiles || []), { phase: eventData.phase, fileName: eventData.fileName }];
                const newSteps = prev.steps.map(s => {
                  if (s.phase === eventData.phase) {
                    return { ...s, files: [...(s.files || []), eventData.fileName] };
                  }
                  return s;
                });
                return { ...prev, generatedFiles: newGeneratedFiles, steps: newSteps };
              });
            } else if (eventData.type === 'done') {
              // Sync completed - fetch final state from server
              const detailRes = await fetch(`${ROUTE}/sync-detail?id=${eventData.syncId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`);
              if (detailRes.ok) {
                const detailData = await detailRes.json();
                if (detailData.sync) {
                  setCurrentSync(detailData.sync);
                }
              }
              if (setSyncing) setSyncing(false);
              refreshTree();
            } else if (eventData.type === 'error') {
              throw new Error(eventData.error);
            }
          } catch (e) {
            if (e.message && !e.message.includes('Failed to parse')) {
              console.error('SSE parse error:', e.message);
              setError(e.message);
              if (setSyncing) setSyncing(false);
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const eventData = JSON.parse(buffer.trim().replace(/^data: /, ''));
          if (eventData.type === 'done') {
            const detailRes = await fetch(`${ROUTE}/sync-detail?id=${eventData.syncId}&workspaceId=${workspaceId}&requirementId=${encodeURIComponent(selectedReq.id)}`);
            if (detailRes.ok) {
              const detailData = await detailRes.json();
              if (detailData.sync) {
                setCurrentSync(detailData.sync);
              }
            }
            if (setSyncing) setSyncing(false);
            refreshTree();
          }
        } catch { /* ignore */ }
      }
    } catch (e) {
      console.error('Phased sync failed:', e);
      setError(e.message || '分阶段同步失败');
      setView('select'); setCurrentSync(null);
      if (setSyncing) setSyncing(false);
    }
  };

  // Secondary page: viewing session turns
  if (viewingSession) {
    const session = sessions.find(s => s.id === viewingSession.id);
    return h(SessionTurnsView, {
      sessionId: viewingSession.id,
      sessionTitle: session?.title || '会话内容',
      onBack: () => setViewingSession(null),
    });
  }

  // Secondary page: viewing a file
  if (view === 'file' && viewingFile) {
    return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' }},
      h('div', { style: {
        padding: '8px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        flexShrink: 0,
      }},
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }},
          h('button', { className: 'rh-btn', onClick: () => {
            setViewingFile(null);
            setView('progress');
          }, style: { fontSize: 'var(--rh-font-size-sm)', padding: '3px 8px' } }, '← 返回'),
          h('span', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, flex: 1, display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconFile, { size: 14 }), ' ', viewingFile.split('/').pop())
        )
      ),
      h('div', { style: { flex: 1, overflow: 'hidden' }},
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
        setSyncing(false);
        setView('select');
        setCurrentSync(null);
      },
    });
  }

  // Main view: session selector + sync button
  return h('div', { className: 'rh-op-panel' },
    // Back button
    h('div', { className: 'rh-btn-stack', style: { marginBottom: 12 } },
      h('button', {
        className: 'rh-btn',
        onClick: onClose,
      }, '← 返回')
    ),

    h('div', { className: 'rh-op-info', style: { marginBottom: 12 } },
      h('div', null, '需求目录：', h('code', null, `${selectedReq.developer}/${selectedReq.id}`)),
      h('div', { style: { marginTop: 4, fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)' } },
        `同步${docTypeName}：代码差异分析 → 讨论差异分析 → 增量合并`)
    ),

    // Branch info display
    h('div', { style: {
      marginBottom: 12,
      padding: '8px 12px',
      background: 'var(--dsw-alias-bg-layer-2)',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      fontSize: 'var(--rh-font-size)'
    }},
      h('div', { className: 'rh-sync-branch-row', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }},
        h('span', { className: 'rh-sync-branch-label', style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', display: 'flex', alignItems: 'center', gap: 4 }}, h(IconMerge, { size: 14 }), ' 目标分支：'),
        h('code', { style: {
          flex: 1,
          color: branchInfo.targetBranch ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
          fontSize: 'var(--rh-font-size-sm)'
        }}, branchInfo.targetBranch || '未找到对应分支')
      ),
      h('div', { className: 'rh-sync-branch-row', style: { display: 'flex', alignItems: 'center', gap: 8 }},
        h('span', { className: 'rh-sync-branch-label', style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', display: 'flex', alignItems: 'center', gap: 4 }}, h(IconChart, { size: 14 }), ' 基准分支：'),
        h('input', { className: 'rh-search-input', 'aria-label': '同步基准分支', placeholder: '填写基准分支，如 main 或 origin/develop', value: baseBranch, disabled: syncing, onChange: event => { baseBranchEdited.current = true; setBaseBranch(event.target.value); } })
      ),
      !baseBranch.trim() && branchInfo.baseBranchHint && h('p', { className: 'rh-sync-hint', role: 'status' }, branchInfo.baseBranchHint),
      branchInfo.targetBranchError && h('p', { className: 'rh-error', role: 'alert' }, branchInfo.targetBranchError)
    ),

    h('section', { className: 'rh-sync-commits', 'aria-label': '选择同步提交' },
      h('div', { className: 'rh-sync-commits-heading' },
        h('strong', null, '选择代码提交'),
        h('span', { className: 'rh-sync-hint' }, `已选 ${selectedCommits.length} / ${availableCommits.length}`),
        h('button', { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !commitsReady || syncing, onClick: () => setSelectedCommits(availableCommits.map(commit => commit.hash)) }, '全选'),
        h('button', { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !commitsReady || syncing, onClick: () => setSelectedCommits([]) }, '清空'),
        h('button', { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !baseBranch.trim() || !branchInfo.targetBranch || syncing, onClick: () => setCommitRevision(value => value + 1) }, '刷新提交')),
      h('p', { className: 'rh-sync-hint' }, '仅展示目标分支包含、基准分支不包含的提交，默认全选。'),
      !branchInfo.targetBranch || !baseBranch.trim() ? h('p', { className: 'rh-sync-hint' }, '目标分支和基准分支都确定后显示 commit 列表。')
        : commitState.loading || !commitState.key ? h('p', { role: 'status', className: 'rh-sync-hint' }, '正在加载 commit…')
        : commitState.error ? h('p', { role: 'alert', className: 'rh-error' }, commitState.error)
        : commitsReady && h(React.Fragment, null,
          availableCommits.length > 0 && h('input', { className: 'rh-search-input', type: 'search', 'aria-label': '筛选提交', placeholder: '搜索提交信息、作者或 SHA…', value: commitSearch, onChange: event => setCommitSearch(event.target.value) }),
          h('div', { className: 'rh-sync-commit-list' }, visibleCommits.map(commit => h('label', { className: `rh-sync-commit${selectedCommits.includes(commit.hash) ? ' selected' : ''}`, key: commit.hash },
            h('input', { type: 'checkbox', checked: selectedCommits.includes(commit.hash), disabled: syncing, 'aria-label': `选择提交 ${commit.shortHash}`, onChange: event => setSelectedCommits(previous => event.target.checked ? [...previous, commit.hash] : previous.filter(hash => hash !== commit.hash)) }),
            h('span', { className: 'rh-sync-commit-content' },
              h('span', { className: 'rh-sync-commit-title', title: commit.subject }, h('code', null, commit.shortHash), ' ', commit.subject),
              h('span', { className: 'rh-sync-hint' }, `${commit.author} · ${new Date(commit.date).toLocaleString()}${commit.merge ? ' · 合并提交（相对第一父提交）' : ''}`))))),
          !availableCommits.length && h('p', { className: 'rh-sync-hint' }, '目标分支没有相对基准分支独有的提交。'),
          availableCommits.length > 0 && !visibleCommits.length && h('p', { className: 'rh-sync-hint' }, '没有符合筛选条件的提交。'),
          commitState.data.hasUncommitted && h('label', { className: 'rh-sync-working-option' }, h('input', { type: 'checkbox', checked: includeWorkingChanges, disabled: syncing, onChange: event => setIncludeWorkingChanges(event.target.checked) }), '包含当前工作区未提交改动'))),

    // Session selector
    h('div', { style: { marginBottom: 12 } },
      h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 6 } }, '选择相关会话（可选）'),
      h('input', {
        className: 'rh-search-input',
        type: 'text',
        placeholder: '搜索会话...',
        value: sessionSearch,
        onChange: (e) => setSessionSearch(e.target.value),
        style: { marginBottom: 6, fontSize: 'var(--rh-font-size-sm)' },
      }),
      loadingSessions
        ? h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)' } }, '加载中...')
        : sessions.length === 0
          ? h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', fontStyle: 'italic' } }, '未找到相关会话')
          : h('div', {
              style: {
                maxHeight: 200,
                overflow: 'auto',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 6,
              }
            },
            sessions.map(s =>
              h('div', {
                key: s.id,
                style: {
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                }
              },
                h('div', {
                  onClick: () => toggleSession(s.id),
                  style: {
                    padding: '8px 12px',
                    cursor: 'pointer',
                    fontSize: 'var(--rh-font-size)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: selectedSessions.includes(s.id) ? 'var(--rh-accent-bg)' : 'transparent',
                    color: selectedSessions.includes(s.id) ? 'var(--rh-accent)' : 'var(--dsw-alias-label-primary)',
                  }
                },
                  h('span', { style: { fontSize: 'var(--rh-font-size-title)', display: 'inline-flex' } }, selectedSessions.includes(s.id) ? h(IconCheckboxOn, { size: 14 }) : h(IconCheckboxOff, { size: 14 })),
                  h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 } }, s.title),
                  h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)' } },
                    `${s.eventCount || 0} 事件`
                  ),
                  h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', flexShrink: 0 } },
                    new Date(s.createdAt).toLocaleDateString()
                  ),
                  h('button', {
                    className: 'rh-btn rh-btn-secondary rh-btn-sm',
                    onClick: (e) => {
                      e.stopPropagation();
                      setViewingSession(s);
                    },
                  }, '查看内容')
                )
              )
            )
          ),
      selectedSessions.length > 0 && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
        `已选择 ${selectedSessions.length} 个会话`
      )
    ),

    // Post-sync options
    h('div', { style: { marginBottom: 12, padding: '10px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 6 } },
      h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 8 } }, '同步后操作'),
      h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, cursor: 'pointer', fontSize: 'var(--rh-font-size)' }
      },
        h('input', {
          type: 'checkbox',
          checked: runAnalysis,
          onChange: (e) => setRunAnalysis(e.target.checked),
          style: { cursor: 'pointer' }
        }),
        h('span', null, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconBrain, { size: 14 }), ' 构建分析（生成 .meta.json）'))
      ),
      h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--rh-font-size)' }
      },
        h('input', {
          type: 'checkbox',
          checked: runIndex,
          onChange: (e) => setRunIndex(e.target.checked),
          style: { cursor: 'pointer' }
        }),
        h('span', null, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconChart, { size: 14 }), ' 构建索引（重建搜索索引）'))
      )
    ),

    // Action buttons
    h('div', { style: { marginBottom: 12 } },
      h('button', {
        className: 'rh-btn rh-btn-primary',
        onClick: handlePhasedSync,
        disabled: syncing || !canSync,
        style: { width: '100%' },
      }, syncing ? '同步中...' : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconBrain, { size: 14 }), ` 开始同步${docTypeName}`))
    ),

    error && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } }, h(IconError, { size: 14 }), error),
  );
}

module.exports = { SyncPanel };
