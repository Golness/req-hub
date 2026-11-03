'use strict';
const React = require('react');
const { ROUTE } = require('../constants.js');
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { Checkbox } = require('./shared/controls.js');
const { Disclosure } = require('./shared/Disclosure.js');
const css = require('./WikiPanel.module.css').default;
const h = React.createElement;
const STAGES = new Set([
  'source_saved',
  'update_requested',
  'update_deferred',
  'schedule_triggered',
  'schedule_no_changes',
  'schedule_failed',
  'source_capture_failed',
  'auto_skipped',
  'waiting_session',
  'auto_failed',
  'queued',
  'running',
  'executor_progress',
  'executor_finished',
  'executor_warning',
  'model_requested',
  'model_finished',
  'model_failed',
  'evidence_read',
  'result_submitted',
  'submission_rejected',
  'verifying',
  'generated',
  'published',
  'failed',
  'cancelled',
  'cancelling',
  'projection_failed',
  'interrupted',
]);

/**
 * Follow persisted Wiki events without losing older pages or events between refreshes.
 * @param props - Owning workspace and optional task filter.
 * @returns The event browser with abortable refresh and explicit history paging.
 */
function WikiEvents({ workspaceId, jobId = '' }) {
  const [events, setEvents] = React.useState([]);
  const [draft, setDraft] = React.useState(jobId);
  const [filter, setFilter] = React.useState(jobId);
  const [automatic, setAutomatic] = React.useState(true);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [before, setBefore] = React.useState(null);
  const [revision, refresh] = React.useReducer((value) => value + 1, 0);
  const owner = React.useRef(null);
  const newest = React.useRef(undefined);
  const merge = (rows) =>
    setEvents((previous) => {
      const unique = new Map(previous.map((row) => [row.sequence, row]));
      for (const row of rows) {
        unique.set(row.sequence, row);
      }
      return [...unique.values()].sort((a, b) => b.sequence - a.sequence);
    });
  const read = async (query, signal) => {
    const params = new URLSearchParams({ workspaceId, limit: '50', ...query });
    if (filter) {
      params.set('jobId', filter);
    }
    const response = await fetch(`${ROUTE}/knowledge/wiki/events?${params}`, { signal });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'WIKI_FAILED');
    }
    if (!Array.isArray(data.items)) {
      throw new Error('WIKI_EVENTS_INVALID_RESPONSE');
    }
    return data;
  };
  React.useEffect(() => {
    newest.current = undefined;
    setEvents([]);
    setBefore(null);
    setLoading(true);
  }, [workspaceId, filter]);
  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    let timer;
    const load = async () => {
      try {
        const catchingUp = newest.current !== undefined;
        const data = await read(
          newest.current === undefined ? {} : { after: String(newest.current) },
          controller.signal,
        );
        if (controller.signal.aborted) {
          return;
        }
        if (newest.current === undefined) {
          merge(data.items);
          setBefore(data.hasMore ? data.nextCursor : null);
        } else {
          merge(data.items);
        }
        newest.current = Math.max(newest.current || 0, ...data.items.map((row) => row.sequence));
        setError('');
        setLoading(false);
        if (automatic || (catchingUp && data.hasMore)) {
          timer = setTimeout(load, catchingUp && data.hasMore ? 0 : 2000);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure.message);
          setLoading(false);
          if (automatic) {
            timer = setTimeout(load, 2000);
          }
        }
      }
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspaceId, filter, automatic, revision]);
  const older = async () => {
    const signal = owner.current?.signal;
    setLoading(true);
    try {
      const data = await read({ before: String(before) }, signal);
      if (!signal?.aborted) {
        merge(data.items);
        setBefore(data.hasMore ? data.nextCursor : null);
        setError('');
      }
    } catch (failure) {
      if (!signal?.aborted) {
        setError(failure.message);
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };
  return h(
    'section',
    { className: css.panel, 'aria-label': t('wiki.events.title') },
    h(
      'div',
      { className: css.toolbar },
      h(Input, {
        value: draft,
        'aria-label': t('wiki.events.filter'),
        placeholder: t('wiki.events.filter'),
        onChange: (event) => setDraft(event.target.value),
      }),
      h(
        Button,
        {
          onClick: () => {
            setFilter(draft.trim());
            refresh();
          },
        },
        t('wiki.events.apply'),
      ),
      h(Checkbox, { checked: automatic, onChange: setAutomatic, label: t('LogPanel.message001') }),
    ),
    h('p', { className: css.muted }, t('wiki.events.hint')),
    error && h('p', { role: 'alert', className: css.error }, t('wiki.error', { code: error })),
    loading && h('p', { role: 'status' }, t('wiki.events.loading')),
    !loading && !events.length && h('p', { role: 'status' }, t('wiki.events.empty')),
    h(
      'ol',
      { className: css.events },
      events.map((event) =>
        h(
          'li',
          { className: css.card, key: event.sequence },
          h(
            'div',
            { className: css.toolbar },
            h('time', { dateTime: event.created_at }, new Date(event.created_at).toLocaleString()),
            h(
              'span',
              { className: event.level === 'error' ? css.error : undefined },
              STAGES.has(event.stage) ? t(`wiki.event.${event.stage}`) : event.stage,
            ),
          ),
          event.job_id && h('p', null, t('wiki.events.job', { id: event.job_id })),
          h(
            Disclosure,
            { title: t('wiki.events.details') },
            h('pre', { className: css.body }, JSON.stringify(event.detail, null, 2)),
          ),
        ),
      ),
    ),
    before !== null && h(Button, { onClick: older, disabled: loading }, t('wiki.events.older')),
  );
}
module.exports = { WikiEvents };
