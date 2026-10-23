'use strict';

const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('./shared/HeaderBack.js');
const { useState } = React;
const { ROUTE } = require('../constants.js');
const { createIconComponents } = require('../icons.js');

const { IconClipboard, IconChart, IconFile, IconSearch, IconCheck, IconTarget, IconDatabase, IconTag, IconWrench } = createIconComponents(h);

/**
 * @component IndexPanel
 * @description Panel for managing and viewing the search index. Displays index status, statistics
 * (requirements, features, fields, tags), and provides options to rebuild the index,
 * view structured index data, or view the raw index file. Covers features 4.5, 4.17-4.20.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The unique identifier of the workspace
 * @param {Object|null} props.indexStatus - The current index status with built flag, timestamp, and stats
 * @param {Function} props.onRefresh - Callback invoked to refresh the index status after rebuild
 * @param {Function} props.onClose - Callback invoked when the panel is closed
 * @returns {JSX.Element} An index management panel with status, stats, and viewer options
 */
function IndexPanel({ workspaceId, indexStatus, onRefresh, onClose }) {
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [showIndexFile, setShowIndexFile] = useState(false);
  const [indexContent, setIndexContent] = useState(null);
  const [showStructuredIndex, setShowStructuredIndex] = useState(false);
  const [indexData, setIndexData] = useState(null);

  const handleRebuild = async () => {
    setRebuilding(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`${ROUTE}/rebuild-index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '重建失败');
      } else {
        setSuccess(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconCheck, { size: 14 }), ` 索引重建完成 (${data.elapsed}s)`));
        if (onRefresh) onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRebuilding(false);
    }
  };

  const handleViewIndex = async () => {
    try {
      const res = await fetch(`${ROUTE}/read?workspaceId=${encodeURIComponent(workspaceId)}&path=.index/search-index.json`);
      if (res.ok) {
        const data = await res.json();
        setIndexContent(data.text);
        setShowIndexFile(true);
      } else {
        setError('读取索引文件失败');
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleViewStructuredIndex = async () => {
    setShowStructuredIndex(true);
    setIndexData(null);
    try {
      const res = await fetch(`${ROUTE}/index-data?workspaceId=${encodeURIComponent(workspaceId)}`);
      if (res.ok) {
        const data = await res.json();
        setIndexData(data);
      } else {
        setIndexData({ error: '加载失败' });
      }
    } catch (e) {
      setIndexData({ error: e.message });
    }
  };

  // Structured index viewer
  const IndexViewer = () => {
    if (!showStructuredIndex) return null;

    if (!indexData) {
      return h('div', { className: 'rh-op-panel' },
        h('div', { style: { textAlign: 'center', padding: 20 } }, '加载中...'),
        h(HeaderBack, { onBack: () => setShowStructuredIndex(false), label: '返回' })
      );
    }

    if (indexData.error) {
      return h('div', { className: 'rh-op-panel' },
        h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', padding: 20 } }, indexData.error),
        h(HeaderBack, { onBack: () => setShowStructuredIndex(false), label: '返回' })
      );
    }

    const reqs = indexData.requirements || [];
    const featureIndex = indexData.featureIndex || {};
    const fieldIndex = indexData.fieldIndex || {};
    const tagIndex = indexData.tagIndex || {};

    return h('div', { className: 'rh-op-panel' },
      h('div', { className: 'rh-op-header' },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconChart, { size: 14 }), ' 索引详情')
      ),
      indexData.builtAt && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 } },
        '构建时间：', new Date(indexData.builtAt).toLocaleString()
      ),

      // Requirements list
      h('div', { style: { marginBottom: 16 } },
        h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 8 } }, h(IconClipboard, { size: 14 }), ' 需求列表（', reqs.length, '）'),
        h('div', { style: { maxHeight: 200, overflow: 'auto' } },
          reqs.map((req, i) => h('div', { key: i, style: { marginBottom: 8, padding: 8, background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 4, fontSize: 'var(--rh-font-size-sm)' } },
            h('div', { style: { fontWeight: 600 } }, req.id, ' - ', req.title),
            h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } },
              req.developer, ' | ', req.date, ' | ', req.type
            ),
            req.summary && h('div', { style: { marginTop: 4 } }, req.summary)
          ))
        )
      ),

      // Feature index
      Object.keys(featureIndex).length > 0 && h('div', { style: { marginBottom: 16 } },
        h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 } }, h(IconTarget, { size: 14 }), ' 功能点索引（', Object.keys(featureIndex).length, '）'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          Object.entries(featureIndex).map(([feature, reqIds]) =>
            h('div', { key: feature, style: { padding: '4px 8px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 4, fontSize: 'var(--rh-font-size-sm)' } },
              h('div', { style: { fontWeight: 600 } }, feature),
              h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--rh-font-size-sm)' } }, reqIds.length, ' 个需求')
            )
          )
        )
      ),

      // Field index
      Object.keys(fieldIndex).length > 0 && h('div', { style: { marginBottom: 16 } },
        h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 } }, h(IconDatabase, { size: 14 }), ' 字段索引（', Object.keys(fieldIndex).length, '）'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          Object.entries(fieldIndex).map(([field, reqIds]) =>
            h('code', { key: field, style: { padding: '4px 8px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 4, fontSize: 'var(--rh-font-size-sm)' } },
              field, ' (', reqIds.length, ')'
            )
          )
        )
      ),

      // Tag index
      Object.keys(tagIndex).length > 0 && h('div', { style: { marginBottom: 16 } },
        h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 } }, h(IconTag, { size: 14 }), ' 标签索引（', Object.keys(tagIndex).length, '）'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          Object.entries(tagIndex).map(([tag, reqIds]) =>
            h('span', { key: tag, className: 'rh-badge rh-badge-success', style: { fontSize: 'var(--rh-font-size-sm)' } },
              tag, ' (', reqIds.length, ')'
            )
          )
        )
      ),

      h(HeaderBack, { onBack: () => setShowStructuredIndex(false), label: '返回' })
    );
  };

  if (showStructuredIndex) {
    return IndexViewer();
  }

  if (showIndexFile && indexContent) {
    return h('div', { className: 'rh-op-panel' },
      h('pre', {
        style: {
          background: 'var(--dsw-alias-bg-layer-2)',
          padding: 12,
          borderRadius: 6,
          fontSize: 'var(--rh-font-size-sm)',
          maxHeight: 400,
          overflow: 'auto',
          fontFamily: 'var(--rh-font-code)',
        }
      }, indexContent),
      h(HeaderBack, { onBack: () => setShowIndexFile(false), label: '返回' })
    );
  }

  return h('div', { className: 'rh-op-panel' },
    // 4.17: Index status
    h('div', { className: 'rh-op-info' },
      h('div', null, '状态：',
        indexStatus?.built
          ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary)', fontWeight: 600 } }, '已构建')
          : h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '未构建')
      ),
      // 4.18: Build time
      indexStatus?.builtAt && h('div', null, '构建时间：', new Date(indexStatus.builtAt).toLocaleString())
    ),

    // 4.19: Statistics grid
    indexStatus?.stats && h('div', { className: 'rh-stats-grid' },
      h('div', { className: 'rh-stats-cell' }, '需求数：', h('strong', null, indexStatus.stats.requirements)),
      h('div', { className: 'rh-stats-cell' }, '功能点：', h('strong', null, indexStatus.stats.features)),
      h('div', { className: 'rh-stats-cell' }, '字段数：', h('strong', null, indexStatus.stats.fields)),
      h('div', { className: 'rh-stats-cell' }, '标签数：', h('strong', null, indexStatus.stats.tags))
    ),

    h('div', { className: 'rh-btn-stack', style: { marginBottom: 12 } },
      h('button', {
        className: 'rh-btn rh-btn-primary',
        onClick: handleRebuild,
        disabled: rebuilding
      }, rebuilding ? '重建中...' : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconWrench, { size: 14 }), ' 重建索引')),
      // 4.20: View index file
      h('button', {
        className: 'rh-btn',
        onClick: handleViewStructuredIndex,
        disabled: !indexStatus?.built
      }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconChart, { size: 14 }), ' 查看索引详情')),
      h('button', {
        className: 'rh-btn',
        onClick: handleViewIndex,
        disabled: !indexStatus?.built
      }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconFile, { size: 14 }), ' 查看原始文件'))
    ),

    error && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 8 } }, error),
    success && h('div', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 8 } }, success)
  );
}

module.exports = { IndexPanel };
