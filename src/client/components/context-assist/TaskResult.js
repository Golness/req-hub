'use strict';

const { Disclosure } = require('../shared/Disclosure.js');
const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { DiffViewer } = require('../shared/DiffViewer.js');
const { AiTaskStatus } = require('../shared/AiTaskStatus.js');
const css = require('../ContextAssist.module.css').default;
const h = React.createElement;
const active = (job) => ['queued', 'preparing', 'running', 'cancelling'].includes(job?.status);
const state = (value) => t(`enhancement.state.${value || 'unavailable'}`);
function TaskResult({ api }) {
  const { job } = api;
  if (!job) {
    return null;
  }
  const percent = job.activity?.percent;
  return h(
    'section',
    { className: css.task, 'aria-label': t('enhancement.task') },
    h(
      'div',
      { className: css.actions },
      h('span', { role: 'status' }, state(job.status)),
      active(job) &&
        h(
          Button,
          {
            size: 'sm',
            tone: 'warning',
            disabled: api.busy || job.status === 'cancelling',
            onClick: api.cancel,
          },
          t('enhancement.cancel'),
        ),
    ),
    active(job) &&
      job.kind !== 'code-index' &&
      h(AiTaskStatus, {
        startedAt: job.createdAt,
        stage: job.activity?.stage,
        cancelling: job.status === 'cancelling',
      }),
    active(job) &&
      job.kind === 'code-index' &&
      h(
        React.Fragment,
        null,
        h(
          'span',
          null,
          t(
            ['index_preparing', 'index_running', 'mcp_status', 'mcp_query'].includes(
              job.activity?.stage,
            )
              ? `enhancement.stage.${job.activity.stage}`
              : 'enhancement.stage.index_preparing',
          ),
        ),
        Number.isFinite(percent) &&
          h('progress', {
            max: 100,
            value: percent,
            'aria-label': t('enhancement.indexProgress'),
          }),
        h(
          'small',
          null,
          Number.isFinite(percent) ? `${percent}%` : t('enhancement.indexIndeterminate'),
        ),
      ),
    job.error && h('p', { role: 'alert' }, t('enhancement.error', { code: job.error.code })),
    job.result?.indexUpdated && h('p', null, t('enhancement.indexUpdated')),
    job.result?.indexUpdated &&
      job.result.code?.status !== 'ready' &&
      h('small', null, t('enhancement.indexCheckPending')),
    job.result?.findings?.map((item) =>
      h(
        Disclosure,
        { key: item.id, title: item.reason || t(`enhancement.finding.${item.kind}`) },
        item.question && h('p', null, item.question),
        item.proposal &&
          h(DiffViewer, {
            oldContent: item.evidence?.[0]?.quote || '',
            newContent: item.proposal,
            fileName: item.subject || 'proposal',
            oldLabel: t('enhancement.fragmentOriginal'),
            newLabel: t('enhancement.fragmentProposal'),
          }),
        h('pre', null, JSON.stringify(item.evidence, null, 2)),
      ),
    ),
    job.result?.patterns?.map((item) =>
      h(
        Disclosure,
        { key: item.id, title: t('enhancement.patterns') },
        h('pre', null, item.content),
        h(
          'div',
          { className: css.actions },
          ['confirmed', 'rejected'].map((decision) =>
            h(
              Button,
              {
                key: decision,
                size: 'sm',
                disabled: api.locked || item.status === decision,
                onClick: () =>
                  api.perform(async (signal) =>
                    api.setJob(
                      await api.request(
                        'reviews',
                        { jobId: job.id, expectedSeq: job.seq, resultId: item.id, decision },
                        signal,
                      ),
                    ),
                  ),
              },
              state(decision),
            ),
          ),
        ),
      ),
    ),
    job.indexLogs?.length > 0 &&
      h(
        Disclosure,
        {
          compact: true,
          className: css.indexLogs,
          defaultOpen: active(job),
          title: t('enhancement.indexLogs'),
        },
        h('pre', { className: css.indexLogBody }, job.indexLogs.join('\n')),
      ),
  );
}

module.exports = { TaskResult };
