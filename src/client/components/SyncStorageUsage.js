const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { Button } = require('./shared/Button.js');
const css = require('./SyncStorageUsage.module.css').default;
const h = React.createElement;
function storageError(error) {
  if (error.message === 'SYNC_WORKSPACE_NOT_FOUND') return t('sync.storage.workspaceMissing');
  if ([401, 403].includes(error.status)) return t('sync.storage.forbidden', { reason: error.message === 'SYNC_STORAGE_RESPONSE_INVALID' ? `HTTP ${error.status}` : error.message });
  if (error.message === 'SYNC_STORAGE_RESPONSE_INVALID') return t('sync.storage.responseInvalid', { status: error.status || '?' });
  if (error instanceof TypeError) return t('sync.storage.networkFailed');
  return t('sync.storage.failureReason', { reason: error.message || t('sync.storage.failed') });
}
function SyncStorageUsage({ workspaceId, onChanged }) {
  const [usage, setUsage] = React.useState(null), [error, setError] = React.useState(null), [busy, setBusy] = React.useState(false);
  const request = React.useRef(null);
  const load = async (method = 'GET') => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const { signal } = controller;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${ROUTE}/sync-storage?${new URLSearchParams({workspaceId})}`, {method, signal, ...(method === 'POST' ? {headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceId})} : {})});
      let result;
      try { result = await res.json(); }
      catch { throw Object.assign(new Error('SYNC_STORAGE_RESPONSE_INVALID'), { status: res.status }); }
      if (!res.ok || result?.error) throw Object.assign(new Error(typeof result?.error === 'string' ? result.error : `HTTP ${res.status}`), { status: res.status });
      if (result?.success !== true || !['physicalBytes', 'objectBytes', 'artifactBytes', 'reclaimableBytes'].every(key => Number.isFinite(result.usage?.[key]) && result.usage[key] >= 0)) throw Object.assign(new Error('SYNC_STORAGE_RESPONSE_INVALID'), { status: res.status });
      if (!signal.aborted) {setUsage(result.usage); if (method === 'POST') onChanged?.();}
    } catch (error) { if (!signal.aborted) setError(storageError(error)); } finally { if (!signal.aborted) setBusy(false); }
  };
  React.useEffect(() => {setUsage(null); load(); return () => request.current?.abort();}, [workspaceId]);
  const mb = value => (value / 1048576).toFixed(1);
  return h('div', {className:css.row},
    usage && h('span', null, t('sync.storage.usage',{total:mb(usage.physicalBytes),objects:mb(usage.objectBytes),outputs:mb(usage.artifactBytes),reclaimable:mb(usage.reclaimableBytes)})),
    h(Button, {disabled:busy,onClick:()=>load('POST')}, t('sync.storage.collect')),
    error && h('span', {role:'alert'},error),
    error && h(Button, {disabled:busy,onClick:()=>load('GET')}, t('common.retry')));
}
module.exports = {SyncStorageUsage};
