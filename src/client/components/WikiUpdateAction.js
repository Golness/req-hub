'use strict';
const React = require('react');
const { ROUTE } = require('../constants.js');
const { t } = require('../locale.js');
const { SessionSelectionContext } = require('../context.js');
const { Button } = require('./shared/Button.js');
const css = require('./WikiUpdateAction.module.css').default;
const h = React.createElement;

/**
 * Keep the current source backlog visible and start compilation only on an explicit action.
 * @param props - Authorized workspace, completion refresh and event navigation callbacks.
 * @returns A primary update action with retained counts and abortable status requests.
 */
function WikiUpdateAction({ workspaceId, onUpdated, onOpenEvents, children }) {
  const session = React.useContext(SessionSelectionContext);
  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const owner = React.useRef(null);
  const previousBusy = React.useRef(false);
  const updated = React.useRef(onUpdated);
  updated.current = onUpdated;
  const receive = (next) => {
    const busy = next.running || next.queuedCount > 0;
    if (previousBusy.current && !busy) {
      updated.current?.();
    }
    previousBusy.current = busy;
    setStatus(next);
  };
  const read = async (signal) => {
    const params = new URLSearchParams({ workspaceId });
    const response = await fetch(`${ROUTE}/knowledge/wiki/update-status?${params}`, { signal });
    const value = await response.json();
    if (!response.ok || !Number.isSafeInteger(value.pendingCount)) {
      throw new Error(value.error || 'WIKI_STATUS_UNAVAILABLE');
    }
    return value;
  };
  React.useEffect(() => {
    setStatus(null);
    setError('');
    setSubmitting(false);
    previousBusy.current = false;
    const controller = new AbortController();
    const requestOwner = { controller, writing: false, version: 0 };
    owner.current = requestOwner;
    let timer;
    const load = async () => {
      const version = requestOwner.version;
      try {
        const value = await read(controller.signal);
        if (
          !controller.signal.aborted &&
          !requestOwner.writing &&
          version === requestOwner.version
        ) {
          receive(value);
          setError('');
        }
      } catch (failure) {
        if (
          !controller.signal.aborted &&
          !requestOwner.writing &&
          version === requestOwner.version
        ) {
          setError(failure.message);
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(load, 3000);
        }
      }
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [workspaceId]);
  const update = async () => {
    const requestOwner = owner.current;
    const controller = requestOwner?.controller;
    if (submitting || !controller || controller.signal.aborted) {
      return;
    }
    requestOwner.writing = true;
    requestOwner.version++;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch(`${ROUTE}/knowledge/wiki/update`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(session() ? { 'x-session-id': session() } : {}),
        },
        body: JSON.stringify({ workspaceId }),
      });
      const value = await response.json();
      if (!response.ok) {
        throw new Error(value.error || 'WIKI_FAILED');
      }
      if (!controller.signal.aborted) {
        receive(value);
        updated.current?.();
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.message);
      }
    } finally {
      requestOwner.writing = false;
      requestOwner.version++;
      if (!controller.signal.aborted) {
        setSubmitting(false);
      }
    }
  };
  let label = t('wiki.update.loading');
  if (status) {
    label = t(status.running ? 'wiki.update.running' : 'wiki.update.button', {
      count: status.pendingCount,
    });
  }
  return h(
    'div',
    { className: css.bar, 'aria-label': t('wiki.update.title') },
    h(
      Button,
      {
        variant: 'primary',
        disabled: submitting || !status || status.running || status.pendingCount === 0,
        onClick: update,
      },
      submitting ? t('wiki.update.submitting') : label,
    ),
    h(
      'div',
      { className: css.summary },
      h(
        'span',
        { role: 'status', className: css.count },
        status ? t('wiki.update.count', { count: status.pendingCount }) : t('wiki.update.loading'),
      ),
      h('span', { className: css.hint }, t('wiki.update.hint')),
      status?.autoManage && h('span', { className: css.hint }, t('wiki.update.automatic')),
      status?.waitingSession &&
        h('span', { className: css.hint }, t('wiki.status.waiting_session')),
      status?.failedCount > 0 &&
        h(
          'span',
          { className: css.error },
          t('wiki.update.failures', { count: status.failedCount }),
        ),
      error && h('span', { role: 'alert', className: css.error }, t('wiki.error', { code: error })),
    ),
    onOpenEvents &&
      h(Button, { variant: 'ghost', size: 'sm', onClick: onOpenEvents }, t('wiki.events.open')),
    children,
  );
}
module.exports = { WikiUpdateAction };
