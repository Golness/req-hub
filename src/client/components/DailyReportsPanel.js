'use strict';
const React = require('react');
const clientApi = require('../api/index.js');
const { t } = require('../locale.js');
const { localizeMessage } = require('../utils/serverMessage.js');
const { Button } = require('./shared/Button.js');
const { DatePicker } = require('./shared/DatePicker.js');
const { ActionBar } = require('./shared/ActionBar.js');
const { PagedList } = require('./shared/PagedList.js');
const { Modal } = require('./shared/controls.js');
const css = require('./DailyReportsPanel.module.css').default;
const h = React.createElement;

/** Browse one daily brief with source sections in an on-demand dialog. */
function DailyReportsPanel({ onNavigate }) {
  const [day, setDay] = React.useState('');
  const [report, setReport] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [retrying, setRetrying] = React.useState(false);
  const [failure, setFailure] = React.useState(null);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const requestOwner = React.useRef(null);
  const reportRef = React.useRef(null);
  reportRef.current = report;
  React.useEffect(() => {
    const controller = new AbortController();
    requestOwner.current = controller;
    let timer;
    const load = async () => {
      setBusy(true);
      try {
        const result = await clientApi.requestJson(
          clientApi.endpoint('daily-reports/list', { day }),
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          if (!Array.isArray(result.groups)) {
            throw new Error('DAILY_FAILED');
          }
          setReport(result);
          setError(null);
          if (
            result.brief?.status === 'running' ||
            (result.enabled &&
              result.currentTarget &&
              result.groups.length > 0 &&
              (!result.brief || result.brief.status === 'stale'))
          ) {
            timer = setTimeout(load, 3000);
          }
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
        }
      }
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [day, revision]);
  const more = async (group) => {
    const signal = requestOwner.current.signal;
    try {
      const result = await clientApi.requestJson(
        clientApi.endpoint('daily-reports/list', {
          day: report.day,
          ...(group
            ? {
                groupId: group.id,
                workspaceId: group.workspaceId,
                fileOffset: group.nextFileOffset,
              }
            : { offset: report.nextOffset }),
        }),
        { signal },
      );
      if (!signal.aborted) {
        const next = group && result.groups[0];
        if (
          group &&
          (!next ||
            next.digest !== group.digest ||
            reportRef.current?.groups.find((item) => item.id === group.id)?.digest !== next.digest)
        ) {
          throw new Error('DAILY_FILES_CHANGED');
        }
        setReport((previous) =>
          group
            ? {
                ...previous,
                groups: previous.groups.map((item) => {
                  if (item.id !== group.id) {
                    return item;
                  }
                  return { ...next, files: [...item.files, ...next.files] };
                }),
              }
            : { ...result, groups: [...previous.groups, ...result.groups] },
        );
      }
    } catch (reason) {
      if (!signal.aborted) {
        setError(reason.message);
      }
    }
  };
  const retry = async () => {
    const signal = requestOwner.current.signal;
    setRetrying(true);
    try {
      await clientApi.requestJson(clientApi.endpoint('daily-reports/retry'), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: report.day, id: report.id }),
      });
      if (!signal.aborted) {
        setRevision((value) => value + 1);
      }
    } catch (reason) {
      if (!signal.aborted) {
        setError(reason.message);
      }
    } finally {
      if (!signal.aborted) {
        setRetrying(false);
      }
    }
  };
  const brief = report?.brief;
  return h(
    'div',
    { className: css.panel },
    h(
      ActionBar,
      {
        leading: h(
          'div',
          { className: css.date },
          t('daily.date'),
          h(DatePicker, {
            label: t('daily.date'),
            value: day || report?.day || '',
            disabled: busy || retrying,
            onChange: (event) => {
              setReport(null);
              setFilesOpen(false);
              setDay(event.target.value);
            },
          }),
        ),
      },
      h(
        Button,
        {
          size: 'sm',
          disabled: busy || retrying,
          onClick: () => setRevision((value) => value + 1),
        },
        t('reports.refresh'),
      ),
    ),
    h('p', { className: css.hint }, t('daily.schedule', { zone: report?.timeZone || '—' })),
    report?.enabled === false && h('p', { role: 'status' }, t('daily.disabled')),
    error && h('p', { role: 'alert' }, localizeMessage(error)),
    report?.scanErrors?.map(([id, code]) =>
      h('p', { key: id, role: 'alert' }, id, ' · ', localizeMessage(code)),
    ),
    busy && h('p', { role: 'status' }, t('reports.loading')),
    h(
      'article',
      { className: css.content, 'aria-label': t('daily.title') },
      h('h3', null, report?.day, ' · ', t('daily.title')),
      report && !report.groups.length && h('p', null, t('daily.empty')),
      report &&
        report.groups.length > 0 &&
        h('p', { role: 'status' }, t(`daily.status.${brief?.status || 'pending'}`)),
      brief?.error &&
        brief.status !== 'running' &&
        h('p', { role: 'alert' }, dailyError(brief.error)),
      brief?.reads?.some((file) => file.fileState === 'updated_since_collection') &&
        h('p', { className: css.hint }, t('daily.readUpdated')),
      brief?.reads?.some((file) => ['unavailable', 'unreadable_text'].includes(file.fileState)) &&
        h('p', { className: css.hint }, t('daily.readUnavailable')),
      brief?.summary && h('div', { className: css.summary }, brief.summary),
    ),
    report &&
      h(
        ActionBar,
        {
          placement: 'page',
          leading: h(
            Button,
            {
              variant: 'ghost',
              disabled: !report.groups.length,
              onClick: () => setFilesOpen(true),
            },
            t('daily.files'),
          ),
        },
        brief?.error &&
          brief.status !== 'running' &&
          h(
            Button,
            { variant: 'ghost', onClick: () => setFailure(brief) },
            t('daily.failureDetails'),
          ),
        brief?.path &&
          onNavigate &&
          h(
            Button,
            {
              onClick: () =>
                onNavigate({ kind: 'file', workspaceId: brief.workspaceId, path: brief.path }),
            },
            t('daily.openBrief'),
          ),
        ['failed', 'stale'].includes(brief?.status) &&
          h(
            Button,
            {
              variant: 'primary',
              disabled: busy || retrying || report.enabled === false,
              onClick: retry,
            },
            t('daily.retry'),
          ),
      ),
    h(
      Modal,
      { open: filesOpen, title: t('daily.files'), onClose: () => setFilesOpen(false) },
      report &&
        h(
          PagedList,
          {
            resetKey: report.day,
            plainRows: true,
            inspect: false,
            fitContent: true,
            hasMore: report.nextOffset !== null,
            onMore: () => more(),
            busy,
          },
          report.groups.map((group) =>
            h(
              'section',
              { key: group.id, className: css.group },
              h('h3', null, group.workspaceTitle, ' / ', group.group || t('daily.public')),
              h(
                'p',
                null,
                t('daily.count', {
                  total: group.count,
                  added: group.added,
                  changed: group.changed,
                }),
              ),
              h(
                PagedList,
                {
                  resetKey: group.id,
                  fitContent: true,
                  plainRows: true,
                  inspect: false,
                  hasMore: group.nextFileOffset !== null,
                  onMore: () => more(group),
                  busy,
                },
                group.files.map((file) =>
                  h(
                    'div',
                    { key: file.id, className: css.file },
                    h('span', null, file.path),
                    ' · ',
                    t(`daily.change.${file.change}`),
                    ' · ',
                    file.sources.map((source) => t(`daily.source.${source}`)).join(' / '),
                    ' · ',
                    t('daily.bytes', { size: file.size }),
                    file.observed && h('span', { className: css.hint }, ' · ', t('daily.observed')),
                    h('code', { className: css.version }, file.version),
                  ),
                ),
              ),
            ),
          ),
        ),
    ),
    h(
      Modal,
      { open: !!failure, title: t('daily.failureDetails'), onClose: () => setFailure(null) },
      failure &&
        h(
          React.Fragment,
          null,
          h('p', null, dailyError(failure.error)),
          !failure.errorDetails && h('p', null, t('daily.failureDetailsMissing')),
          h(
            'pre',
            { className: css.diagnostic },
            JSON.stringify({ code: failure.error, ...failure.errorDetails }, null, 2),
          ),
        ),
    ),
  );
}

/** Render daily failures without referring users to the knowledge compiler task list. */
function dailyError(code) {
  if (['ENOTDIR', 'KB_TOOL_FAILED', 'KB_MODEL_FAILED', 'KB_RESULT_INCOMPLETE'].includes(code)) {
    return t(`daily.error.${code}`);
  }
  return localizeMessage(code);
}
module.exports = { DailyReportsPanel };
