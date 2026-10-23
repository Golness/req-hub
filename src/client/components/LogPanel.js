'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { createIconComponents } = require('../icons.js');

const { IconSearch, IconInfo, IconWarning, IconError } = createIconComponents(h);

/**
 * @component LogPanel
 * @description Panel for viewing and filtering application logs. Supports filtering by log level
 * (debug, info, warn, error) and by functional module tags. Features auto-refresh capability,
 * log level counts, and detailed log entry display with timestamps and attached data.
 * Covers features 4.9, 4.26.
 * @param {Object} props - Component props
 * @param {Function} props.onClose - Callback invoked when the panel is closed
 * @returns {JSX.Element} A log viewer panel with level/tag filters and a scrollable log list
 */
function LogPanel({ onClose }) {
  const [logs, setLogs] = useState([]);
  const [logMeta, setLogMeta] = useState({ levels: {}, tags: {} });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedLevels, setSelectedLevels] = useState(['info', 'warn', 'error']);
  const [selectedTags, setSelectedTags] = useState([]);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        // 并行获取日志和元数据
        const [logsRes, metaRes] = await Promise.all([
          fetch(`${ROUTE}/logs`),
          fetch(`${ROUTE}/logs/meta`)
        ]);

        if (logsRes.ok) {
          const data = await logsRes.json();
          setLogs(data.logs || []);
        }
        if (metaRes.ok) {
          const meta = await metaRes.json();
          setLogMeta({ levels: meta.levels || {}, tags: meta.tags || {} });
        }
      } catch (err) {
        console.error('Failed to fetch logs:', err);
      }
    };

    fetchLogs();

    if (autoRefresh) {
      const interval = setInterval(fetchLogs, 2000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh]);

  // 日志等级相关
  const getLevelIcon = (level) => {
    switch (level) {
      case 'debug': return h(IconSearch, { size: 14 });
      case 'info': return h(IconInfo, { size: 14 });
      case 'warn': return h(IconWarning, { size: 14 });
      case 'error': return h(IconError, { size: 14 });
      default: return h(IconInfo, { size: 14 });
    }
  };

  const getLevelColor = (level) => {
    switch (level) {
      case 'debug': return 'var(--dsw-alias-label-secondary)';
      case 'info': return 'var(--dsw-alias-state-info-primary)';
      case 'warn': return 'var(--dsw-alias-state-warning-primary)';
      case 'error': return 'var(--dsw-alias-state-error-primary)';
      default: return 'var(--dsw-alias-state-info-primary)';
    }
  };

  const getLevelLabel = (level) => {
    switch (level) {
      case 'debug': return 'Debug';
      case 'info': return 'Info';
      case 'warn': return 'Warn';
      case 'error': return 'Error';
      default: return level;
    }
  };

  // 统计各等级日志数量
  const levelCounts = logs.reduce((acc, log) => {
    const level = log.level || 'info';
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {});

  // 统计各标签日志数量
  const tagCounts = logs.reduce((acc, log) => {
    const tag = log.tag || 'startup';
    acc[tag] = (acc[tag] || 0) + 1;
    return acc;
  }, {});

  // 根据选中的等级和标签过滤日志
  // 等级筛选：必须至少选择一个等级才显示
  // 标签筛选：可选，不选则不参与过滤
  const filteredLogs = selectedLevels.length === 0
    ? [] // 没有选择等级，不显示任何日志
    : logs.filter(log => {
        const level = log.level || 'info';
        const tag = log.tag || 'startup';

        const levelMatch = selectedLevels.includes(level);
        const tagMatch = selectedTags.length === 0 || selectedTags.includes(tag);

        return levelMatch && tagMatch;
      });

  const toggleLevel = (level) => {
    setSelectedLevels(prev =>
      prev.includes(level)
        ? prev.filter(l => l !== level)
        : [...prev, level]
    );
  };

  const toggleTag = (tag) => {
    setSelectedTags(prev =>
      prev.includes(tag)
        ? prev.filter(t => t !== tag)
        : [...prev, tag]
    );
  };

  const selectAllLevels = () => {
    setSelectedLevels(['debug', 'info', 'warn', 'error']);
  };

  const clearAllLevels = () => {
    setSelectedLevels([]);
  };

  const clearAllTags = () => {
    setSelectedTags([]);
  };

  const resetFilters = () => {
    setSelectedLevels(['info', 'warn', 'error']);
    setSelectedTags([]);
  };

  // 判断是否有筛选条件变化
  const hasFilterChanges = selectedLevels.length !== 3 ||
    !selectedLevels.includes('info') ||
    !selectedLevels.includes('warn') ||
    !selectedLevels.includes('error') ||
    selectedTags.length > 0;

  return h('div', { className: 'rh-op-panel', role: 'log', 'aria-live': 'polite' },
    // 顶部工具栏
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--rh-font-size)' } },
          h('input', {
            type: 'checkbox',
            checked: autoRefresh,
            onChange: (e) => setAutoRefresh(e.target.checked)
          }),
          '自动刷新'
        ),
        h('button', {
          className: 'rh-btn rh-btn-secondary',
          onClick: async () => {
            try {
              await fetch(`${ROUTE}/logs/clear`, { method: 'POST' });
              setLogs([]);
            } catch (err) {
              console.error('Failed to clear logs:', err);
            }
          }
        }, '清空')
      ),
      hasFilterChanges && h('button', {
        className: 'rh-btn rh-btn-secondary',
        onClick: resetFilters
      }, '重置筛选')
    ),

    // 第一层：等级筛选器
    h('div', { style: { marginBottom: 12 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
        h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', fontWeight: 600 } },
          '日志等级：',
          selectedLevels.length > 0 ? `已选 ${selectedLevels.length}/${4}` : '请选择'
        ),
        h('div', { style: { display: 'flex', gap: 4 } },
          selectedLevels.length < 4 && h('button', {
            className: 'rh-btn rh-btn-secondary rh-btn-xs',
            onClick: selectAllLevels,
          }, '全选'),
          selectedLevels.length > 0 && h('button', {
            className: 'rh-btn rh-btn-secondary rh-btn-xs',
            onClick: clearAllLevels,
          }, '清除')
        )
      ),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        ['debug', 'info', 'warn', 'error'].map(level => {
          const isSelected = selectedLevels.includes(level);
          const count = levelCounts[level] || 0;
          return h('button', {
            key: level,
            className: 'rh-btn rh-btn-ghost rh-btn-pill',
            'aria-pressed': isSelected,
            onClick: () => toggleLevel(level),
            style: { '--rh-filter-color': getLevelColor(level) },
          }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            getLevelIcon(level),
            h('span', null, `${getLevelLabel(level)} (${count})`)
          ));
        })
      )
    ),

    // 第二层：标签筛选器
    h('div', { style: { marginBottom: 12 } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
        h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', fontWeight: 600 } },
          '功能模块：',
          selectedTags.length > 0 ? `已选 ${selectedTags.length}/${Object.keys(tagCounts).length}` : '全部'
        ),
        selectedTags.length > 0 && h('button', {
          className: 'rh-btn rh-btn-secondary rh-btn-xs',
          onClick: clearAllTags,
        }, '清除')
      ),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        Object.keys(tagCounts).sort().map(tag => {
          const isSelected = selectedTags.includes(tag);
          const count = tagCounts[tag] || 0;
          const tagLabel = logMeta.tags[tag] || tag;
          return h('button', {
            key: tag,
            className: 'rh-btn rh-btn-ghost rh-btn-pill',
            'aria-pressed': isSelected,
            onClick: () => toggleTag(tag),
          }, `${tagLabel} (${count})`);
        }),
        Object.keys(tagCounts).length === 0 && h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)' } }, '暂无标签')
      )
    ),

    // 日志列表
    h('div', { className: 'rh-log-list' },
      filteredLogs.length === 0
        ? h('div', { className: 'rh-empty' },
            logs.length === 0
              ? '暂无日志'
              : selectedLevels.length === 0
                ? '请至少选择一个日志等级'
                : '没有匹配的日志，请调整筛选条件')
        : filteredLogs.map((log, idx) =>
            h('div', {
              key: idx,
              className: 'rh-log-item',
              style: { borderLeft: `3px solid ${getLevelColor(log.level)}` }
            },
              h('div', { className: 'rh-log-item-header' },
                h('span', { className: 'rh-log-icon' }, getLevelIcon(log.level)),
                h('span', {
                  className: 'rh-log-time',
                  style: { color: getLevelColor(log.level) }
                }, new Date(log.timestamp).toLocaleTimeString()),
                h('span', {
                  className: 'rh-log-type',
                  style: {
                    background: 'var(--dsw-alias-bg-layer-3)',
                    color: 'var(--dsw-alias-label-secondary)'
                  }
                }, logMeta.tags[log.tag] || log.tag)
              ),
              h('div', { className: 'rh-log-message' }, log.message),
              // 显示附加数据（debug 级别的详细信息）
              log.data && h('div', {
                style: {
                  marginTop: 6,
                  padding: '6px 8px',
                  background: 'var(--dsw-alias-bg-layer-3)',
                  borderRadius: 4,
                  fontSize: 'var(--rh-font-size-sm)',
                  fontFamily: 'var(--rh-font-code)',
                  color: 'var(--dsw-alias-label-secondary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  maxHeight: 200,
                  overflowY: 'auto'
                }
              }, typeof log.data === 'object' ? JSON.stringify(log.data, null, 2) : String(log.data))
            )
          )
    )
  );
}

module.exports = { LogPanel };
