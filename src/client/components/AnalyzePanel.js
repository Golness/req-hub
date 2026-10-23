'use strict';

const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('./shared/HeaderBack.js');
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { createIconComponents } = require('../icons.js');
const { useAnalysis } = require('../hooks/useAnalysis.js');

const { IconRobot, IconSync, IconChart, IconError, IconCheck, IconHourglass, IconSkip, IconPackage } = createIconComponents(h);

/**
 * @component AnalyzePanel
 * @description Panel for AI-powered document analysis. Supports analyzing a single requirement
 * or performing full project analysis. Displays analysis status, preview files, meta information,
 * and AI provider configuration. Covers features 4.3, 4.4, 4.14-4.16.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The unique identifier of the workspace
 * @param {Object|null} props.selectedReq - The currently selected requirement object, or null if none selected
 * @param {Function} props.onClose - Callback invoked when the panel is closed
 * @returns {JSX.Element} The analysis panel UI with analysis controls, status display, and meta viewer
 */
function AnalyzePanel({ workspaceId, selectedReq, onClose }) {
  const [aiConfig, setAiConfig] = useState(null);
  const [previewFiles, setPreviewFiles] = useState([]);
  const [showMeta, setShowMeta] = useState(false);
  const [metaData, setMetaData] = useState(null);
  const [metaScope, setMetaScope] = useState('single'); // 'single' or 'all'
  const { analyzing, analysisMode, analysisStatus, error, success, startAnalysis, cancelAnalysis, restoreAnalysis } = useAnalysis(workspaceId, selectedReq);

  useEffect(() => {
    fetch(`${ROUTE}/ai-config`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setAiConfig(data); })
      .catch(() => {});

    // Check if there's an active analysis task
    fetch(`${ROUTE}/analysis-status`)
      .then(res => res.ok ? res.json() : null)
      .then(async (data) => {
        if (data && data.active) {
          const files = await restoreAnalysis(data);
          if (files.length > 0) {
            setPreviewFiles(files);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleAnalyzeSingle = () => {
    if (!selectedReq) return;
    // Get preview files first
    fetch(`${ROUTE}/analyze-preview?workspaceId=${encodeURIComponent(workspaceId)}&requirementId=${encodeURIComponent(selectedReq.id)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) setPreviewFiles(data.files || []);
        startAnalysis('single');
      })
      .catch(() => startAnalysis('single'));
  };

  const handleAnalyzeAll = () => {
    // Get preview files first
    fetch(`${ROUTE}/analyze-preview?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) setPreviewFiles(data.files || []);
        startAnalysis('all');
      })
      .catch(() => startAnalysis('all'));
  };

  const handleViewMeta = async (scope) => {
    setMetaScope(scope);
    setShowMeta(true);
    setMetaData(null);

    try {
      let url = `${ROUTE}/meta?workspaceId=${encodeURIComponent(workspaceId)}`;
      if (scope === 'single' && selectedReq) {
        url += `&path=${encodeURIComponent(selectedReq.id)}`;
      }
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setMetaData(data);
      } else {
        setMetaData({ error: '加载失败' });
      }
    } catch (e) {
      setMetaData({ error: e.message });
    }
  };

  // Meta viewer sub-component
  const MetaViewer = () => {
    if (!showMeta) return null;

    if (!metaData) {
      return h('div', { className: 'rh-op-panel' },
        h('div', { style: { textAlign: 'center', padding: 20 } }, '加载中...'),
        h(HeaderBack, { onBack: () => setShowMeta(false), label: '返回' })
      );
    }

    if (metaData.error) {
      return h('div', { className: 'rh-op-panel' },
        h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', padding: 20, display: 'flex', alignItems: 'center', gap: 8 } }, h(IconError, { size: 16 }), metaData.error),
        h(HeaderBack, { onBack: () => setShowMeta(false), label: '返回' })
      );
    }

    // Single meta view
    if (metaScope === 'single' && metaData.meta) {
      const meta = metaData.meta;
      return h('div', { className: 'rh-op-panel' },
        h('div', { className: 'rh-op-header' },
          h('span', null, 'Meta 详情')
        ),
        metaData.updatedAt && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 } },
          '更新时间：', new Date(metaData.updatedAt).toLocaleString()
        ),
        h('div', { className: 'rh-op-info' },
          h('div', null, '类型：', h('span', { style: { fontWeight: 600 } }, meta.type || 'unknown')),
          meta.summary && h('div', { style: { marginTop: 8 } }, '摘要：', meta.summary)
        ),
        meta.features && meta.features.length > 0 && h('div', { style: { marginTop: 12 } },
          h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 6 } }, '功能点'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            meta.features.map((f, i) => h('span', { key: i, className: 'rh-badge' }, f))
          )
        ),
        meta.fields && meta.fields.length > 0 && h('div', { style: { marginTop: 12 } },
          h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 6 } }, '字段'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            meta.fields.map((f, i) => h('code', { key: i, style: { padding: '2px 8px', fontSize: 'var(--rh-font-size-sm)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 4 } }, f))
          )
        ),
        meta.tags && meta.tags.length > 0 && h('div', { style: { marginTop: 12 } },
          h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 6 } }, '标签'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            meta.tags.map((t, i) => h('span', { key: i, className: 'rh-badge rh-badge-success' }, t))
          )
        ),
        meta.timeline && meta.timeline.length > 0 && h('div', { style: { marginTop: 12 } },
          h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 6 } }, '时间线'),
          h('div', { style: { fontSize: 'var(--rh-font-size-sm)' } },
            meta.timeline.map((t, i) => h('div', { key: i, style: { marginBottom: 8, paddingLeft: 12, borderLeft: '2px solid var(--dsw-alias-border-l1)' } },
              h('div', { style: { fontWeight: 600 } }, t.date, ' - ', t.title),
              t.description && h('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, t.description)
            ))
          )
        ),
        h(HeaderBack, { onBack: () => setShowMeta(false), label: '返回' })
      );
    }

    // All meta view
    if (metaScope === 'all' && metaData.items) {
      return h('div', { className: 'rh-op-panel' },
        h('div', { className: 'rh-op-header' },
          h('span', null, '全量 Meta（', metaData.items.length, ' 个需求）')
        ),
        h('div', { style: { maxHeight: 500, overflow: 'auto' } },
          metaData.items.map((item, idx) => h('div', { key: idx, style: { marginBottom: 16, padding: 12, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 6 } },
            h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 6 } },
              item.id, ' - ', item.title
            ),
            h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } },
              item.developer, ' | ', item.date
            ),
            item.meta.summary && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', marginBottom: 6 } }, item.meta.summary),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 'var(--rh-font-size-sm)' } },
              item.meta.type && h('span', { className: 'rh-badge' }, item.meta.type),
              item.meta.features && item.meta.features.slice(0, 3).map((f, i) => h('span', { key: i, className: 'rh-badge' }, f)),
              item.meta.features && item.meta.features.length > 3 && h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)' } }, `+${item.meta.features.length - 3}`)
            )
          ))
        ),
        h(HeaderBack, { onBack: () => setShowMeta(false), label: '返回' })
      );
    }

    return null;
  };

  if (showMeta) {
    return MetaViewer();
  }

  return h('div', { className: 'rh-op-panel' },
    // 4.14: Current requirement info
    selectedReq && h('div', { className: 'rh-req-card' },
      h('div', { className: 'rh-req-card-title' }, selectedReq.title),
      h('div', { className: 'rh-req-card-row' }, '开发者：', selectedReq.developer),
      h('div', { className: 'rh-req-card-row' }, '日期：', selectedReq.date),
      h('div', { className: 'rh-req-card-row' }, '文档数：', selectedReq.fileCount),
      h('div', { className: 'rh-req-card-row' }, '状态：',
        selectedReq.hasMeta
          ? h('span', { className: 'rh-badge rh-badge-success' }, '已分析')
          : h('span', { className: 'rh-badge rh-badge-warn' }, '未分析')
      ),
      // 4.15: Analysis timestamp
      selectedReq.metaUpdatedAt && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } },
        '最后分析：', new Date(selectedReq.metaUpdatedAt).toLocaleString())
    ),

    // 4.16: AI config display
    aiConfig && h('div', { className: 'rh-op-info' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h(IconRobot, { size: 14 }), ' Provider：', h('code', null, aiConfig.provider)),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, h(IconPackage, { size: 14 }), ' Model：', h('code', null, aiConfig.model))
    ),

    h('div', { className: 'rh-btn-stack', style: { marginBottom: 12 } },
      h('button', {
        className: `rh-btn${selectedReq ? ' rh-btn-primary' : ''}`,
        onClick: handleAnalyzeSingle,
        disabled: analyzing || !selectedReq
      }, analyzing && analysisMode === 'single' ? '分析中...' : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconSync, { size: 14 }), ' 分析当前需求')),
      h('button', {
        className: 'rh-btn',
        onClick: handleAnalyzeAll,
        disabled: analyzing
      }, analyzing && analysisMode === 'all' ? '分析中...' : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconSync, { size: 14 }), ' 项目全量分析')),
      analyzing && h('button', {
        className: 'rh-btn rh-btn-danger-outline',
        onClick: cancelAnalysis,
      }, '⛔ 终止分析'),
      h('button', { className: 'rh-btn', onClick: onClose }, '关闭')
    ),

    // Meta viewing buttons
    h('div', { className: 'rh-btn-stack', style: { marginBottom: 12 } },
      h('button', {
        className: 'rh-btn',
        onClick: () => handleViewMeta('single'),
        disabled: !selectedReq?.hasMeta
      }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconChart, { size: 14 }), ' 查看当前 Meta')),
      h('button', {
        className: 'rh-btn',
        onClick: () => handleViewMeta('all')
      }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconChart, { size: 14 }), ' 查看全量 Meta'))
    ),

    // Analysis file list with real-time status
    previewFiles.length > 0 && h('div', { className: 'rh-analysis-list' },
      h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
        `共 ${previewFiles.length} 个文件待分析`),
      previewFiles.map(file => {
        const status = analysisStatus[file.id] || { status: 'pending' };
        return h('div', { key: file.id, className: 'rh-analysis-item' },
          h('div', { className: 'rh-analysis-item-header' },
            h('div', { style: { flex: 1, overflow: 'hidden' } },
              h('div', { className: 'rh-analysis-item-name' },
                file.id,
                !file.hasDocs && h('span', { style: { color: 'var(--dsw-alias-label-secondary)', marginLeft: 8 } }, '(无文档)')
              ),
              h('div', { className: 'rh-analysis-item-path' }, `${file.developer} / ${file.path}`)
            ),
            h('span', { className: `rh-status-tag ${status.status}` },
              status.status === 'pending' && h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconHourglass, { size: 12 }), ' 等待分析'),
              status.status === 'analyzing' && h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconSync, { size: 12 }), ' 正在分析'),
              status.status === 'completed' && h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconCheck, { size: 12 }), ` 完成${status.elapsed ? ` (${status.elapsed}s)` : ''}`),
              status.status === 'failed' && h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconError, { size: 12 }), ' 失败'),
              status.status === 'cancelled' && h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconSkip, { size: 12 }), ' 已取消')
            )
          ),
          status.status === 'failed' && status.error && h('div', { className: 'rh-analysis-item-error' },
            `错误: ${status.error}`
          )
        );
      })
    ),

    error && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } }, h(IconError, { size: 14 }), error),
    success && h('div', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 8 } }, success)
  );
}

module.exports = { AnalyzePanel };
