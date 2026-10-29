'use strict';
const { Checkbox } = require('./shared/controls.js');
const { DocumentAssist } = require('./ContextAssist.js');
const { t } = require('../locale.js');
const css = require('./WritingPanel.module.css').default;
const { Button } = require('./shared/Button.js');
const { ConfirmModal } = require('./ConfirmModal.js');
const { showToast } = require('./shared/ToastContainer.js');
const React = require('react');
const { createPortal } = require('react-dom');
const { Select } = require('./shared/Select.js');
const h = React.createElement;
const { ROUTE } = require('../constants.js');
const { MilkdownEditor } = require('./MilkdownEditor.js');
const { useDiffReview, reviewParts: writingChanges, mergeParts: mergedWriting } = require('./shared/DiffReviewPage.js');
const { SessionSelectionContext } = require('../context.js');
const { AiTaskStatus } = require('./shared/AiTaskStatus.js');
function loadScopeSelection(key) {
  try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : null; } catch { return null; }
}
function writingError(code, details) {
  if (code === 'ENHANCEMENT_INPUT_CHANGED' || code === 'WRITING_KNOWLEDGE_STALE') {
    const sources = details?.sources?.map(source => source.relativePath).filter(Boolean).join('、');
    return t(code === 'WRITING_KNOWLEDGE_STALE' ? 'writing.knowledgeStale' : 'writing.referenceChanged') + (sources ? t('writing.changedSource', { workspace: details.workspaceTitle || '', path: sources }) : '');
  }
  if (/^ENHANCEMENT_(BUDGET_EXCEEDED|SCOPE_DENIED|INVALID_INPUT)$/.test(code || '')) return t(`enhancement.error.${code}`);
  if (['WRITING_IMAGE_INVALID', 'WRITING_IMAGE_TOO_LARGE', 'WRITING_IMAGE_CONFLICT', 'WRITING_INLINE_IMAGES', 'WRITING_CONTENT_REQUIRED', 'WRITING_CONTENT_TOO_LONG', 'WRITING_INSTRUCTION_TOO_LONG'].includes(code)) return t(`writing.error.${code}`);
  if (code === 'WRITING_RESULT_INCOMPLETE') return t('writing.resultIncomplete');
  if (code === 'WRITING_REQUIREMENT_BUSY') return t('writing.requirementBusy');
  if (code === 'WRITING_REQUIREMENT_INVALID') return t('writing.requirementInvalid');
  return code;
}
async function request(path, body, signal) {
  const response = await fetch(`${ROUTE}/writing${path}`, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error === 'WRITING_SESSION_DENIED' ? t('enhancement.sessionDenied') : writingError(data.error, data.details) || t("WritingPanel.message001")), { status: response.status, code: data.error, details: data.details }); return data;
}
function loadDraft(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return Object.fromEntries(['requirement', 'design'].filter(type => typeof saved?.[type] === 'string').map(type => [type, saved[type]]));
  } catch { return {}; }
}

function writingDraftKey(workspaceId, requirementPath, docsDir = 'docs') {
  return `req-hub:writing:${JSON.stringify([workspaceId, docsDir, requirementPath?.replaceAll('\\', '/') || null])}`;
}
function WritingPanelBody({ workspaceId, requirement, onSaved, active = true, toolbarTarget, docsDir = 'docs' }) {
  const currentSession = React.useContext(SessionSelectionContext);
  // Each requirement owns its drafts and result decisions; scope selection stays workspace-wide.
  const requirementPath = requirement?.path?.replaceAll('\\', '/') || null;
  const storageKey = writingDraftKey(workspaceId, requirementPath, docsDir);
  const activeRef = React.useRef(active); activeRef.current = active;
  const [draft, setDraft] = React.useState(() => loadDraft(storageKey));
  const [docType, setDocType] = React.useState('requirement');
  const [options, setOptions] = React.useState(null);
  const scopeKey = `req-hub:writing-scopes:${workspaceId}`;
  const [savedScopes, setSavedScopes] = React.useState(() => loadScopeSelection(scopeKey));
  const scopeIds = savedScopes ?? options?.scopes.filter(scope => scope.workspaceId === workspaceId).map(scope => scope.id) ?? [];
  const selectScopes = ids => { setSavedScopes(ids); try { localStorage.setItem(scopeKey, JSON.stringify(ids)); } catch { setError(t('WritingPanel.message002')); } };
  const review = useDiffReview();
  const [task, setTask] = React.useState(null);
  const [referenceRefs, setReferenceRefs] = React.useState([]);
  React.useEffect(() => setReferenceRefs([]), [requirement?.path]);
  const [instruction, setInstruction] = React.useState('');
  const [instructionExpanded, setInstructionExpanded] = React.useState(false);
  const instructionId = React.useId();
  const [error, setError] = React.useState('');
  const [recovering, setRecovering] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [jobId, setJobId] = React.useState(null);
  const [proposal, setProposal] = React.useState(null);
  const [starter, setStarter] = React.useState('');
  const [imagesPending, setImagesPending] = React.useState(false);
  const [imagesError, setImagesError] = React.useState('');
  const [imageRetry, retryImages] = React.useReducer(value => value + 1, 0);
  const [saving, setSaving] = React.useState(false), [pendingSave, setPendingSave] = React.useState(null);
  const saveRef = React.useRef(null);
  const jobRef = React.useRef(null), operationRef = React.useRef(null), pollTimer = React.useRef(null);
  const draftRef = React.useRef(draft); draftRef.current = draft;
  const content = draft[docType] || '';
  const setContent = value => setDraft(previous => ({ ...previous, [docType]: value }));
  React.useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { setError(t("WritingPanel.message002")); } }, [draft, storageKey]);
  React.useEffect(() => {
    if (!/data:image\//i.test(content)) { setImagesPending(false); setImagesError(''); return; }
    if (!requirementPath) { setImagesError(t('writing.imagesTarget')); return; }
    const controller = new AbortController(); setImagesPending(true); setImagesError('');
    const timer = setTimeout(async () => {
      try {
        const result = await request('/assets', { workspaceId, requirementPath, content }, controller.signal);
        if (!controller.signal.aborted) { setContent(result.content); setImagesPending(false); setError(''); }
      } catch (error) { if (!controller.signal.aborted) { setImagesPending(false); setImagesError(error.message); } }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [content, requirementPath, workspaceId, imageRetry]);
  const refresh = React.useCallback(() => {
    const controller = new AbortController();
    request('/options', null, controller.signal).then(data => { setOptions(data); setError(''); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  React.useEffect(refresh, [refresh]);
  React.useEffect(() => () => {
    saveRef.current?.abort();
    operationRef.current?.abort(); clearTimeout(pollTimer.current);
    // View teardown stops observation only. The Host owns the running task.
  }, []);
  React.useEffect(() => { setPendingSave(null); }, [requirement?.id, requirement?.path]);
  const dismissedKey = `req-hub:writing-dismissed:${storageKey}`;
  const dismiss = id => { try { localStorage.setItem(dismissedKey, id); } catch {} };
  const watch = (job, controller, autoOpen) => {
    jobRef.current = job.id; setJobId(job.id); setTask(job);
    setInstructionExpanded(false);
    setRunning(['running', 'cancelling'].includes(job.status)); setCancelling(job.status === 'cancelling');
    const poll = async () => {
      try {
        const state = await request(`/jobs/${job.id}`, null, controller.signal);
        if (controller.signal.aborted) return;
        setTask(state);
        if (['running','cancelling'].includes(state.status)) { pollTimer.current = setTimeout(poll, 1000); return; }
        setRunning(false); setCancelling(false); jobRef.current = null; setJobId(null);
        if (state.status === 'completed') {
          const candidate = { ...state.result, jobId: job.id, docType: job.docType || docType, parts: writingChanges(state.result.original, state.result.content) };
          setProposal(candidate); if (autoOpen && activeRef.current) openProposal(candidate, job.docType || docType); else if (autoOpen) showToast({ text: t('writing.reviewReady'), tone: 'success' });
        }
        else if (state.status === 'failed') setError(state.error === 'WRITING_TOOL_FAILED' ? t('writing.toolFailed') : writingError(state.error, state.errorDetails) || t("WritingPanel.message004"));
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e.message);
        if (e.status === 404) { setRunning(false); jobRef.current = null; setJobId(null); }
        else pollTimer.current = setTimeout(poll, 3000);
      }
    };
    void poll();
  };
  React.useEffect(() => {
    const controller = new AbortController(); operationRef.current = controller;
    request(`/jobs?workspaceId=${encodeURIComponent(workspaceId)}&requirementPath=${encodeURIComponent(requirementPath || '')}`, null, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      const job = data.jobs?.[0];
      let dismissed; try { dismissed = localStorage.getItem(dismissedKey); } catch {}
      if (job && (['running', 'cancelling'].includes(job.status) || job.id !== dismissed)) {
        setDocType(job.docType); watch(job, controller, false);
      }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setRecovering(false); });
    return () => { controller.abort(); clearTimeout(pollTimer.current); };
  }, [workspaceId]);
  const optimize = async () => {
    setError(''); setRunning(true); setTask({ createdAt: Date.now(), activity: { stage: 'preparing' } });
    const controller = new AbortController(); operationRef.current = controller;
    try {
      const sessionId = currentSession();
      if (!sessionId) throw new Error(t("WritingPanel.message003"));
      const job = await request('/optimize', { workspaceId, requirementPath, docType, content, instruction, scopeIds, referenceRefs, sessionId }, controller.signal);
      if (controller.signal.aborted) return;
      watch(job, controller, true);
    } catch (e) { if (!controller.signal.aborted) { setError(/^ENHANCEMENT_/.test(e.message) ? t('enhancement.error', { code: e.message }) : e.message); setRunning(false); } }
  };
  const cancel = async () => {
    try {
      if (!jobRef.current || cancelling) return;
      setCancelling(true);
      await request(`/jobs/${jobRef.current}/cancel`, {});
    } catch (e) { setCancelling(false); setError(e.message); }
  };
  const openProposal = (candidate, targetType = candidate.docType || docType) => review.open({
    oldContent: candidate.original, newContent: candidate.content, fileName: `${targetType}.md`,
    overview: candidate.overview, evidence: candidate.evidence, initialParts: candidate.parts,
    onPartsChange: parts => setProposal(previous => previous ? { ...previous, parts } : previous),
    onComplete: merged => { if ((draftRef.current[targetType] || '') !== candidate.original) return false; setDraft(previous => ({ ...previous, [targetType]: merged })); dismiss(candidate.jobId); setProposal(null); },
  });
  const save = async (snapshot, expectedVersion) => {
    if (saving) return;
    const payload = snapshot || { workspaceId, requirementId: requirement?.id, requirementPath: requirement?.path, docType, content };
    if (!payload.requirementId || !payload.requirementPath) { setError(t('writing.saveTargetRequired')); return; }
    const controller = new AbortController(); saveRef.current = controller; setSaving(true); setError('');
    try {
      const result = await request('/save', { ...payload, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      setPendingSave(null); showToast({ tone: 'success', text: t('writing.saved', { path: result.path }) }); onSaved?.();
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e.code === 'WRITING_FILE_EXISTS' || e.code === 'WRITING_SAVE_CONFLICT' && e.details?.version) setPendingSave({ payload, version: e.details.version, filename: e.details.filename, conflict: e.code === 'WRITING_SAVE_CONFLICT' });
      else setError(t(e.code === 'WRITING_SAVE_TARGET_REQUIRED' ? 'writing.saveTargetRequired' : 'writing.saveFailed'));
    } finally { if (saveRef.current === controller) { saveRef.current = null; setSaving(false); } }
  };
  const locked = imagesPending || !!imagesError || recovering || running || !!proposal || saving || !!pendingSave;
  const toolbar = h('div', { className: `${css.toolbar}${toolbarTarget ? ` ${css.inHeader}` : ''}` },
      h('label', null, t("WritingPanel.message005"), h(Select, { value: docType, disabled: locked, onChange: e => { setDocType(e.target.value); setStarter(''); } }, h('option', { value: 'requirement' }, t("DocsViewerBody.message073")), h('option', { value: 'design' }, t("documents.design")))),
      h('label', null, t("WritingPanel.message006"), h(Select, { value: starter, disabled: locked, onChange: e => setStarter(e.target.value) }, h('option', { value: '' }, t("WritingPanel.message007")), h('option', { value: docType }, options?.starters?.[docType]?.label || t("WritingPanel.message008")))),
      h(Button, { className: 'rh-btn rh-btn-ghost', disabled: locked || !!content.trim() || !options, onClick: () => setContent(starter ? options.starters[starter].content : '') }, t("WritingPanel.message009")),
      h(Button, { className: 'rh-btn rh-btn-ghost', disabled: locked || !content.trim(), onClick: () => save() }, t(saving ? 'writing.saving' : 'common.save')));
  if (review.page) return review.page;
  return h('div', { className: `rh-writing-panel ${css.panel}` },
    toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar,
    h('div', { className: css.content },
    h('details', { className: 'rh-writing-sources', open: true }, h('summary', null, t("WritingPanel.message011", { value0: scopeIds.length })),
      h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: refresh, disabled: running }, t("WritingPanel.message012")),
      options?.scopes.map(scope => h('div', { key: scope.id, className: 'rh-writing-scope', title: scope.docsRoot }, h(Checkbox, { disabled: locked, checked: scopeIds.includes(scope.id), onChange: checked => selectScopes(checked ? [...scopeIds, scope.id] : scopeIds.filter(id => id !== scope.id)), label: t("WritingPanel.message013", { value0: scope.title, value1: scope.entryCount }) }))),
      options?.scopes.length === 0 && h('p', null, t("WritingPanel.message014")),
      options && scopeIds.some(id => !options.scopes.some(scope => scope.id === id)) && h('p', { role: 'status' }, t('writing.missingScopes'), h(Button, { disabled: locked, onClick: () => selectScopes(scopeIds.filter(id => options.scopes.some(scope => scope.id === id))) }, t('writing.removeMissingScopes'))),
      h('small', null, scopeIds.length || referenceRefs.length ? t("WritingPanel.message015") : t("WritingPanel.message016"))),
    h(DocumentAssist, { key: requirement?.path || workspaceId, workspaceId, requirementPath: requirement?.path, mode: 'writing', draft: content, references: referenceRefs, onReferencesChange: setReferenceRefs, disabled: locked }),
    h('div', { className: css.editor },
      h('div', { className: css.editorHint }, t('writing.editorHint')),
      h(MilkdownEditor, { content, onChange: setContent, imageContext: { workspaceId, requirementPath }, readOnly: saving || !!pendingSave })),
    proposal && h('div', { className: 'rh-knowledge-toolbar' }, h(Button, { onClick: () => openProposal(proposal) }, t('review.resume')), h(Button, { onClick: () => { dismiss(proposal.jobId); setProposal(null); } }, t('review.discard')))),
    h('div', { className: css.footer },
    imagesPending && h('small', { className: css.runningHint, role: 'status' }, t('writing.imagesPending')),
    imagesError && h('div', { className: 'rh-knowledge-error', role: 'alert' }, imagesError, h(Button, { onClick: retryImages }, t('writing.imagesRetry'))),
    recovering && h('small', { className: css.runningHint, role: 'status' }, t('writing.restoring')),
    error && h('div', { className: 'rh-knowledge-error', role: 'alert' }, error),
    !running && task?.excludedSourceCount > 0 && h('details', { className: css.notice }, h('summary', null, t('writing.sourceNotice')), h('small', null, t('writing.excludedSources', { count: task.excludedSourceCount }))),
    running && h('div', { className: css.taskBar },
      h(AiTaskStatus, { startedAt: task?.createdAt, stage: task?.activity?.stage, activity: task?.activity, sessionId: task?.sessionId, searched: task?.activity?.searched, read: task?.activity?.read, cancelling, onCancel: cancel, cancelDisabled: !jobId,
        actions: h(Button, { size: 'sm', variant: 'ghost', 'aria-expanded': instructionExpanded, 'aria-controls': instructionId, onClick: () => setInstructionExpanded(value => !value) }, t(instructionExpanded ? 'writing.collapseInstruction' : 'writing.viewInstruction')) },
        h('div', { className: css.taskNotes },
          task?.excludedSourceCount > 0 && h('small', null, t('writing.excludedSources', { count: task.excludedSourceCount })),
          h('small', null, t('writing.runningHelp'))))),
    (!running || instructionExpanded) && h('div', { className: `${css.actions}${instructionExpanded ? ` ${css.expanded}` : ''}` },
      h('textarea', { id: instructionId, className: `rh-form-textarea ${css.instruction}`, rows: instructionExpanded ? 4 : 1, 'aria-label': t("WritingPanel.message017"), placeholder: t("WritingPanel.message018"), value: instruction, disabled: locked, maxLength: 4000, onChange: e => setInstruction(e.target.value) }),
      !running && h(Button, { size: 'sm', variant: 'ghost', 'aria-expanded': instructionExpanded, 'aria-controls': instructionId, onClick: () => setInstructionExpanded(value => !value) }, t(instructionExpanded ? 'writing.collapseInstruction' : 'writing.expandInstruction')),
      !running && h(Button, { className: 'rh-btn rh-btn-primary', disabled: locked || !content.trim() || !options || scopeIds.some(id => !options.scopes.some(scope => scope.id === id)), onClick: optimize }, t("WritingPanel.message020")))),
    pendingSave && h(ConfirmModal, { title: t('writing.overwriteTitle'), message: t(pendingSave.conflict ? 'writing.overwriteChanged' : 'writing.overwriteMessage', { path: `${pendingSave.payload.requirementPath}/${pendingSave.filename}` }),
      onCancel: () => setPendingSave(null), onConfirm: () => { const pending = pendingSave; setPendingSave(null); save(pending.payload, pending.version); } }));
}
function WritingPanel(props) { return h(WritingPanelBody, { ...props, key: writingDraftKey(props.workspaceId, props.requirement?.path, props.docsDir) }); }
module.exports = { WritingPanel, writingChanges, mergedWriting, writingDraftKey };
