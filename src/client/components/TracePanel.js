'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { createIconComponents } = require('../icons.js');

const { IconClipboard, IconDesign, IconSearch, IconFile, IconCheck, IconCalendar, IconClose } = createIconComponents(h);

const { ROUTE } = require('../constants.js');
const { SyncVersionCompare } = require('./shared/SyncVersionCompare.js');

// ─── EventDetailModal (改进 7: 事件详情弹窗) ─────────────────────
/**
 * @component
 * Modal dialog displaying detailed information about a timeline event,
 * including date, type, description, associated files, and commit hash.
 * Implements focus trap and ESC key to close.
 * @param {Object} props - Component props
 * @param {Object} props.event - The event object with title, date, type, description, files, and commitHash
 * @param {Function} props.onClose - Callback invoked to close the modal
 * @returns {JSX.Element|null}
 */
function EventDetailModal({ event, onClose }) {
  const dialogRef = React.useRef(null);

  // 焦点陷阱（对齐 DSH Modal 的 useModalLayer 行为）
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // 聚焦到对话框内第一个可聚焦元素
    const focusable = dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (first) first.focus();

    const handleTab = (e) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    dialog.addEventListener('keydown', handleTab);
    return () => dialog.removeEventListener('keydown', handleTab);
  }, []);

  // ESC 键关闭（对齐 DSH Modal 的 useModalLayer）
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!event) return null;

  const typeLabels = {
    requirement: '需求文档',
    design: '技术方案',
    cr: 'CR 文档',
    release: '发布',
    sync: '同步',
    other: '事件',
  };

  return h('div', {
    className: 'rh-event-detail-overlay',
    onClick: onClose,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': event.title || '事件详情',
  },
    h('div', {
      ref: dialogRef,
      className: 'rh-event-detail-dialog',
      onClick: e => e.stopPropagation(),
    },
      h('div', { className: 'rh-event-detail-header' },
        h('h3', { className: 'rh-event-detail-title' }, event.title || '事件详情'),
        h('button', {
          className: 'rh-event-detail-close',
          onClick: onClose,
          'aria-label': '关闭',
        }, h(IconClose, { size: 16 }))
      ),
      h('div', { className: 'rh-event-detail-body' },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('div', { style: { display: 'flex', gap: 8 } },
            h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', minWidth: 60 } }, '日期：'),
            h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, event.date)
          ),
          event.type && h('div', { style: { display: 'flex', gap: 8 } },
            h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', minWidth: 60 } }, '类型：'),
            h('span', {
              className: 'rh-badge rh-badge-md',
            }, typeLabels[event.type] || event.type)
          ),
          event.description && h('div', { style: { display: 'flex', gap: 8 } },
            h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', minWidth: 60 } }, '描述：'),
            h('span', { style: { color: 'var(--dsw-alias-label-primary)', lineHeight: 1.5 } }, event.description)
          ),
          event.files && event.files.length > 0 && h('div', { style: { display: 'flex', gap: 8 } },
            h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', minWidth: 60 } }, '文件：'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              event.files.map((file, i) =>
                h('span', {
                  key: i,
                  style: {
                    color: 'var(--rh-accent)',
                    fontSize: 'var(--rh-font-size)',
                    padding: '2px 6px',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    borderRadius: 4,
                  }
                }, file)
              )
            )
          ),
          event.commitHash && h('div', { style: { display: 'flex', gap: 8 } },
            h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', minWidth: 60 } }, '提交：'),
            h('code', {
              style: {
                color: 'var(--rh-accent)',
                background: 'var(--dsw-alias-bg-layer-2)',
                padding: '2px 6px',
                borderRadius: 4,
                fontSize: 'var(--rh-font-size-sm)',
              }
            }, event.commitHash.substring(0, 8))
          )
        )
      ),
      h('div', { className: 'rh-event-detail-footer' },
        h('button', {
          className: 'rh-btn rh-btn-primary',
          onClick: onClose,
        }, '关闭')
      )
    )
  );
}

// ─── Timeline (3.4, 3.5, 3.15) ──────────────────────────────────
/**
 * @component
 * Renders a vertical timeline of events for a requirement, with type-specific icons
 * and clickable items that open an EventDetailModal.
 * @param {Object} props - Component props
 * @param {Object} props.requirement - The requirement object containing meta.timeline array
 * @returns {JSX.Element}
 */
function Timeline({ requirement }) {
  const [selectedEvent, setSelectedEvent] = useState(null);

  if (!requirement?.meta?.timeline || requirement.meta.timeline.length === 0) {
    return h('div', { className: 'rh-empty', style: { padding: 20 } },
      h('span', { className: 'rh-empty-icon' }, h(IconCalendar, { size: 32 })),
      '暂无时间线数据'
    );
  }

  const typeIcons = {
    requirement: IconClipboard,
    design: IconDesign,
    cr: IconSearch,
    release: IconCheck,
  };

  return h('div', null,
    h('div', { className: 'rh-timeline' },
      requirement.meta.timeline.map((item, idx) =>
        h('div', {
          key: idx,
          className: 'rh-tl-item',
          onClick: () => setSelectedEvent(item),
          style: { cursor: 'pointer' }
        },
          h('div', { className: `rh-tl-dot ${item.type || 'other'}` },
            h(typeIcons[item.type] || IconFile, { size: 12 })
          ),
          h('div', { className: 'rh-tl-content' },
            h('div', { className: 'rh-tl-date' }, item.date),
            h('div', { className: 'rh-tl-title' }, item.title),
            item.description && h('div', { className: 'rh-tl-desc' }, item.description)
          )
        )
      )
    ),
    selectedEvent && h(EventDetailModal, {
      event: selectedEvent,
      onClose: () => setSelectedEvent(null),
    })
  );
}

// ─── TracePanel (right column default view) ─────────────────────
/**
 * @component
 * Right-column panel displaying traceability information for a selected requirement,
 * including developer info, analysis status, event timeline, and version history
 * with diff comparison support. Fetches and refreshes requirement metadata and
 * sync history from the server.
 * @param {Object} props - Component props
 * @param {Object|null} props.selectedReq - The currently selected requirement object
 * @param {string} props.workspaceId - The workspace ID for fetching data
 * @returns {JSX.Element}
 */
function TracePanel({ selectedReq, workspaceId }) {
  const [currentReq, setCurrentReq] = useState(selectedReq);
  const [loading, setLoading] = useState(false);
  const [syncHistory, setSyncHistory] = useState([]);
  const [syncTimeline, setSyncTimeline] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setSyncHistory([]); setSyncTimeline([]);
    if (selectedReq?.id && workspaceId) {
      fetch(`${ROUTE}/sync-history?workspaceId=${encodeURIComponent(workspaceId)}&requirementId=${encodeURIComponent(selectedReq.id)}`)
        .then(res => { if (!res.ok) throw new Error('读取同步记录失败'); return res.json(); })
        .then(data => { if (!cancelled) { setSyncHistory(data.history || []); setSyncTimeline(data.timeline || []); } })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [selectedReq?.id, workspaceId]);

  // Re-fetch requirement data when panel becomes visible or selectedReq changes
  useEffect(() => {
    if (!selectedReq || !workspaceId) {
      setCurrentReq(selectedReq);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Fetch the latest tree to get updated meta data
        const res = await fetch(`${ROUTE}/tree?workspaceId=${encodeURIComponent(workspaceId)}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            // Find the current requirement in the tree
            for (const dev of data.tree.developers) {
              for (const req of dev.requirements) {
                if (req.id === selectedReq.id) {
                  setCurrentReq({ ...req, developer: dev.name });
                  setLoading(false);
                  return;
                }
              }
            }
            // If not found, use the original selectedReq
            setCurrentReq(selectedReq);
          }
        }
      } catch (e) {
        console.error('Failed to refresh requirement data:', e);
        if (!cancelled) {
          setCurrentReq(selectedReq);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [selectedReq?.id, workspaceId]);

  if (!currentReq) {
    return h('div', { className: 'rh-empty', style: { padding: 20 } },
      h('span', { className: 'rh-empty-icon' }, h(IconSearch, { size: 32 })),
      '选择一个需求目录以查看追溯信息'
    );
  }

  return h('div', { className: 'rh-op-panel' },
    loading && h('div', { style: { textAlign: 'center', padding: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--rh-font-size-sm)' } }, '刷新中...'),
    h('div', { className: 'rh-op-info' },
      h('div', null, '开发者：', currentReq.developer),
      h('div', null, '日期：', currentReq.date),
      h('div', null, '文档数：', currentReq.fileCount),
      h('div', null, '分析状态：',
        currentReq.hasMeta
          ? h('span', { className: 'rh-badge rh-badge-success' }, '已分析')
          : h('span', { className: 'rh-badge rh-badge-warn' }, '未分析')
      ),
      currentReq.metaUpdatedAt && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } },
        '最后分析：', new Date(currentReq.metaUpdatedAt).toLocaleString())
    ),
    h(Timeline, { requirement: { ...currentReq, meta: { timeline: [
      ...(currentReq.meta?.timeline || []).filter(event => event.type !== 'sync'),
      ...syncTimeline,
    ].sort((a, b) => new Date(b.date) - new Date(a.date)) } } }),
    h(SyncVersionCompare, { history: syncHistory, workspaceId, requirementId: selectedReq.id })
  );
}

module.exports = { TracePanel };
