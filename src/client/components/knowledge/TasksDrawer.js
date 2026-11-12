'use strict';
const React = require('react');
const { t, hasLocaleKey } = require('../../locale.js');
const { formatDateTime, useTimeZone } = require('../../time.js');
const { Button } = require('../shared/Button.js');
const { Modal } = require('../shared/controls.js');
const { showToast } = require('../shared/ToastContainer.js');
const { knowledgeV2ErrorText } = require('../../hooks/useKnowledgeV2.js');
const css = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;
const { IconSync } = require('../../icons.js').createIconComponents(h);

const ACTIVE = ['queued', 'running', 'cancelling'];

/** Resolve an enum-derived key without letting an unknown value break the drawer. */
const localized = (key, fallback) => (hasLocaleKey(key) ? t(key) : fallback);

const summaryText = (job) => {
  if (!job.summary) {
    return null;
  }
  if (job.kind === 'lint') {
    return t('kb.lint.semanticDone', { count: job.summary.findings ?? 0 });
  }
  if (job.summary.reason) {
    return job.summary.reason;
  }
  return `${t('kb.wiki.sources')}: ${job.summary.sources ?? 0} · ${t('kb.wiki.pageCount', { count: job.summary.pages ?? 0 })}`;
};

/**
 * Review knowledge jobs and cancel, resume or retry them.
 * @param props - Open state, workspace identity and the shared job list.
 * @returns The rendered drawer, or nothing while closed.
 */
function TasksDrawer({ open, onClose, jobs }) {
  useTimeZone();
  const [busyId, setBusyId] = React.useState(null);
  if (!open) {
    return null;
  }
  const act = async (action, id) => {
    setBusyId(id);
    try {
      await jobs[action](id);
    } catch (failure) {
      showToast({ tone: 'error', text: knowledgeV2ErrorText(failure) });
    } finally {
      setBusyId(null);
    }
  };
  return h(
    Modal,
    { open: true, title: t('kb.tasks.title'), onClose },
    h(
      'div',
      { className: css.toolbar },
      h('span', { className: css.toolbarSpacer }),
      h(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          icon: h(IconSync, { size: 14 }),
          onClick: () => jobs.refresh(),
        },
        t('kb.tasks.refresh'),
      ),
    ),
    jobs.error && h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(jobs.error)),
    !jobs.jobs.length && h('p', { className: css.muted }, t('kb.tasks.empty')),
    h(
      'div',
      { className: css.scroll },
      jobs.jobs.map((job) => {
        const active = ACTIVE.includes(job.status);
        return h(
          'div',
          { key: job.id, className: css.taskRow },
          h(
            'div',
            { className: css.taskHeader },
            h('span', { className: css.taskTitle }, t(`kb.tasks.kind.${job.kind}`)),
            h(
              'span',
              {
                className: css.badge,
                'data-tone':
                  job.status === 'completed'
                    ? 'success'
                    : job.status === 'failed'
                      ? 'error'
                      : undefined,
              },
              localized(`kb.tasks.status.${job.status}`, job.status),
            ),
            job.stage &&
              active &&
              h(
                'span',
                { className: css.muted },
                localized(`kb.tasks.stage.${job.stage}`, job.stage),
              ),
            h('span', { className: css.toolbarSpacer }),
            active &&
              h(
                Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  disabled: busyId === job.id || job.status === 'cancelling',
                  onClick: () => act('cancel', job.id),
                  tone: 'warning',
                },
                t('kb.tasks.cancel'),
              ),
            job.status === 'interrupted' &&
              h(
                Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  disabled: busyId === job.id,
                  onClick: () => act('resume', job.id),
                },
                t('kb.tasks.resume'),
              ),
            ['failed', 'cancelled'].includes(job.status) &&
              h(
                Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  disabled: busyId === job.id,
                  onClick: () => act('resume', job.id),
                },
                t('kb.tasks.retry'),
              ),
          ),
          h(
            'div',
            { className: css.pageMeta },
            h('span', null, t('kb.tasks.createdAt', { time: formatDateTime(job.createdAt) })),
            job.finishedAt &&
              h('span', null, t('kb.tasks.finishedAt', { time: formatDateTime(job.finishedAt) })),
          ),
          job.status === 'completed' &&
            summaryText(job) &&
            h('p', { className: css.muted }, `${t('kb.tasks.summary')}: ${summaryText(job)}`),
          job.status === 'failed' &&
            job.error &&
            h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(job.error)),
        );
      }),
    ),
  );
}
module.exports = { TasksDrawer };
