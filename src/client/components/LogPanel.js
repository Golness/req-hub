'use strict';
const { Checkbox } = require('./shared/controls.js');
const { t } = require('../locale.js');
const css = require('./LogPanel.module.css').default;
const { cssValue } = require('./shared/presentation.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');



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
    h('div', { className: css.row },
      h('div', { className: css.row2 },
        h('div', { className: css.row3 }, h(Checkbox, { checked: autoRefresh, onChange: checked => setAutoRefresh(checked), label: t("LogPanel.message001") })),
        h(Button, {
          className: 'rh-btn rh-btn-secondary',
          onClick: async () => {
            try {
              await fetch(`${ROUTE}/logs/clear`, { method: 'POST' });
              setLogs([]);
            } catch (err) {
              console.error('Failed to clear logs:', err);
            }
          }
        }, t("LogPanel.message002"))
      ),
      hasFilterChanges && h(Button, {
        className: 'rh-btn rh-btn-secondary',
        onClick: resetFilters
      }, t("LogPanel.message003"))
    ),

    // 第一层：等级筛选器
    h('div', { className: css.spacing },
      h('div', { className: css.row4 },
        h('span', { className: css.heading },
          t("LogPanel.message004"),
          selectedLevels.length > 0 ? t("LogPanel.message005", { value0: selectedLevels.length, value1: 4 }) : t("common.select")
        ),
        h('div', { className: css.row5 },
          selectedLevels.length < 4 && h(Button, {
            className: 'rh-btn rh-btn-secondary rh-btn-sm',
            onClick: selectAllLevels,
          }, t("LogPanel.message007")),
          selectedLevels.length > 0 && h(Button, {
            className: 'rh-btn rh-btn-secondary rh-btn-sm',
            onClick: clearAllLevels,
          }, t("LogPanel.message008"))
        )
      ),
      h('div', { className: css.row6 },
        ['debug', 'info', 'warn', 'error'].map(level => {
          const isSelected = selectedLevels.includes(level);
          const count = levelCounts[level] || 0;
          return h(Button, {
            key: level,
            className: 'rh-btn rh-btn-ghost rh-btn-pill',
            'aria-pressed': isSelected,
            onClick: () => toggleLevel(level),
            style: { '--rh-filter-color': getLevelColor(level) },
          }, h('span', { className: css.row7 },
            h('span', null, `${getLevelLabel(level)} (${count})`)
          ));
        })
      )
    ),

    // 第二层：标签筛选器
    h('div', { className: css.spacing },
      h('div', { className: css.row4 },
        h('span', { className: css.heading },
          t("LogPanel.message009"),
          selectedTags.length > 0 ? t("LogPanel.message005", { value0: selectedTags.length, value1: Object.keys(tagCounts).length }) : t("FileTreeSidebar.message017")
        ),
        selectedTags.length > 0 && h(Button, {
          className: 'rh-btn rh-btn-secondary rh-btn-sm',
          onClick: clearAllTags,
        }, t("LogPanel.message008"))
      ),
      h('div', { className: css.row6 },
        Object.keys(tagCounts).sort().map(tag => {
          const isSelected = selectedTags.includes(tag);
          const count = tagCounts[tag] || 0;
          const tagLabel = logMeta.tags[tag] || tag;
          return h(Button, {
            key: tag,
            className: 'rh-btn rh-btn-ghost rh-btn-pill',
            'aria-pressed': isSelected,
            onClick: () => toggleTag(tag),
          }, `${tagLabel} (${count})`);
        }),
        Object.keys(tagCounts).length === 0 && h('span', { className: css.mutedText }, t("LogPanel.message010"))
      )
    ),

    // 日志列表
    h('div', { className: 'rh-log-list' },
      filteredLogs.length === 0
        ? h('div', { className: 'rh-empty' },
            logs.length === 0
              ? t("LogPanel.message011")
              : selectedLevels.length === 0
                ? t("LogPanel.message012")
                : t("LogPanel.message013"))
        : filteredLogs.map((log, idx) =>
            h('div', {
              key: idx,
              className: ('rh-log-item') + ' ' + css.content,
              style: { "--rh-border-left-0": cssValue(`3px solid ${getLevelColor(log.level)}`) }
            },
              h('div', { className: 'rh-log-item-header' },

                h('span', {
                  className: ('rh-log-time') + ' ' + css.content2,
                  style: { "--rh-color-0": cssValue(getLevelColor(log.level)) }
                }, new Date(log.timestamp).toLocaleTimeString()),
                h('span', {
                  className: ('rh-log-type') + ' ' + css.mutedText2
                }, logMeta.tags[log.tag] || log.tag)
              ),
              h('div', { className: 'rh-log-message' }, log.message),
              // 显示附加数据（debug 级别的详细信息）
              log.data && h('div', {
                className: css.mutedText3
              }, typeof log.data === 'object' ? JSON.stringify(log.data, null, 2) : String(log.data))
            )
          )
    )
  );
}

module.exports = { LogPanel };
