'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;

const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');
const { createIconComponents } = require('../icons.js');

const { IconRobot, IconError } = createIconComponents(h);

// ─── TemplatesPanel ──────────────────────────────────────────────
// Templates with tabs: 需求 (Requirement), 方案 (Design), CR
/**
 * @component
 * Tabbed templates panel that provides document template generation for
 * requirement docs, design docs, and CR docs. Switches between three
 * template types via tab buttons.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The workspace ID for template generation
 * @param {string} props.docsDir - The docs directory path
 * @param {Object} props.selectedReq - The currently selected requirement object
 * @param {Function} props.onClose - Callback invoked to close the panel
 * @returns {JSX.Element}
 */
function TemplatesPanel({ workspaceId, docsDir, selectedReq, activeTab, onClose }) {
  return h('div', { className: 'rh-op-panel' },
    // Tab content
    h(TemplatePanel, { workspaceId, docsDir, selectedReq, docType: activeTab || 'requirement', onClose })
  );
}

// ─── TemplatePanel ───────────────────────────────────────────────
// Covers: 4.6, 4.7, 4.8, 4.11, 4.21, 4.22
// Templates are fetched from server to avoid duplication
/**
 * @component
 * Single template panel for a specific document type. Fetches template definitions
 * from the server and provides static and AI-powered template generation.
 * Displays target path, output file name, generation buttons, and template preview.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The workspace ID
 * @param {string} props.docsDir - The docs directory path
 * @param {Object} props.selectedReq - The currently selected requirement object
 * @param {string} props.docType - The document type ('requirement', 'design', or 'cr')
 * @param {Function} props.onClose - Callback invoked to close the panel
 * @returns {JSX.Element}
 */
function TemplatePanel({ workspaceId, docsDir, selectedReq, docType, onClose }) {
  const [templates, setTemplates] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingAI, setLoadingAI] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const { refreshTree } = React.useContext(DocsViewerContext);

  // Fetch templates from server on mount
  useEffect(() => {
    fetch(`${ROUTE}/templates`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setTemplates(data); })
      .catch(() => {});
  }, []);

  const tmpl = templates?.[docType];

  // Show loading while templates are being fetched
  if (!tmpl) {
    return h('div', { className: 'rh-op-panel' },
      h('div', { className: 'rh-loading' }, '加载模板...')
    );
  }

  if (!selectedReq) {
    return h('div', { className: 'rh-op-panel' },
      h('div', { style: { color: 'var(--dsw-alias-state-warning-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 12 } },
        '请先在左侧目录树中选择一个需求目录'),
      h('button', { className: 'rh-btn', onClick: onClose }, '关闭')
    );
  }

  const targetPath = `${docsDir}/${selectedReq.developer}/${selectedReq.id}/`;

  // 4.6-4.8: Static template generation
  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${ROUTE}/generate-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, requirementId: selectedReq.id, docType, useAI: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || '生成失败');
      } else {
        setSuccess(`模板已生成: ${data.fileName}`);
        refreshTree();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // 4.23: AI template generation
  const handleGenerateAI = async () => {
    setLoadingAI(true);
    setError(null);
    try {
      const res = await fetch(`${ROUTE}/generate-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, requirementId: selectedReq.id, docType, useAI: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'AI 生成失败');
      } else {
        setSuccess(`AI 模板已生成: ${data.fileName}`);
        refreshTree();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingAI(false);
    }
  };

  return h('div', { className: 'rh-op-panel' },
    // 4.21: Target info
    h('div', { className: 'rh-op-info' },
      h('div', null, '目标目录：', h('code', null, targetPath)),
      h('div', { style: { marginTop: 4 } }, '输出文件：', h('code', null, tmpl.fileName))
    ),

    // 4.22, 4.23: Generation buttons
    h('div', { className: 'rh-btn-stack', style: { marginBottom: 12 } },
      h('button', { className: 'rh-btn rh-btn-primary', onClick: handleGenerate, disabled: loading || loadingAI },
        loading ? '生成中...' : `${tmpl.icon} 生成模板`),
      h('button', { className: 'rh-btn', onClick: handleGenerateAI, disabled: loading || loadingAI },
        loadingAI ? 'AI 生成中...' : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconRobot, { size: 14 }), ' 用 AI 生成 ', h('span', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--rh-accent)' } }, 'ctx.llm'))),
      h('button', { className: 'rh-btn', onClick: onClose }, '关闭')
    ),

    error && h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 } }, h(IconError, { size: 14 }), error),
    success && h('div', { style: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 'var(--rh-font-size)', marginBottom: 8 } }, success),

    // 4.22: Template preview
    h('div', { style: { fontSize: 'var(--rh-font-size)', fontWeight: 600, marginBottom: 8 } }, '模板预览'),
    h('div', { className: 'rh-template-preview' }, tmpl.content)
  );
}

module.exports = { TemplatesPanel };
