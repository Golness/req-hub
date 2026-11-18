'use strict';
const React = require('react');
const { Button } = require('./shared/Button.js');
const { Disclosure } = require('./shared/Disclosure.js');
const { t } = require('../locale.js');
const form = require('./shared/SettingsForm.module.css').default;
const css = require('./EnhancementSettings.module.css').default;
const h = React.createElement;

/**
 * Present a single index or status-check operation, independently of document checks.
 * @param props - Current code task, request lock and owner-provided cancellation callback.
 * @returns Task identity, actual stage/progress, result and an initially collapsed log.
 */
function GitNexusTaskStatus({ job, busy, onCancel }) {
  const running = ['queued', 'preparing', 'running', 'cancelling'].includes(job.status);
  const indexing = job.kind === 'code-index';
  const percent = job.activity?.percent;
  const hasPercent =
    indexing && running && Number.isFinite(percent) && percent >= 0 && percent <= 100;
  let stage = indexing ? 'enhancement.stage.index_preparing' : 'assist.settings.checkingIndex';
  if (job.status === 'cancelling') {
    stage = 'enhancement.state.cancelling';
  } else if (
    indexing &&
    ['index_running', 'mcp_status', 'mcp_query'].includes(job.activity?.stage)
  ) {
    stage = `enhancement.stage.${job.activity.stage}`;
  }
  const code = job.result?.code;
  const indexUpdated = job.status === 'completed' && job.result?.indexUpdated === true;
  const checkUnavailable = job.status === 'completed' && code?.status === 'unavailable';
  const knownErrors = [
    'ENHANCEMENT_INDEX_CLI_MISSING',
    'ENHANCEMENT_INDEX_CLI_UNSUPPORTED',
    'ENHANCEMENT_INDEX_ROOT_INVALID',
    'ENHANCEMENT_INDEX_FAILED',
  ];
  const error =
    job.error &&
    (knownErrors.includes(job.error.code)
      ? t(`enhancement.error.${job.error.code}`)
      : t('enhancement.error', { code: job.error.code }));
  return h(
    'div',
    { className: css.taskArea, 'aria-label': t('assist.settings.currentTask') },
    h(
      'div',
      { className: css.taskHeader },
      h(
        'span',
        { className: css.taskName },
        t(indexing ? 'enhancement.updateIndex' : 'enhancement.refreshCode'),
      ),
      h(
        'div',
        { className: css.taskActions },
        h(
          'span',
          { className: form.muted, role: 'status' },
          t(
            checkUnavailable && !indexUpdated
              ? 'assist.settings.checkFailed'
              : `enhancement.state.${job.status}`,
          ),
        ),
        running &&
          onCancel &&
          h(
            Button,
            {
              size: 'sm',
              tone: 'warning',
              disabled: busy || job.status === 'cancelling',
              onClick: onCancel,
            },
            t('enhancement.cancel'),
          ),
      ),
    ),
    running &&
      h(
        'div',
        { className: css.taskDetails },
        h('p', { className: css.stage }, t(stage)),
        hasPercent
          ? h(
              'div',
              { className: css.progress },
              h('progress', {
                max: 100,
                value: percent,
                'aria-label': t('enhancement.indexProgress'),
              }),
              h('span', { className: form.muted }, `${percent}%`),
            )
          : indexing && h('p', { className: form.muted }, t('enhancement.indexIndeterminate')),
      ),
    error && h('p', { className: form.error, role: 'alert' }, error),
    indexUpdated && h('p', { className: form.muted }, t('enhancement.indexUpdated')),
    indexUpdated &&
      code?.status !== 'ready' &&
      !checkUnavailable &&
      h('p', { className: form.muted }, t('enhancement.indexCheckPending')),
    !indexing &&
      code &&
      !checkUnavailable &&
      h(
        'p',
        { className: form.muted },
        t('assist.settings.checkResult', { status: t(`enhancement.state.${code.status}`) }),
      ),
    checkUnavailable &&
      h('p', { className: form.error, role: 'alert' }, t('assist.settings.checkUnavailable')),
    job.indexLogs?.length > 0 &&
      h(
        Disclosure,
        { compact: true, title: t('enhancement.indexLogs'), className: css.logs },
        h(
          'pre',
          { className: css.logBody, tabIndex: 0, 'aria-label': t('assist.settings.logBody') },
          job.indexLogs.join('\n'),
        ),
      ),
  );
}
module.exports = { GitNexusTaskStatus };
