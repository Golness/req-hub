'use strict';
const React = require('react');
const { ROUTE } = require('../constants.js');
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { SessionList } = require('./shared/SessionList.js');
const { ConversationRefreshProgress } = require('./ConversationRefreshProgress.js');
const { readConversationResponse } = require('../utils/readConversationResponse.js');
const h = React.createElement;
const EMPTY = { ids: [], versions: {} };

function DshSessionsSection({ workspaceId, selection = EMPTY, onSelectionChange, onView, disabled, acquireOnly, onChanged, onRefreshStart, onBusyChange, onManage }) {
  const [sessions, setSessions] = React.useState([]), [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(false), [error, setError] = React.useState(''), [progress, setProgress] = React.useState(null);
  const [warnings, setWarnings] = React.useState([]);
  const owner = React.useRef(0), controller = React.useRef(null);
  const callbacks = React.useRef({}); callbacks.current = { onChanged, onRefreshStart, onBusyChange, onSelectionChange };
  const load = async refresh => {
    const generation = ++owner.current;
    controller.current?.abort(); const abort = controller.current = new AbortController();
    setLoading(true); setError(''); setWarnings([]); callbacks.current.onBusyChange?.(true);
    if (refresh) { setProgress({ phase: 'queued', completed: 0, total: null }); callbacks.current.onRefreshStart?.(); callbacks.current.onSelectionChange?.(EMPTY); }
    try {
      let data;
      if (refresh) {
        const response = await fetch(`${ROUTE}/conversations-refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ workspaceId, source: 'dsh', stream: true }) });
        data = await readConversationResponse(response, value => { if (owner.current === generation) setProgress(value); });
      } else data = await readConversationResponse(await fetch(`${ROUTE}/sessions?${new URLSearchParams({ workspaceId, limit: '200' })}`, { signal: abort.signal }));
      if (abort.signal.aborted || owner.current !== generation) return;
      setSessions(data.sessions || []);
      setWarnings(data.warnings || []);
      const ids = refresh ? [] : selection.ids.filter(id => data.sessions?.some(session => session.id === id && session.snapshotVersion === selection.versions[id] && session.syncTurnCount));
      if (ids.length !== selection.ids.length) callbacks.current.onSelectionChange?.({ ids, versions: Object.fromEntries(ids.map(id => [id, selection.versions[id]])) });
      callbacks.current.onChanged?.();
    } catch (error) {
      if (!abort.signal.aborted && owner.current === generation) { setError(error.message); setSessions([]); callbacks.current.onSelectionChange?.(EMPTY); }
    } finally {
      if (owner.current === generation) { setLoading(false); setProgress(null); callbacks.current.onBusyChange?.(false); }
    }
  };
  React.useEffect(() => { setSearch(''); setSessions([]); load(false); return () => { owner.current++; controller.current?.abort(); }; }, [workspaceId]);
  const toggle = id => {
    const session = sessions.find(row => row.id === id);
    if (disabled || loading || !session?.snapshotVersion || !session.syncTurnCount) return;
    const ids = selection.ids.includes(id) ? selection.ids.filter(value => value !== id) : [...selection.ids, id];
    onSelectionChange?.({ ids, versions: Object.fromEntries(ids.map(value => [value, value === id ? session.snapshotVersion : selection.versions[value]])) });
  };
  const visible = sessions.filter(row => `${row.title} ${row.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  return h('section', { className: 'rh-sync-source-section rh-sync-sessions', 'aria-label': t('SyncPanel.message086') },
    h('div', { className: 'rh-sync-section-heading' }, h('h3', { className: 'rh-sync-section-title' }, t('SyncPanel.message087')),
      h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: disabled || loading, onClick: () => load(true) }, t('SyncPanel.message088')),
      onManage && h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: disabled || loading, onClick: onManage }, t('conversations.manage'))),
    h('p', { className: 'rh-sync-hint' }, t(acquireOnly ? 'conversationSources.dshHint' : 'SyncPanel.message089')),
    error && h('p', { className: 'rh-error', role: 'alert' }, error),
    warnings.length > 0 && h('details', { className: 'rh-codex-warnings' }, h('summary', null, t('conversationSources.warnings', { count: warnings.length })), h('ul', null, warnings.map((warning, index) => h('li', { key: index }, warning)))),
    loading && h(ConversationRefreshProgress, { progress: progress || { phase: 'inventory', completed: 0, total: null } }),
    acquireOnly ? !loading && h('p', { className: 'rh-sync-hint', role: 'status' }, t('conversationSources.ready', { source: 'DSH', count: sessions.length })) : h(React.Fragment, null,
      h(Input, { className: 'rh-search-input', type: 'search', value: search, placeholder: t('SyncPanel.message090'), 'aria-label': t('SyncPanel.message090'), onChange: event => setSearch(event.target.value) }),
      h(SessionList, { sessions: visible, selectedIds: selection.ids, onToggle: toggle, onView, loading, disabled }),
      selection.ids.length > 0 && h('p', { className: 'rh-sync-hint' }, t('SyncPanel.message091', { value0: selection.ids.length }))));
}
module.exports = { DshSessionsSection };
