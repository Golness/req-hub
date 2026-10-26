const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { Button } = require('./shared/Button.js');
const css = require('./SyncStorageUsage.module.css').default;
const h = React.createElement;
function SyncStorageUsage({ workspaceId, onChanged }) {
  const [usage, setUsage] = React.useState(null), [error, setError] = React.useState(null), [busy, setBusy] = React.useState(false);
  const request = React.useRef(null);
  const load = async (method = 'GET') => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const { signal } = controller;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${ROUTE}/sync-storage?${new URLSearchParams({workspaceId})}`, {method, signal, ...(method === 'POST' ? {headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceId})} : {})});
      const result = await res.json(); if (!res.ok) throw new Error(result.error); if (!signal.aborted) {setUsage(result.usage); if (method === 'POST') onChanged?.();}
    } catch (error) { if (!signal?.aborted) setError(t('sync.storage.failed')); } finally { if (!signal?.aborted) setBusy(false); }
  };
  React.useEffect(() => {load(); return () => request.current?.abort();}, [workspaceId]);
  const mb = value => (value / 1048576).toFixed(1);
  return h('div', {className:css.row},
    usage && h('span', null, t('sync.storage.usage',{total:mb(usage.physicalBytes),objects:mb(usage.objectBytes),outputs:mb(usage.artifactBytes),reclaimable:mb(usage.reclaimableBytes)})),
    h(Button, {disabled:busy,onClick:()=>load('POST')}, t('sync.storage.collect')),
    error && h('span', {role:'alert'},error));
}
module.exports = {SyncStorageUsage};
