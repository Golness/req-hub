'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { Select } = require('./shared/Select.js');
const { ConfirmDialog } = require('./shared/ConfirmDialog.js');
const { ConversationKnowledgeImport } = require('./ConversationKnowledgeImport.js');
const css = require('./ConversationManager.module.css').default;
const h = React.createElement;
const sourceStatus = value => ({ active: t('conversations.status.active'), missing: t('conversations.status.missing'), unavailable: t('conversations.status.unavailable') })[value] || value;
const jobStatus = value => ({ running: t('conversations.job.running'), queued: t('conversations.job.queued'), cancelling: t('conversations.job.cancelling'), cancelled: t('conversations.job.cancelled'), failed: t('conversations.job.failed'), interrupted: t('conversations.job.interrupted'), completed: t('conversations.job.completed') })[value] || value;
const errorText = code => ({ SESSION_VERSION_IN_USE: t('conversations.inUse'), SESSION_CURRENT_VERSION: t('conversations.isCurrent'), SESSION_MISSING: t('conversations.missing'), SESSION_SNAPSHOT_MISSING: t('conversations.missing') })[code] || t('common.loadFailed');

function ConversationManager({ workspaceId, onClose, onChanged }) {
  const [rows, setRows] = React.useState([]), [jobs, setJobs] = React.useState([]), [usage, setUsage] = React.useState(null);
  const [search, setSearch] = React.useState(''), [source, setSource] = React.useState('');
  const [detail, setDetail] = React.useState(null), [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false), [deleting, setDeleting] = React.useState(null);
  const [importingKnowledge, setImportingKnowledge] = React.useState(false);
  const owner = React.useRef(0), requests = React.useRef(new Set());
  const detailsOwner = React.useRef(0), alive = React.useRef(true);
  const request = async (action, body, params = {}) => {
    const controller = new AbortController();requests.current.add(controller);
    try {
      const response = await fetch(`${ROUTE}/conversations-${action}${body ? '' : '?' + new URLSearchParams({ workspaceId, ...params })}`, {signal:controller.signal,...(body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceId,...body})} : {})});
      const data = await response.json(); if (!response.ok || data.error) throw Error(errorText(data.error)); return data;
    } finally {requests.current.delete(controller);}

  };
  const load = async () => {
    const id = ++owner.current;
    try { const [list, progress, storage] = await Promise.all([request('list'), request('jobs'), request('storage')]); if (id === owner.current) { setRows(list.sessions); setJobs(progress.jobs);setUsage(storage.usage || null);if(storage.warning)setError(t('conversations.cleanupFailed')); } }
    catch (error) { if (id === owner.current) setError(error.message); }
  };
  React.useEffect(() => { alive.current = true; load(); return () => { alive.current = false; owner.current++; detailsOwner.current++;for(const controller of requests.current)controller.abort();requests.current.clear(); }; }, [workspaceId]);
  React.useEffect(() => { if (!jobs.some(job => ['running', 'queued', 'cancelling'].includes(job.status))) return; const timer = setInterval(load, 1000); return () => clearInterval(timer); }, [jobs.some(job => ['running', 'queued', 'cancelling'].includes(job.status))]);
  const view = async (id, version) => {
    setBusy(true); setError(''); const generation = ++detailsOwner.current;
    try { const data = await request('detail', null, { id, ...(version ? { version } : {}) }); if (generation === detailsOwner.current) setDetail(data); }
    catch (error) { if (generation === detailsOwner.current) setError(error.message); } finally { if (generation === detailsOwner.current) setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setError('');
    try { await request('delete', deleting); onChanged(); if (alive.current) { setDetail(null); setDeleting(null); await load(); } }
    catch (error) { if (alive.current) { setError(error.message); setDeleting(null); } } finally { if (alive.current) setBusy(false); }
  };
  const cleanup = async () => {
    setBusy(true);setError('');
    try {await request('cleanup',{});onChanged?.();if(alive.current){setDetail(null);await load();}}
    catch(error){if(alive.current)setError(error.message);}finally{if(alive.current)setBusy(false);}
  };
  const visible = rows.filter(row => (!source || row.source === source) && `${row.title} ${row.workspaceTitle}`.toLowerCase().includes(search.toLowerCase().trim()));
  return h(ModalFrame, { surfaceClassName: css.frame, onClick: onClose, 'aria-label': t('conversations.manage') },
    h('div', { className: `rh-modal ${css.modal}`, onClick: event => event.stopPropagation() },
      h('h3', { className: 'rh-modal-title' }, t('conversations.manage')),
      h('p', { className: 'rh-sync-hint' }, t('conversations.description')),
      h('div', { className: css.toolbar },
        h(Input, { type: 'search', value: search, placeholder: t('conversations.search'), 'aria-label': t('conversations.search'), onChange: event => setSearch(event.target.value) }),
        h(Select, { value: source, 'aria-label': t('conversations.source'), onChange: event => setSource(event.target.value), options: [{ id: '', label: t('conversations.all') }, { id: 'dsh', label: 'DSH' }, { id: 'codex', label: 'Codex' }] }),
        h(Button, { onClick: () => setImportingKnowledge(true), disabled: busy }, t('conversationImport.title')),
        h(Button, { onClick: load, disabled: busy }, t('conversations.reload'))),
      h('div', {className:css.storage},
        usage && h('span', null, t('conversations.storageUsage',{conversations:usage.conversations,versions:usage.versions,objects:(usage.objectBytes/1048576).toFixed(1),markdown:(usage.projectionBytes/1048576).toFixed(1),pinned:usage.pinnedVersions,database:((usage.sharedDatabaseBytes || 0)/1048576).toFixed(1),reusable:((usage.sharedReusableBytes || 0)/1048576).toFixed(1)})),
        h(Button,{disabled:busy,onClick:cleanup},t('conversations.cleanup'))),
      error && h('p', { role: 'alert', className: 'rh-error' }, error),
      h('div', { className: css.content },
        h('div', { className: css.list }, !visible.length && h('p', null, t('conversations.empty')), visible.map(row => h('div', { key: row.conversationId, className: css.item },
          h(Button, { className: 'rh-btn rh-btn-ghost', onClick: () => view(row.conversationId), disabled: busy }, row.title),
          h('small', null, `${row.source === 'dsh' ? 'DSH' : 'Codex'} · ${row.workspaceTitle} · ${sourceStatus(row.sourceStatus)}`),
          h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: busy, onClick: () => setDeleting({ id: row.conversationId }) }, t('conversations.delete'))))),
        detail && h('div', { className: css.preview },
          h(Select, { value: detail.snapshot.version, 'aria-label': t('conversations.version'), onChange: event => view(detail.entry.conversationId, event.target.value), options: detail.versions.map(version => ({ id: version.version, label: `${new Date(version.created_at).toLocaleString()} · ${version.version.slice(0, 8)} · ${t('conversations.references', { count: version.references_count })}` })) }),
          (detail.references || []).map(reference => h('small', { key: reference.id, title: reference.id }, t('conversations.referenceTask', { requirement: reference.requirementId, version: reference.version.slice(0, 8) }))),
          detail.snapshot.version !== detail.entry.snapshotVersion && h(Button, { disabled: busy, onClick: () => setDeleting({ id: detail.entry.conversationId, version: detail.snapshot.version }) }, t('conversations.deleteVersion')),
          h('pre', { className: css.transcript }, detail.snapshot.turns.map(turn => turn.messages.map(message => `${message.label}\n\n${message.text}`).join('\n\n')).join('\n\n')))),
      jobs.slice(0, 3).map(job => h('div', { key: job.id, className: css.job, role: 'status' }, `${job.source === 'dsh' ? 'DSH' : 'Codex'} · ${jobStatus(job.status)} · ${job.total == null ? t('conversations.pendingTotal') : `${job.completed}/${job.total}`}`, ['running', 'queued', 'cancelling'].includes(job.status) && h(Button, { disabled: busy, onClick: async () => { try { await request('cancel', {}); await load(); } catch (error) { setError(error.message); } } }, t('common.cancel')))),
      h('div', { className: 'rh-modal-actions' }, h(Button, { onClick: onClose }, t('common.close')))),
    deleting && h(ConfirmDialog, { title: t('conversations.delete'), message: t('conversations.confirmDelete'), variant: 'danger', onConfirm: remove, onCancel: () => setDeleting(null) }),
    importingKnowledge && h(ConversationKnowledgeImport, { key: workspaceId, initialTarget: workspaceId, onClose: () => setImportingKnowledge(false) }));
}
module.exports = { ConversationManager };
