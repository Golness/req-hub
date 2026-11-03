'use strict';
const React = require('react');
const { ROUTE } = require('../constants.js');
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const css = require('./WikiPanel.module.css').default;
const h = React.createElement;
const FOLLOW = ['queued', 'running', 'cancelling', 'waiting_session'];

/**
 * Track source processing independently from document save success.
 * @param props - Save receipt, owning workspace, visibility and event navigation callback.
 * @returns Accessible processing feedback; retained data stays visible on refresh failure.
 */
function WikiSaveStatus({ receipt, workspaceId, active = true, onOpenEvents, onOpenUpdate }) {
  const [state, setState] = React.useState(receipt);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    setState(receipt);
    setError('');
    if (!receipt?.documentId || !active) {
      return;
    }
    const controller = new AbortController();
    let timer;
    const load = async () => {
      try {
        const params = new URLSearchParams({ workspaceId, documentId: receipt.documentId });
        const response = await fetch(`${ROUTE}/knowledge/wiki/source-state?${params}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'WIKI_FAILED');
        }
        if (!controller.signal.aborted) {
          setState(data);
          setError('');
          if (FOLLOW.includes(data.processingStatus)) {
            timer = setTimeout(load, 2000);
          }
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure.message);
          timer = setTimeout(load, 2000);
        }
      }
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [receipt, workspaceId, active]);
  if (!state) {
    return null;
  }
  const failed = state.state === 'failed' || state.processingStatus === 'failed';
  const status = state.processingStatus || (failed ? 'failed' : 'pending');
  return h(
    'div',
    { className: css.card, role: failed ? 'alert' : 'status' },
    h('span', null, t('wiki.saveStatus', { status: t(`wiki.status.${status}`) })),
    (state.error?.code || state.code) &&
      h('p', { className: css.error }, t('wiki.error', { code: state.error?.code || state.code })),
    error && h('p', { role: 'alert' }, t('wiki.error', { code: error })),
    onOpenUpdate &&
      (status === 'needs_update' || failed) &&
      h(Button, { variant: 'primary', onClick: onOpenUpdate }, t('wiki.update.open')),
    onOpenEvents && h(Button, { onClick: onOpenEvents }, t('wiki.events.open')),
  );
}
module.exports = { WikiSaveStatus };
