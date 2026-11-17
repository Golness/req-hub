'use strict';

const { formatDateTime, useTimeZone } = require('../../time.js');
const { PagedList } = require('../shared/PagedList.js');
const { Disclosure } = require('../shared/Disclosure.js');
const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const css = require('../ContextAssist.module.css').default;
const h = React.createElement;
const state = (value) => t(`enhancement.state.${value || 'unavailable'}`);
const indexState = (code) =>
  code?.status && code.status !== 'disabled' ? state(code.status) : t('assist.settings.unchecked');
function CodeStatus({ api }) {
  useTimeZone();
  const code = api.job?.result?.code || api.data?.graph?.code;
  return h(
    'div',
    { className: css.stack },
    h('p', null, t('enhancement.mcp', { status: indexState(code) })),
    code?.indexedAt &&
      h(
        'small',
        null,
        t('enhancement.indexVersion', {
          date: formatDateTime(code.indexedAt),
          commit: code.lastCommit || '',
        }),
      ),
    h(
      'div',
      { className: css.actions },
      h(
        Button,
        { size: 'sm', disabled: api.locked, onClick: () => api.start('code-refresh') },
        t('enhancement.refreshCode'),
      ),
      h(
        Button,
        { size: 'sm', disabled: api.locked, onClick: () => api.start('code-index') },
        t('enhancement.updateIndex'),
      ),
    ),
  );
}

function TaskHistory({ api }) {
  useTimeZone();
  if (!api.data?.jobs?.length) {
    return null;
  }
  return h(
    Disclosure,
    { title: t('enhancement.history') },
    h(
      'div',
      { className: `${css.stack} ${css.history}` },
      h(
        PagedList,
        { className: css.pagedSection },
        api.data.jobs.map((job) =>
          h(
            Button,
            {
              key: job.id,
              size: 'sm',
              disabled: api.busy,
              onClick: () =>
                api.perform(async (signal) =>
                  api.setJob(await api.request(`jobs/${job.id}`, null, signal)),
                ),
            },
            `${t(`enhancement.kind.${job.kind}`)} · ${state(job.status)} · ${formatDateTime(job.createdAt)}`,
          ),
        ),
      ),
    ),
  );
}

module.exports = { CodeStatus, TaskHistory };
