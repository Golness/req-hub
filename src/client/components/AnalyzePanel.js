'use strict';
const { t } = require('../locale.js');
const css = require('./AnalyzePanel.module.css').default;
const { Button } = require('./shared/Button.js');

const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('./shared/HeaderBack.js');
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { useAnalysis } = require('../hooks/useAnalysis.js');

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
        setMetaData({ error: t("AnalyzePanel.message001") });
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
        h('div', { className: css.centered }, t("common.loading")),
        h(HeaderBack, { onBack: () => setShowMeta(false), label: t("common.back") })
      );
    }

    if (metaData.error) {
      return h('div', { className: 'rh-op-panel' },
        h('div', { className: css.row }, metaData.error),
        h(HeaderBack, { onBack: () => setShowMeta(false), label: t("common.back") })
      );
    }

    // Single meta view
    if (metaScope === 'single' && metaData.meta) {
      const meta = metaData.meta;
      return h('div', { className: 'rh-op-panel' },
        h('div', { className: 'rh-op-header' },
          h('span', null, t("AnalyzePanel.message004"))
        ),
        metaData.updatedAt && h('div', { className: css.mutedText },
          t("AnalyzePanel.message005"), new Date(metaData.updatedAt).toLocaleString()
        ),
        h('div', { className: 'rh-op-info' },
          h('div', null, t("AnalyzePanel.message006"), h('span', { className: css.heading }, meta.type || 'unknown')),
          meta.summary && h('div', { className: css.spacing }, t("AnalyzePanel.message007"), meta.summary)
        ),
        meta.features && meta.features.length > 0 && h('div', { className: css.spacing2 },
          h('div', { className: css.heading2 }, t("AnalyzePanel.message008")),
          h('div', { className: css.row2 },
            meta.features.map((f, i) => h('span', { key: i, className: 'rh-badge' }, f))
          )
        ),
        meta.fields && meta.fields.length > 0 && h('div', { className: css.spacing2 },
          h('div', { className: css.heading2 }, t("AnalyzePanel.message009")),
          h('div', { className: css.row2 },
            meta.fields.map((f, i) => h('code', { key: i, className: css.section }, f))
          )
        ),
        meta.tags && meta.tags.length > 0 && h('div', { className: css.spacing2 },
          h('div', { className: css.heading2 }, t("AnalyzePanel.message010")),
          h('div', { className: css.row2 },
            meta.tags.map((t, i) => h('span', { key: i, className: 'rh-badge rh-badge-success' }, t))
          )
        ),
        meta.timeline && meta.timeline.length > 0 && h('div', { className: css.spacing2 },
          h('div', { className: css.heading2 }, t("AnalyzePanel.message011")),
          h('div', { className: css.content },
            meta.timeline.map((t, i) => h('div', { key: i, className: css.spacing3 },
              h('div', { className: css.heading }, t.date, ' - ', t.title),
              t.description && h('div', { className: css.mutedText2 }, t.description)
            ))
          )
        ),
        h(HeaderBack, { onBack: () => setShowMeta(false), label: t("common.back") })
      );
    }

    // All meta view
    if (metaScope === 'all' && metaData.items) {
      return h('div', { className: 'rh-op-panel' },
        h('div', { className: 'rh-op-header' },
          h('span', null, t("AnalyzePanel.message012"), metaData.items.length, t("AnalyzePanel.message013"))
        ),
        h('div', { className: css.pane },
          metaData.items.map((item, idx) => h('div', { key: idx, className: css.section2 },
            h('div', { className: css.heading2 },
              item.id, ' - ', item.title
            ),
            h('div', { className: css.mutedText3 },
              item.developer, ' | ', item.date
            ),
            item.meta.summary && h('div', { className: css.spacing4 }, item.meta.summary),
            h('div', { className: css.row3 },
              item.meta.type && h('span', { className: 'rh-badge' }, item.meta.type),
              item.meta.features && item.meta.features.slice(0, 3).map((f, i) => h('span', { key: i, className: 'rh-badge' }, f)),
              item.meta.features && item.meta.features.length > 3 && h('span', { className: css.mutedText4 }, `+${item.meta.features.length - 3}`)
            )
          ))
        ),
        h(HeaderBack, { onBack: () => setShowMeta(false), label: t("common.back") })
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
      h('div', { className: 'rh-req-card-row' }, t("AnalyzePanel.message014"), selectedReq.developer),
      h('div', { className: 'rh-req-card-row' }, t("AnalyzePanel.message015"), selectedReq.date),
      h('div', { className: 'rh-req-card-row' }, t("AnalyzePanel.message016"), selectedReq.fileCount),
      h('div', { className: 'rh-req-card-row' }, t("AnalyzePanel.message017"),
        selectedReq.hasMeta
          ? h('span', { className: 'rh-badge rh-badge-success' }, t("AnalyzePanel.message018"))
          : h('span', { className: 'rh-badge rh-badge-warn' }, t("AnalyzePanel.message019"))
      ),
      // 4.15: Analysis timestamp
      selectedReq.metaUpdatedAt && h('div', { className: css.mutedText5 },
        t("AnalyzePanel.message020"), new Date(selectedReq.metaUpdatedAt).toLocaleString())
    ),

    // 4.16: AI config display
    aiConfig && h('div', { className: 'rh-op-info' },
      h('div', { className: css.row4 }, t("common.providerLabel"), h('code', null, aiConfig.provider)),
      h('div', { className: css.row4 }, t("common.modelLabel"), h('code', null, aiConfig.model))
    ),

    h('div', { className: ('rh-btn-stack') + ' ' + css.spacing5 },
      h(Button, {
        className: `rh-btn${selectedReq ? ' rh-btn-primary' : ''}`,
        onClick: handleAnalyzeSingle,
        disabled: analyzing || !selectedReq
      }, analyzing && analysisMode === 'single' ? t("AnalyzePanel.message021") : t("AnalyzePanel.message022")),
      h(Button, {
        className: 'rh-btn',
        onClick: handleAnalyzeAll,
        disabled: analyzing
      }, analyzing && analysisMode === 'all' ? t("AnalyzePanel.message021") : t("AnalyzePanel.message023")),
      analyzing && h(Button, {
        className: 'rh-btn rh-btn-danger-outline',
        onClick: cancelAnalysis,
      }, t("AnalyzePanel.message024")),
      h(Button, { className: 'rh-btn', onClick: onClose }, t("common.close"))
    ),

    // Meta viewing buttons
    h('div', { className: ('rh-btn-stack') + ' ' + css.spacing5 },
      h(Button, {
        className: 'rh-btn',
        onClick: () => handleViewMeta('single'),
        disabled: !selectedReq?.hasMeta
      }, t("AnalyzePanel.message026")),
      h(Button, {
        className: 'rh-btn',
        onClick: () => handleViewMeta('all')
      }, t("AnalyzePanel.message027"))
    ),

    // Analysis file list with real-time status
    previewFiles.length > 0 && h('div', { className: 'rh-analysis-list' },
      h('div', { className: css.mutedText6 },
        t("AnalyzePanel.message028", { value0: previewFiles.length })),
      previewFiles.map(file => {
        const status = analysisStatus[file.id] || { status: 'pending' };
        return h('div', { key: file.id, className: 'rh-analysis-item' },
          h('div', { className: 'rh-analysis-item-header' },
            h('div', { className: css.pane2 },
              h('div', { className: 'rh-analysis-item-name' },
                file.id,
                !file.hasDocs && h('span', { className: css.mutedText7 }, t("AnalyzePanel.message029"))
              ),
              h('div', { className: 'rh-analysis-item-path' }, `${file.developer} / ${file.path}`)
            ),
            h('span', { className: `rh-status-tag ${status.status}` },
              status.status === 'pending' && t("AnalyzePanel.message030"),
              status.status === 'analyzing' && t("AnalyzePanel.message031"),
              status.status === 'completed' && h('span', { className: css.row5 }, t("AnalyzePanel.message032", { value0: status.elapsed ? ` (${status.elapsed}s)` : '' })),
              status.status === 'failed' && t("AnalyzePanel.message033"),
              status.status === 'cancelled' && t("AnalyzePanel.message034")
            )
          ),
          status.status === 'failed' && status.error && h('div', { className: 'rh-analysis-item-error' },
            t("AnalyzePanel.message035", { value0: status.error })
          )
        );
      })
    ),

    error && h('div', { className: css.row6 }, error),
    success && h('div', { className: css.spacing6 }, success)
  );
}

module.exports = { AnalyzePanel };
