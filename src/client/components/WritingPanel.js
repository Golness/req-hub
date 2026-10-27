'use strict';
const { Checkbox } = require('./shared/controls.js');
const { t } = require('../locale.js');
const css = require('./WritingPanel.module.css').default;
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const React = require('react');
const { Select } = require('./shared/Select.js');
const h = React.createElement;
const { ROUTE } = require('../constants.js');
const { MilkdownEditor } = require('./MilkdownEditor.js');
const { DiffViewer } = require('./shared/DiffViewer.js');
const { diffLines } = require('diff');

function writingChanges(before, after) {
  const parts = [];
  for (const change of diffLines(before, after)) {
    if (!change.added && !change.removed) { parts.push({ text: change.value }); continue; }
    let part = parts.at(-1);
    if (!part || part.text !== undefined) { part = { before: '', after: '', decision: null }; parts.push(part); }
    part[change.added ? 'after' : 'before'] += change.value;
  }
  return parts;
}
const mergedWriting = parts => parts.map(p => p.text ?? (p.decision === 'accept' ? p.after : p.before)).join('');
async function request(path, body, signal) {
  const response = await fetch(`${ROUTE}/writing${path}`, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || t("WritingPanel.message001")), { status: response.status }); return data;
}
function loadDraft(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return Object.fromEntries(['requirement', 'design'].filter(type => typeof saved?.[type] === 'string').map(type => [type, saved[type]]));
  } catch { return {}; }
}

function WritingPanel({ workspaceId }) {
  // Workspace-keyed parent keeps the two document types independent.
  const storageKey = `req-hub:writing:${workspaceId}`;
  const [draft, setDraft] = React.useState(() => loadDraft(storageKey));
  const [docType, setDocType] = React.useState('requirement');
  const [scopeIds, setScopeIds] = React.useState([]);
  const [options, setOptions] = React.useState(null);
  const [instruction, setInstruction] = React.useState('');
  const [error, setError] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [jobId, setJobId] = React.useState(null);
  const [proposal, setProposal] = React.useState(null);
  const [starter, setStarter] = React.useState('');
  const jobRef = React.useRef(null), operationRef = React.useRef(null), pollTimer = React.useRef(null);
  const content = draft[docType] || '';
  const setContent = value => setDraft(previous => ({ ...previous, [docType]: value }));
  React.useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { setError(t("WritingPanel.message002")); } }, [draft, storageKey]);
  const refresh = React.useCallback(() => {
    const controller = new AbortController();
    request('/options', null, controller.signal).then(data => { setOptions(data); setError(''); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  React.useEffect(refresh, [refresh]);
  React.useEffect(() => () => {
    operationRef.current?.abort(); clearTimeout(pollTimer.current);
    if (jobRef.current) void request(`/jobs/${jobRef.current}/cancel`, {}).catch(() => {});
  }, []);
  const optimize = async () => {
    setError(''); setRunning(true);
    const controller = new AbortController(); operationRef.current = controller;
    try {
      const sessionId = window.__DSH_CTX__?.get?.('uiWorkspace')?.selection?.getSnapshot?.()?.sessionId;
      if (!sessionId) throw new Error(t("WritingPanel.message003"));
      const job = await request('/optimize', { workspaceId, docType, content, instruction, scopeIds, sessionId }, controller.signal);
      jobRef.current = job.id; setJobId(job.id);
      const poll = async () => {
        try {
          const state = await request(`/jobs/${job.id}`, null, controller.signal);
          if (controller.signal.aborted) return;
          if (state.status === 'running') { pollTimer.current = setTimeout(poll, 1000); return; }
          setRunning(false); jobRef.current = null; setJobId(null);
          if (state.status === 'completed') setProposal({ ...state.result, parts: writingChanges(state.result.original, state.result.content) });
          else if (state.status === 'failed') setError(state.error || t("WritingPanel.message004"));
        } catch (e) {
          if (controller.signal.aborted) return;
          setError(e.message);
          if (e.status === 404) { setRunning(false); jobRef.current = null; setJobId(null); }
          else pollTimer.current = setTimeout(poll, 3000);
        }
      };
      void poll();
    } catch (e) { if (!controller.signal.aborted) { setError(e.message); setRunning(false); } }
  };
  const cancel = async () => {
    try {
      if (jobRef.current) await request(`/jobs/${jobRef.current}/cancel`, {});
      operationRef.current?.abort(); clearTimeout(pollTimer.current); jobRef.current = null; setJobId(null); setRunning(false);
    } catch (e) { setError(e.message); }
  };
  const decide = (index, decision) => {
    const parts = proposal.parts.map((p, i) => i === index ? { ...p, decision } : p);
    setContent(mergedWriting(parts));
    if (parts.every(p => p.text !== undefined || p.decision)) setProposal(null);
    else setProposal({ ...proposal, parts });
  };
  const finish = accept => {
    const parts = proposal.parts.map(p => p.text !== undefined || p.decision ? p : { ...p, decision: accept ? 'accept' : 'reject' });
    setContent(mergedWriting(parts)); setProposal(null);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${docType}.md`; anchor.click(); URL.revokeObjectURL(url);
  };
  const locked = running || !!proposal;
  return h('div', { className: 'rh-writing-panel' },
    h('div', { className: 'rh-knowledge-toolbar' },
      h('label', null, t("WritingPanel.message005"), h(Select, { value: docType, disabled: locked, onChange: e => { setDocType(e.target.value); setStarter(''); } }, h('option', { value: 'requirement' }, t("DocsViewerBody.message073")), h('option', { value: 'design' }, t("documents.design")))),
      h('label', null, t("WritingPanel.message006"), h(Select, { value: starter, disabled: locked, onChange: e => setStarter(e.target.value) }, h('option', { value: '' }, t("WritingPanel.message007")), h('option', { value: docType }, options?.starters?.[docType]?.label || t("WritingPanel.message008")))),
      h(Button, { className: 'rh-btn rh-btn-ghost', disabled: locked || !!content.trim() || !options, onClick: () => setContent(starter ? options.starters[starter].content : '') }, t("WritingPanel.message009")),
      h(Button, { className: 'rh-btn rh-btn-ghost', disabled: !content, onClick: download }, t("WritingPanel.message010"))),
    h('details', { className: 'rh-writing-sources', open: true }, h('summary', null, t("WritingPanel.message011", { value0: scopeIds.length })),
      h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: refresh, disabled: running }, t("WritingPanel.message012")),
      options?.scopes.map(scope => h('div', { key: scope.id, className: 'rh-writing-scope', title: scope.docsRoot }, h(Checkbox, { disabled: locked, checked: scopeIds.includes(scope.id), onChange: checked => setScopeIds(ids => checked ? [...ids, scope.id] : ids.filter(id => id !== scope.id)), label: t("WritingPanel.message013", { value0: scope.title, value1: scope.entryCount }) }))),
      options?.scopes.length === 0 && h('p', null, t("WritingPanel.message014")),
      h('small', null, scopeIds.length ? t("WritingPanel.message015") : t("WritingPanel.message016"))),
    error && h('div', { className: 'rh-knowledge-error', role: 'alert' }, error),
    h('div', { className: css.editor },
      h('div', { className: css.editorHint }, t('writing.editorHint')),
      h(MilkdownEditor, { content, onChange: setContent, readOnly: locked })),
    h('div', { className: 'rh-knowledge-toolbar' },
      h(Input, { className: 'rh-search-input', 'aria-label': t("WritingPanel.message017"), placeholder: t("WritingPanel.message018"), value: instruction, disabled: locked, maxLength: 4000, onChange: e => setInstruction(e.target.value) }),
      h(Button, { className: 'rh-btn rh-btn-primary', disabled: locked || !content.trim() || !options, onClick: optimize }, running ? t("WritingPanel.message019") : t("WritingPanel.message020")),
      running && h(Button, { className: 'rh-btn rh-btn-ghost', onClick: cancel, disabled: !jobId }, t("common.cancel"))),
    proposal && h('section', { className: 'rh-writing-proposal', 'aria-label': t("WritingPanel.message021") },
      h('div', { className: 'rh-knowledge-toolbar' }, h('strong', null, t("WritingPanel.message022")),
        h(Button, { className: 'rh-btn rh-btn-primary', onClick: () => finish(true) }, t("WritingPanel.message023")),
        h(Button, { className: 'rh-btn rh-btn-ghost', onClick: () => finish(false) }, t("WritingPanel.message024"))),
      h(DiffViewer, { oldContent: proposal.original, newContent: proposal.content, fileName: `${docType}.md`, oldLabel: t("WritingPanel.message025"), newLabel: t("WritingPanel.message026") }),
      proposal.parts.map((part, index) => part.text !== undefined || part.decision ? null : h('div', { key: index, className: 'rh-writing-change' },
        h(DiffViewer, { oldContent: part.before, newContent: part.after, fileName: t("WritingPanel.message027", { value0: index + 1 }) }),
        h(Button, { className: 'rh-btn rh-btn-primary', onClick: () => decide(index, 'accept') }, t("WritingPanel.message028")),
        h(Button, { className: 'rh-btn rh-btn-ghost', onClick: () => decide(index, 'reject') }, t("WritingPanel.message029")))),
      h('details', null, h('summary', null, t("WritingPanel.message030", { value0: proposal.evidence.length })), proposal.evidence.map(item => h('p', { key: item.id }, `${item.workspaceTitle} · ${item.sources.map(s => s.relativePath).join('、')} · v${item.version}`))),
      h('small', null, t("WritingPanel.message031"))));
}
module.exports = { WritingPanel, writingChanges, mergedWriting };
