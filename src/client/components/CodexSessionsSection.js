'use strict';
const { t } = require('../locale.js');
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Input } = require('./shared/Input.js');
const { Button } = require('./shared/Button.js');
const React = require('react');
const h = React.createElement;
const { ROUTE } = require('../constants.js');
const { SessionList } = require('./shared/SessionList.js');

const EMPTY = { ids: [], versions: {} };
function ImportWarnings({ warnings = [] }) {
  return warnings.length ? h('details', { className: 'rh-codex-warnings' },
    h('summary', null, t("CodexSessionsSection.message001", { value0: warnings.length })),
    h('ul', null, warnings.map((warning, index) => h('li', { key: index }, warning)))
  ) : null;
}
function WorkspacePicker({ workspaces, loading, error, warnings, onSelect, onClose }) {
  const [search, setSearch] = React.useState('');
  const needle = search.trim().toLowerCase();
  const visible = workspaces.filter(workspace => `${workspace.title} ${workspace.path}`.toLowerCase().includes(needle));
  return h(ModalFrame, { className: 'rh-modal-overlay', role: 'dialog', 'aria-modal': true, 'aria-label': t("CodexSessionsSection.message002"), onClick: onClose },
    h('div', { className: 'rh-modal', onClick: event => event.stopPropagation() },
      h('div', { className: 'rh-modal-title' }, t("CodexSessionsSection.message002")),
      h(Input, { className: 'rh-form-input', type: 'search', 'data-modal-autofocus': true, 'aria-label': t("CodexSessionsSection.message003"), placeholder: t("CodexSessionsSection.message004"), value: search, onChange: event => setSearch(event.target.value) }),
      error && h('p', { role: 'alert', className: 'rh-error' }, error),
      h(ImportWarnings, { warnings }),
      loading ? h('p', { role: 'status' }, t("CodexSessionsSection.message005"))
        : !visible.length ? h('p', { className: 'rh-sync-hint' }, t("CodexSessionsSection.message006"))
          : h('div', { className: 'rh-modal-list rh-codex-workspaces' }, visible.map(workspace => h(Button, {
            type: 'button', key: workspace.id, className: 'rh-btn rh-btn-ghost rh-codex-workspace', onClick: () => onSelect(workspace),
          }, h('strong', null, workspace.title), h('span', null, workspace.path || t("CodexSessionsSection.message007")), h('small', null, t("CodexSessionsSection.message008", { value0: workspace.sessionCount }))))),
      h('div', { className: 'rh-modal-actions' }, h(Button, { type: 'button', className: 'rh-btn', onClick: onClose }, t("common.close")))
    )
  );
}

function CodexSessionsSection({ workspaceId, selection, onSelectionChange, onView, disabled }) {
  const [data, setData] = React.useState({ workspace: null, sessions: [] });
  const [loading, setLoading] = React.useState(true);
  const [progress, setProgress] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [warnings, setWarnings] = React.useState([]);
  const [search, setSearch] = React.useState('');
  const [picker, setPicker] = React.useState(null);
  const requestId = React.useRef(0), mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);
  const request = async (action, body, onProgress) => {
    const response = await fetch(`${ROUTE}/codex/${action}${body ? '' : '?' + new URLSearchParams({ workspaceId })}`, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, ...body }),
    } : undefined);
    if (response.ok && response.headers?.get('content-type')?.includes('application/x-ndjson')) {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '', result;
      const consume = line => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === 'error') throw Error(event.error);
        if (event.type === 'progress') onProgress?.(event);
        if (event.type === 'result') result = event.result;
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          const lines = pending.split('\n'); pending = lines.pop();
          lines.forEach(consume);
          if (done) { consume(pending); break; }
        }
      } finally { reader.releaseLock(); }
      if (!result) throw Error(t("CodexSessionsSection.message009"));
      return result;
    }
    const result = await response.json();
    if (!response.ok || result.error) throw Error(result.error || t("CodexSessionsSection.message010"));
    return result;
  };
  const load = async (action, body) => {
    const id = ++requestId.current;
    setLoading(true); setError(null);
    setProgress(action === 'refresh' ? { phase: 'queued', completed: 0, total: null } : null);
    try {
      const result = await request(action, body, value => {
        if (mounted.current && id === requestId.current) setProgress(value);
      });
      if (!mounted.current || id !== requestId.current) return;
      const sessions = result.workspace ? result.sessions || [] : [];
      setData({ ...result, sessions }); setWarnings(result.warnings || []);
      const ids = action === 'refresh' ? [] : selection.ids.filter(selected => sessions.some(session => session.id === selected && session.snapshotVersion === selection.versions[selected] && session.syncTurnCount));
      if (ids.length !== selection.ids.length) onSelectionChange({ ids, versions: Object.fromEntries(ids.map(selected => [selected, selection.versions[selected]])) });
    } catch (error) { if (mounted.current && id === requestId.current) { setError(error.message); setData(previous => action === 'refresh' ? { ...previous, sessions: [] } : { workspace: null, sessions: [] }); onSelectionChange(EMPTY); } }
    finally { if (mounted.current && id === requestId.current) { setLoading(false); setProgress(null); } }
  };
  React.useEffect(() => { setData({ workspace: null, sessions: [] }); setSearch(''); load('sessions'); return () => { requestId.current++; }; }, [workspaceId]);
  const openPicker = async () => {
    setPicker({ loading: true, workspaces: [] });
    try {
      const result = await request('workspaces');
      if (mounted.current) setPicker(previous => previous && ({ loading: false, workspaces: result.workspaces || [], warnings: result.warnings || [] }));
    } catch (error) { if (mounted.current) setPicker(previous => previous && ({ loading: false, workspaces: [], error: error.message })); }
  };
  const refresh = projectId => {
    onSelectionChange(EMPTY); setSearch(''); setPicker(null);
    load('refresh', { codexWorkspaceId: projectId || data.workspace?.id, stream: true });
  };
  const toggle = id => {
    const session = data.sessions.find(item => item.id === id);
    if (disabled || !session?.snapshotVersion || !session.syncTurnCount) return;
    const ids = selection.ids.includes(id) ? selection.ids.filter(selected => selected !== id) : [...selection.ids, id];
    onSelectionChange({ ids, versions: Object.fromEntries(ids.map(selected => [selected, selected === id ? session.snapshotVersion : selection.versions[selected]])) });
  };
  const visible = data.sessions.filter(session => `${session.title} ${session.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  return h('section', { className: 'rh-sync-source-section rh-sync-sessions', 'aria-label': t("CodexSessionsSection.message011") },
    h('div', { className: 'rh-sync-section-heading' },
      h('h3', { className: 'rh-sync-section-title' }, t("CodexSessionsSection.message012")),
      h(Button, { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: loading || disabled, onClick: openPicker }, t("CodexSessionsSection.message002")),
      h(Button, { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: loading || disabled || !data.workspace, onClick: () => refresh() }, t("CodexSessionsSection.message013"))),
    h('p', { className: 'rh-sync-hint' }, t("CodexSessionsSection.message014")),
    data.workspace && h('p', { className: 'rh-sync-hint', title: data.workspace.path }, t("CodexSessionsSection.message015", { value0: data.workspace.title, value1: data.workspace.path })),
    error && h('p', { role: 'alert', className: 'rh-error' }, error),
    loading && progress && h('div', { className: 'rh-codex-progress', role: 'status', 'aria-live': 'polite' },
      h('span', null, progress.phase === 'queued' ? t("CodexSessionsSection.message016") : progress.phase === 'inventory' ? t("CodexSessionsSection.message017") : progress.phase === 'saving' ? t("CodexSessionsSection.message018", { value0: progress.completed, value1: progress.total }) : t("CodexSessionsSection.message019", { value0: progress.completed, value1: progress.total })),
      h('progress', { 'aria-label': t("CodexSessionsSection.message020"), max: progress.total || 1, value: progress.total === null ? undefined : progress.completed })),
    h(ImportWarnings, { warnings }),
    data.workspace && h(Input, { className: 'rh-search-input', type: 'search', value: search, 'aria-label': t("CodexSessionsSection.message021"), placeholder: t("CodexSessionsSection.message022"), onChange: event => setSearch(event.target.value) }),
    h(SessionList, { sessions: visible, selectedIds: selection.ids, onToggle: toggle, onView, loading, disabled, source: ' Codex ',
      emptyText: data.workspace ? (search.trim() ? t("CodexSessionsSection.message023") : t("CodexSessionsSection.message024")) : t("CodexSessionsSection.message025") }),
    data.workspace && !loading && !error && h('p', { className: 'rh-sync-hint', role: 'status' }, t("CodexSessionsSection.message026", { value0: data.sessions.filter(session => session.snapshotVersion).length, value1: data.refreshedAt ? ' · ' + new Date(data.refreshedAt).toLocaleString() : '' })),
    selection.ids.length > 0 && h('p', { className: 'rh-sync-hint' }, t("CodexSessionsSection.message027", { value0: selection.ids.length })),
    picker && h(WorkspacePicker, { ...picker, onSelect: project => refresh(project.id), onClose: () => setPicker(null) })
  );
}
module.exports = { CodexSessionsSection };
