'use strict';
const React = require('react');
const { Button } = require('./Button.js');
const { SessionSelectionContext } = require('../../context.js');
const { ROUTE } = require('../../constants.js');
const { t } = require('../../locale.js');
const { readSyncEvents } = require('../../utils/syncEvents.js');
const { syncErrorText } = require('../../utils/syncFeedback.js');
const css = require('./RetrySyncTaskButton.module.css').default;
const h = React.createElement;

/**
 * Start a scoped retry through the same Host operation for history, steps and chunks.
 * @param props - Prior attempt, optional failed node and navigation callback.
 * @returns A retry action retaining errors; unmount cancels observation, never the Host task.
 */
function RetrySyncTaskButton({ task, phase, chunkIndex, onTask, className = '' }) {
  const selection = React.useContext(SessionSelectionContext);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const controller = React.useRef(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  if (!['failed', 'aborted'].includes(task?.status) || task.publishState === 'state_committed') {
    return null;
  }
  const retry = async () => {
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    try {
      const sessionId = selection?.();
      const response = await fetch(`${ROUTE}/sync-retry`, {
        method: 'POST',
        signal: request.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(sessionId ? { 'x-session-id': sessionId } : {}),
        },
        body: JSON.stringify({
          workspaceId: task.workspaceId,
          requirementId: task.requirementId,
          retrySyncId: task.id,
          snapshotDir: task.snapshotDir,
          retryPhase: phase,
          retryChunkIndex: chunkIndex,
          requestId: window.crypto?.randomUUID?.() || `retry-${Date.now()}`,
        }),
      });
      if (!response.ok || !response.body) {
        const value = await response.json();
        throw new Error(value.error || 'SYNC_RETRY_FAILED');
      }
      await readSyncEvents(response.body, (event) => {
        if (request.signal.aborted) {
          return;
        }
        if (event.sync) {
          onTask?.(event.sync);
          window.dispatchEvent(new Event('req-hub-sync-change'));
        }
        if (event.type === 'error') {
          throw new Error(event.error || 'SYNC_RETRY_FAILED');
        }
      });
    } catch (error) {
      if (!request.signal.aborted) {
        setError(syncErrorText(error.message));
      }
    } finally {
      if (!request.signal.aborted) {
        setBusy(false);
      }
    }
  };
  return h(
    'div',
    { className: `${css.action} ${className}` },
    h(
      Button,
      {
        type: 'button',
        size: 'sm',
        variant: 'outline',
        tone: 'business',
        disabled: busy,
        onClick: retry,
      },
      t(busy ? 'sync.retry.starting' : 'sync.retry.action'),
    ),
    error && h('p', { role: 'alert', className: css.error }, error),
  );
}
module.exports = { RetrySyncTaskButton };
