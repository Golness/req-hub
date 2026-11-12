'use strict';
const React = require('react');
const { t, hasLocaleKey } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { EmptyState } = require('../shared/EmptyState.js');
const { showToast } = require('../shared/ToastContainer.js');
const {
  knowledgeV2Request,
  knowledgeV2ErrorText,
} = require('../../hooks/useKnowledgeV2.js');
const css = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;

/**
 * Run structural lint immediately or semantic lint as a watched model job.
 * @param props - Workspace identity, the shared job list and page navigation.
 * @returns The rendered component content.
 */
function LintPanel({ workspaceId, jobs, onOpenPage }) {
  const [findings, setFindings] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [semanticJobId, setSemanticJobId] = React.useState(null);
  const run = async (mode) => {
    setBusy(true);
    setError(null);
    try {
      const data = await knowledgeV2Request('/lint', workspaceId, {
        mode,
        requestKey: crypto.randomUUID(),
      });
      if (mode === 'structural') {
        setFindings(data.findings);
      } else {
        setSemanticJobId(data.job.id);
        showToast({ tone: 'info', text: t('kb.lint.queued') });
        jobs.refresh();
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  React.useEffect(() => {
    if (!semanticJobId) {
      return;
    }
    const job = jobs.jobs.find((item) => item.id === semanticJobId);
    if (!job) {
      return;
    }
    if (job.status === 'completed') {
      setSemanticJobId(null);
      setFindings(job.findings || []);
      showToast({
        tone: 'success',
        text: t('kb.lint.semanticDone', { count: (job.findings || []).length }),
      });
    } else if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
      setSemanticJobId(null);
      if (job.status === 'failed') {
        setError(job.error || { code: 'KB_INTERNAL' });
      }
    }
  }, [jobs.jobs, semanticJobId]);
  const semanticRunning =
    semanticJobId !== null ||
    jobs.jobs.some((job) => job.kind === 'lint' && ['queued', 'running', 'cancelling'].includes(job.status));
  const errors = (findings || []).filter((item) => item.level === 'error').length;
  const warnings = (findings || []).filter((item) => item.level === 'warning').length;
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: css.toolbar },
      h(
        Button,
        { variant: 'primary', size: 'sm', disabled: busy || semanticRunning, onClick: () => run('structural') },
        t('kb.lint.structural'),
      ),
      h(
        Button,
        { variant: 'outline', size: 'sm', disabled: busy || semanticRunning, onClick: () => run('semantic') },
        t('kb.lint.semantic'),
      ),
      findings &&
        h(
          'span',
          { className: css.muted, role: 'status' },
          t('kb.lint.count', { errors, warnings }),
        ),
    ),
    error && h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(error)),
    h(
      'div',
      { className: css.scroll },
      !findings &&
        !error &&
        h(EmptyState, { title: t('kb.lint.empty'), description: t('kb.lint.emptyHint') }),
      findings &&
        !findings.length &&
        h('p', { className: css.notice, role: 'status' }, t('kb.lint.none')),
      findings &&
        findings.length > 0 &&
        h(
          'section',
          { 'aria-label': t('kb.lint.findings'), className: css.findings },
          findings.map((finding, index) => {
            const level = finding.level === 'error' ? 'error' : 'warning';
            const kindKey = `kb.lint.kind.${finding.kind}`;
            return h(
              'article',
              { key: index, className: css.finding },
              h(
                'div',
                { className: css.findingHeader },
                h(
                  'span',
                  {
                    className: css.badge,
                    'data-tone': level === 'error' ? 'error' : undefined,
                  },
                  t(`kb.lint.level.${level}`),
                ),
                h('span', null, hasLocaleKey(kindKey) ? t(kindKey) : finding.kind),
                finding.pageId &&
                  h(
                    Button,
                    { variant: 'ghost', size: 'sm', onClick: () => onOpenPage?.(finding.pageId) },
                    t('kb.lint.openPage'),
                  ),
              ),
              finding.pageId &&
                h('p', { className: css.muted }, `${t('kb.lint.page')}: ${finding.pageId}`),
              finding.target &&
                h('p', { className: css.muted }, `${t('kb.lint.target')}: ${finding.target}`),
              finding.sourceId &&
                h('p', { className: css.muted }, `${t('kb.lint.source')}: ${finding.sourceId}`),
              h('p', null, finding.reason),
              finding.suggestion &&
                h('p', { className: css.muted }, `${t('kb.lint.suggestion')}: ${finding.suggestion}`),
            );
          }),
        ),
    ),
  );
}
module.exports = { LintPanel };