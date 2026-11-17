'use strict';

const clientApi = require('../../api/index.js');
const { localizeMessage } = require('../../utils/serverMessage.js');
const React = require('react');
const { SessionSelectionContext } = require('../../context.js');
const active = (job) => ['queued', 'preparing', 'running', 'cancelling'].includes(job?.status);
/**
 * Own scoped context queries, explicit actions and observation of one enhancement task.
 * @param workspaceId - Visible workspace identity.
 * @param context - Current document or draft selection, without Host services.
 * @param revision - Explicit refresh revision supplied by the owner.
 * @param jobKinds - Optional task-kind filter for settings views.
 * @returns Task state and actions; context changes cancel old reads and active requests.
 */
function useAssist(workspaceId, context, revision, jobKinds) {
  const session = React.useContext(SessionSelectionContext);
  const key = JSON.stringify(context || null);
  const [data, setData] = React.useState(null);
  const [job, setJob] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [reload, refresh] = React.useReducer((value) => value + 1, 0);
  const controller = React.useRef(null);
  const request = React.useCallback(
    async (path, body, signal) => {
      return clientApi.scopedRequest(
        'knowledge/enhancements',
        path,
        workspaceId,
        body,
        signal,
        session(),
      );
    },
    [workspaceId, session],
  );
  React.useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    setJob(null);
    setData(null);
    setError('');
    setBusy(false);
    return () => abort.abort();
  }, [workspaceId, key]);
  React.useEffect(() => {
    const abort = new AbortController();
    const path = context
      ? `context?${new URLSearchParams(Object.entries(context).filter(([, value]) => value !== undefined && value !== null))}`
      : 'jobs';
    request(path, null, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setData(value);
          setJob(
            (old) =>
              old ||
              value.jobs?.find(
                (job) => active(job) && (!jobKinds || jobKinds.includes(job.kind)),
              ) ||
              null,
          );
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setError(localizeMessage(error.message));
        }
      });
    return () => abort.abort();
  }, [workspaceId, key, reload, revision, request, jobKinds]);
  React.useEffect(() => {
    if (!active(job)) {
      return;
    }
    const abort = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const value = await request(`jobs/${job.id}`, null, abort.signal);
        if (abort.signal.aborted) {
          return;
        }
        setJob(value);
        if (active(value)) {
          timer = setTimeout(poll, 1000);
        } else {
          refresh();
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          setError(localizeMessage(error.message));
          timer = setTimeout(poll, 3000);
        }
      }
    };
    poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [job?.id, active(job), request]);
  const perform = async (operation) => {
    const signal = controller.current.signal;
    if (busy || signal.aborted) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await operation(signal);
    } catch (error) {
      if (!signal.aborted) {
        setError(localizeMessage(error.message));
      }
    } finally {
      if (!signal.aborted) {
        setBusy(false);
      }
    }
  };
  const start = (kind, mode, draft, referenceRefs) =>
    perform(async (signal) => {
      setJob(
        await request(
          'jobs',
          {
            kind,
            mode,
            context,
            ...(draft !== undefined ? { draft } : {}),
            ...(referenceRefs ? { referenceRefs } : {}),
            requestKey: crypto.randomUUID(),
            sessionId: session(),
            useCode: kind === 'graph-build',
          },
          signal,
        ),
      );
    });
  return {
    data,
    job,
    setJob,
    busy,
    error,
    request,
    perform,
    start,
    refresh,
    locked: busy || active(job),
    cancel: () =>
      perform(async (signal) => setJob(await request(`jobs/${job.id}/cancel`, {}, signal))),
  };
}

module.exports = { useAssist };
