'use strict';
const React = require('react');
const clientApi = require('../api/index.js');
const { t } = require('../locale.js');
const { localizeMessage } = require('../utils/serverMessage.js');
const { Button } = require('./shared/Button.js');
const { DatePicker } = require('./shared/DatePicker.js');
const { ActionBar } = require('./shared/ActionBar.js');
const { PagedList } = require('./shared/PagedList.js');
const css = require('./DailyReportsPanel.module.css').default;
const h = React.createElement;

/** Browse complete day groups without substituting current files for frozen evidence. */
function DailyReportsPanel({ onNavigate }) {
  const [day, setDay] = React.useState('');
  const [report, setReport] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [retrying, setRetrying] = React.useState(false);
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
            result.groups.some((group) => group.brief?.status === 'running') ||
            (result.enabled &&
              result.currentTarget &&
              result.groups.some((group) => !group.brief || group.brief.status === 'stale'))
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
  const retry = async (group) => {
    const signal = requestOwner.current.signal;
    setRetrying(true);
    try {
      await clientApi.requestJson(clientApi.endpoint('daily-reports/retry'), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day: report.day, id: group.id, workspaceId: group.workspaceId }),
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
    report && !report.groups.length && h('p', null, t('daily.empty')),
    report &&
      h(
        PagedList,
        {
          resetKey: report.day,
          plainRows: true,
          inspect: false,
          hasMore: report.nextOffset !== null,
          onMore: () => more(),
          busy,
        },
        report.groups.map((group) =>
          h(
            'article',
            { key: group.id, className: css.group },
            h('h3', null, group.workspaceTitle, ' / ', group.group || t('daily.public')),
            h(
              'p',
              null,
              t('daily.count', { total: group.count, added: group.added, changed: group.changed }),
            ),
            h('p', { role: 'status' }, t(`daily.status.${group.brief?.status || 'pending'}`)),
            group.brief?.error && h('p', { role: 'alert' }, localizeMessage(group.brief.error)),
            group.brief?.reads?.some((file) => file.fileState === 'updated_since_collection') &&
              h('p', { className: css.hint }, t('daily.readUpdated')),
            group.brief?.reads?.some((file) =>
              ['unavailable', 'unreadable_text'].includes(file.fileState),
            ) && h('p', { className: css.hint }, t('daily.readUnavailable')),
            group.brief?.summary && h('div', { className: css.summary }, group.brief.summary),
            group.brief?.path &&
              onNavigate &&
              h(
                Button,
                {
                  size: 'sm',
                  onClick: () =>
                    onNavigate({
                      kind: 'file',
                      workspaceId: group.workspaceId,
                      path: group.brief.path,
                    }),
                },
                t('daily.openBrief'),
              ),
            ['failed', 'stale'].includes(group.brief?.status) &&
              h(
                Button,
                {
                  size: 'sm',
                  tone: 'business',
                  disabled: busy || retrying || report.enabled === false,
                  onClick: () => retry(group),
                },
                t('daily.retry'),
              ),
            h(
              'details',
              null,
              h('summary', null, t('daily.files')),
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
  );
}
module.exports = { DailyReportsPanel };
