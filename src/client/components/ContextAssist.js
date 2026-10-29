'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { Button } = require('./shared/Button.js');
const { Checkbox } = require('./shared/controls.js');
const { Select } = require('./shared/Select.js');
const { Input } = require('./shared/Input.js');
const { DiffViewer } = require('./shared/DiffViewer.js');
const { AiTaskStatus } = require('./shared/AiTaskStatus.js');
const { SessionSelectionContext } = require('../context.js');
const css = require('./ContextAssist.module.css').default;
const h = React.createElement;
const active = job => ['queued', 'preparing', 'running', 'cancelling'].includes(job?.status);
const state = value => t(`enhancement.state.${value || 'unavailable'}`);

function useAssist(workspaceId, context, revision) {
  const session = React.useContext(SessionSelectionContext);
  const key = JSON.stringify(context || null);
  const [data, setData] = React.useState(null), [job, setJob] = React.useState(null), [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false), [reload, refresh] = React.useReducer(value => value + 1, 0);
  const controller = React.useRef(null);
  const request = React.useCallback(async (path, body, signal) => {
    const headers = { ...(session() ? { 'x-session-id': session() } : {}) };
    const response = await fetch(`${ROUTE}/knowledge/enhancements/${path}${body ? '' : `${path.includes('?') ? '&' : '?'}workspaceId=${encodeURIComponent(workspaceId)}`}`, body
      ? { method: 'POST', signal, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, workspaceId }) } : { signal, headers });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || 'ENHANCEMENT_FAILED'); return value;
  }, [workspaceId, session]);
  React.useEffect(() => {
    const abort = new AbortController(); controller.current = abort; setJob(null); setData(null); setError(''); setBusy(false);
    return () => abort.abort();
  }, [workspaceId, key]);
  React.useEffect(() => {
    const abort = new AbortController();
    const path = context ? `context?${new URLSearchParams(Object.entries(context).filter(([, value]) => value !== undefined && value !== null))}` : 'jobs';
    request(path, null, abort.signal).then(value => {
      if (!abort.signal.aborted) { setData(value); setJob(old => old || value.jobs?.find(active) || null); }
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [workspaceId, key, reload, revision, request]);
  React.useEffect(() => {
    if (!active(job)) return;
    const abort = new AbortController(); let timer;
    const poll = async () => {
      try {
        const value = await request(`jobs/${job.id}`, null, abort.signal);
        if (abort.signal.aborted) return;
        setJob(value); if (active(value)) timer = setTimeout(poll, 1000); else refresh();
      } catch (error) { if (!abort.signal.aborted) { setError(error.message); timer = setTimeout(poll, 3000); } }
    };
    poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [job?.id, active(job), request]);
  const perform = async operation => {
    const signal = controller.current.signal; if (busy || signal.aborted) return;
    setBusy(true); setError('');
    try { await operation(signal); } catch (error) { if (!signal.aborted) setError(error.message); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const start = (kind, mode, draft, referenceRefs) => perform(async signal => {
    setJob(await request('jobs', { kind, mode, context, ...(draft !== undefined ? { draft } : {}), ...(referenceRefs ? { referenceRefs } : {}), requestKey: crypto.randomUUID(), sessionId: session(), useCode: kind === 'graph-build' }, signal));
  });
  return { data, job, setJob, busy, error, request, perform, start, refresh, locked: busy || active(job), cancel: () => perform(async signal => setJob(await request(`jobs/${job.id}/cancel`, {}, signal))) };
}

function TaskResult({ api }) {
  const { job } = api; if (!job) return null;
  const percent = job.activity?.percent;
  return h('section', { className: css.task, 'aria-label': t('enhancement.task') },
    h('div', { className: css.actions }, h('span', { role: 'status' }, state(job.status)), active(job) && h(Button, { size: 'sm', disabled: api.busy || job.status === 'cancelling', onClick: api.cancel }, t('enhancement.cancel'))),
    active(job) && job.kind !== 'code-index' && h(AiTaskStatus, { startedAt: job.createdAt, stage: job.activity?.stage, cancelling: job.status === 'cancelling' }),
    active(job) && job.kind === 'code-index' && h(React.Fragment, null,
      h('span', null, t(['index_preparing', 'index_running', 'mcp_status', 'mcp_query'].includes(job.activity?.stage) ? `enhancement.stage.${job.activity.stage}` : 'enhancement.stage.index_preparing')),
      h('progress', { max: 100, ...(Number.isFinite(percent) ? { value: percent } : {}), 'aria-label': t('enhancement.indexProgress') }),
      h('small', null, Number.isFinite(percent) ? `${percent}%` : t('enhancement.indexIndeterminate'))),
    job.error && h('p', { role: 'alert' }, t('enhancement.error', { code: job.error.code })),
    job.result?.indexUpdated && h('p', null, t('enhancement.indexUpdated')),
    job.result?.indexUpdated && job.result.code?.status !== 'ready' && h('small', null, t('enhancement.indexCheckPending')),
    job.result?.findings?.map(item => h('details', { key: item.id }, h('summary', null, item.reason || t(`enhancement.finding.${item.kind}`)),
      item.question && h('p', null, item.question), item.proposal && h(DiffViewer, { oldContent: item.evidence?.[0]?.quote || '', newContent: item.proposal, fileName: item.subject || 'proposal', oldLabel: t('enhancement.fragmentOriginal'), newLabel: t('enhancement.fragmentProposal') }), h('pre', null, JSON.stringify(item.evidence, null, 2)))),
    job.result?.patterns?.map(item => h('details', { key: item.id }, h('summary', null, t('enhancement.patterns')), h('pre', null, item.content), h('div', { className: css.actions }, ['confirmed', 'rejected'].map(decision => h(Button, { key: decision, size: 'sm', disabled: api.locked || item.status === decision, onClick: () => api.perform(async signal => api.setJob(await api.request('reviews', { jobId: job.id, expectedSeq: job.seq, resultId: item.id, decision }, signal))) }, state(decision)))))),
    job.indexLogs?.length > 0 && h('details', { open: active(job) }, h('summary', null, t('enhancement.indexLogs')), h('pre', null, job.indexLogs.join('\n'))));
}

function CodeStatus({ api }) {
  const code = api.job?.result?.code || api.data?.graph?.code;
  return h('div', { className: css.stack },
    h('p', null, t('enhancement.mcp', { status: state(code?.status) })),
    code?.indexedAt && h('small', null, t('enhancement.indexVersion', { date: code.indexedAt, commit: code.lastCommit || '' })),
    h('div', { className: css.actions },
      h(Button, { size: 'sm', disabled: api.locked, onClick: () => api.start('code-refresh') }, t('enhancement.refreshCode')),
      ['stale', 'not_indexed'].includes(code?.status) && h(Button, { size: 'sm', disabled: api.locked, onClick: () => api.start('code-index') }, t('enhancement.updateIndex'))));
}
function TaskHistory({ api }) {
  if (!api.data?.jobs?.length) return null;
  return h('details', null, h('summary', null, t('enhancement.history')), h('div', { className: `${css.stack} ${css.history}` }, api.data.jobs.map(job => h(Button, { key: job.id, size: 'sm', disabled: api.busy, onClick: () => api.perform(async signal => api.setJob(await api.request(`jobs/${job.id}`, null, signal))) }, `${t(`enhancement.kind.${job.kind}`)} · ${state(job.status)} · ${new Date(job.createdAt).toLocaleString()}`))));
}

function EnhancementSettings({ workspaceId }) {
  const api = useAssist(workspaceId), data = api.data;
  const configure = values => api.perform(async signal => {
    const current = await fetch(`${ROUTE}/config`, { signal }); if (!current.ok) throw new Error('ENHANCEMENT_FAILED');
    const config = await current.json();
    const result = await fetch(`${ROUTE}/config`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enhancements: { ...config.enhancements, ...values } }) });
    if (!result.ok) throw new Error('ENHANCEMENT_FAILED'); api.refresh();
  });
  return h('section', { className: css.settings, 'aria-label': t('assist.settings') },
    h('h3', null, t('assist.settings')), h('p', null, t('assist.settingsHelp')),
    api.error && h('p', { role: 'alert' }, t('enhancement.error', { code: api.error })),
    !data ? h('p', null, t('common.loading')) : h(React.Fragment, null,
      h(Checkbox, { checked: data.enabled, disabled: api.locked, label: t('assist.enable'), onChange: enabled => configure({ enabled }) }),
      h('label', { className: css.field }, t('enhancement.mcpServer'), h(Select, { disabled: api.locked, value: data.mcpServer || 'gitnexus', onChange: event => configure({ gitnexusServer: event.target.value }) },
        [...new Set([data.mcpServer || 'gitnexus', ...data.mcpServers || []])].map(server => h('option', { key: server, value: server }, server)))),
      h('p', null, t('enhancement.mcpRegistration', { server: data.mcpServer || 'gitnexus', status: t(data.mcpAvailable ? 'enhancement.mcpRegistered' : 'enhancement.mcpAbsent') })),
      h(CodeStatus, { api }), h(TaskResult, { api }), h(TaskHistory, { api })));
}

function DocumentAssist({ workspaceId, path, documentId, requirementPath, mode = 'document', draft, revision, dirty, onOpenSource, references = [], onReferencesChange, disabled }) {
  const context = { ...(path ? { path } : {}), ...(documentId ? { documentId } : {}), ...(requirementPath ? { requirementPath } : {}) };
  const api = useAssist(workspaceId, context, revision), data = api.data;
  const locked = api.locked || disabled || dirty;
  const graph = data?.graph;
  const [depth, setDepth] = React.useState(2), [impact, setImpact] = React.useState(null);
  const [sourceId, setSourceId] = React.useState(''), [targetId, setTargetId] = React.useState(''), [note, setNote] = React.useState('');
  const [checkedDraft, setCheckedDraft] = React.useState(undefined);
  const review = (relation, decision) => api.perform(async signal => {
    await api.request('reviews', { expectedRevision: graph.id, expectedReviewSeq: graph.reviewSeq, resultId: relation.id, basisHash: relation.basisHash, decision }, signal); api.refresh();
  });
  const choose = (doc, checked) => onReferencesChange(checked ? [...references.filter(item => item.id !== doc.id), { id: doc.id, scopeId: doc.scopeId, version: doc.version }] : references.filter(item => item.id !== doc.id));
  return h('details', { className: css.assist }, h('summary', null, t(mode === 'sync' ? 'assist.sync' : mode === 'writing' ? 'assist.writing' : 'assist.document'), api.locked ? ` · ${state(api.job?.status || 'preparing')}` : ''),
    h('div', { className: css.stack },
      api.busy && !active(api.job) && h('p', { role: 'status' }, t('ai.preparing')),
      api.error && h('p', { role: 'alert' }, t('enhancement.error', { code: api.error })),
      !data ? h('p', null, t('common.loading')) : h(React.Fragment, null,
        !data.enabled && h('p', null, t('assist.disabled')),
        dirty && h('p', null, t('knowledgeLayout.saveFirst')),
        api.job && checkedDraft !== undefined && checkedDraft !== draft && h('p', { role: 'status' }, t('assist.draftChanged')),
        data.limited && h('p', { role: 'status' }, t('assist.limited')),
        data.impactLimited && h('p', { role: 'status' }, t('enhancement.truncated')),
        (mode === 'document' && !data.indexed || mode === 'sync' && !data.documentRefs?.length) && h('p', null, t('assist.importFirst')),
        h('p', { className: css.hint }, t(mode === 'sync' ? 'assist.syncHelp' : 'assist.referenceHelp')),
        onReferencesChange && h('p', { className: css.hint }, t('assist.selectedReferences', { count: references.length })),
        data.related?.map(doc => h('div', { key: doc.id, className: css.related },
          onReferencesChange && h(Checkbox, { disabled: locked || references.length >= 30 && !references.some(item => item.id === doc.id), checked: references.some(item => item.id === doc.id), label: doc.title, onChange: checked => choose(doc, checked) }),
          h(Button, { size: 'sm', disabled: !onOpenSource, title: doc.path, onClick: () => onOpenSource?.({ relativePath: doc.path, workspaceId, title: doc.title }) }, doc.path),
          h('small', null, doc.reasons.map(reason => t(`assist.reason.${reason}`)).join(' · '), doc.confirmed ? ` · ${state('confirmed')}` : ''))),
        !data.related?.length && h('p', null, t('assist.noRelated')),
        h('div', { className: css.actions },
          (mode !== 'sync' ? [['quality-check', 'rules', 'enhancement.rules'], ['quality-check', 'semantic', 'enhancement.semantic'], ...(mode === 'writing' ? [['pattern-propose', null, 'enhancement.patterns']] : [])] : [['consistency-check', null, 'enhancement.consistency']]).map(([kind, type, label]) => h(Button, { size: 'sm', key: label, disabled: locked || !data.enabled || !(draft?.trim() || data.documentRefs?.length), onClick: () => { setCheckedDraft(draft); api.start(kind, type, draft, references); } }, t(label))),
          h(Button, { size: 'sm', disabled: locked, onClick: api.refresh }, t('enhancement.refresh'))),
        h(TaskResult, { api }), h(TaskHistory, { api }),
        graph?.relations?.length > 0 && h('details', null, h('summary', null, t('assist.review')), h('div', { className: css.stack }, graph.relations.map(relation => h('div', { key: relation.id, className: css.related },
          h('span', null, `${graph.entities.find(item => item.id === relation.sourceId)?.key} → ${graph.entities.find(item => item.id === relation.targetId)?.key}`),
          h('small', null, t(`enhancement.relation.${relation.type}`), ` · ${state(relation.reviewState)}`),
          h('details', null, h('summary', null, t('enhancement.evidence')), h('pre', null, JSON.stringify(relation.evidence, null, 2))),
          h('div', { className: css.actions }, ['confirmed', 'rejected'].map(decision => h(Button, { key: decision, size: 'sm', disabled: locked || graph.stale || relation.reviewState === decision, onClick: () => review(relation, decision) }, state(decision)))))))),
        h('details', null, h('summary', null, t('assist.advanced')), h('div', { className: css.stack },
          h(CodeStatus, { api }),
          h(Button, { size: 'sm', disabled: locked || !data.enabled || !data.documentRefs?.length || data.limited, onClick: () => api.start('graph-build') }, t('assist.refreshRelations')),
          graph && h(React.Fragment, null,
            h('label', { className: css.field }, t('enhancement.depth'), h(Input, { type: 'number', min: 1, max: data.limits?.maxDepth || 5, value: depth, onChange: event => setDepth(Number(event.target.value)) })),
            h('div', { className: css.actions }, graph.entities.filter(entity => entity.documents.some(doc => data.documentRefs.some(ref => ref.id === doc.id))).map(entity => h(Button, { key: entity.id, size: 'sm', disabled: locked || graph.stale, onClick: () => api.perform(async signal => setImpact(await api.request(`../graph/impact?entityId=${entity.id}&revision=${graph.id}&reviewSeq=${graph.reviewSeq}&direction=dependents&depth=${depth}`, null, signal))) }, t('enhancement.impact')))),
            impact && h('div', { className: css.stack }, impact.results.map(item => h('div', { key: item.id },
              h('p', null, graph.entities.find(entity => entity.id === item.id)?.key || item.id),
              (graph.entities.find(entity => entity.id === item.id)?.documents || []).map(doc => h(Button, { key: doc.id, size: 'sm', disabled: !onOpenSource, title: doc.path, onClick: () => onOpenSource?.({ relativePath: doc.path, workspaceId }) }, doc.path)))),
              impact.truncated && h('p', null, t('enhancement.truncated'))),
            h('div', { className: css.fields }, [[sourceId, setSourceId, 'enhancement.from'], [targetId, setTargetId, 'enhancement.to']].map(([value, update, label]) => h('label', { key: label, className: css.field }, t(label), h(Select, { disabled: locked, value, onChange: event => update(event.target.value) }, h('option', { value: '' }, t(label)), graph.entities.map(entity => h('option', { key: entity.id, value: entity.id }, entity.key)))))),
            h(Input, { 'aria-label': t('enhancement.note'), placeholder: t('enhancement.note'), value: note, maxLength: 1000, disabled: locked, onChange: event => setNote(event.target.value) }),
            h('div', { className: css.actions }, h(Button, { size: 'sm', disabled: locked || graph.stale || !sourceId || !targetId || sourceId === targetId || !note.trim(), onClick: () => api.perform(async signal => { await api.request('reviews', { expectedRevision: graph.id, expectedReviewSeq: graph.reviewSeq, sourceId, targetId, note }, signal); setNote(''); api.refresh(); }) }, t('enhancement.addManual')))))))));
}
module.exports = { DocumentAssist, EnhancementSettings };
