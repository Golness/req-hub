'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { Select } = require('./shared/Select.js');
const { Checkbox } = require('./shared/controls.js');
const { ConversationSources } = require('./ConversationSources.js');
const css = require('./ConversationKnowledgeImport.module.css').default;
const h = React.createElement;
const errorText = code => ({
  KNOWLEDGE_TARGET_REQUIRED: t('conversationImport.targetRequired'),
  KNOWLEDGE_SELECTION_INVALID: t('conversationImport.selectionInvalid'),
  KNOWLEDGE_IMPORT_TOO_LARGE: t('conversationImport.tooLarge'),
  KNOWLEDGE_TURN_IDENTITY_CONFLICT: t('conversationImport.identityConflict'),
  SESSION_MISSING: t('conversationImport.missing'), SESSION_SNAPSHOT_MISSING: t('conversationImport.missing'),
  WORKSPACE_RESPONSE_MISMATCH: t('conversationImport.workspaceMismatch'),
})[code] || t('common.loadFailed');

function ConversationKnowledgeImport({ initialTarget = '', onClose, onImported, embedded = false }) {
  const target = initialTarget;
  const [options, setOptions] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [selection, setSelection] = React.useState({}), [detail, setDetail] = React.useState(null);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [result, setResult] = React.useState(null);
  const [sourceBusy, setSourceBusy] = React.useState(false);
  const alive = React.useRef(true), generation = React.useRef(0);
  const optionsController = React.useRef(null);
  const requests = React.useRef(new Set());
  const turnsId = React.useId();
  const request = async (action, body, params = {}, signal) => {
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const response = await fetch(`${ROUTE}/conversations-knowledge-${action}${body ? '' : '?' + new URLSearchParams({ ...params, workspaceId: target })}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, workspaceId: target }), signal: signal || controller.signal } : { signal: signal || controller.signal });
      const data = await response.json(); if (!response.ok || data.error) throw Error(errorText(data.error)); return data;
    } finally { requests.current.delete(controller); }
  };
  const reloadOptions = React.useCallback(async () => {
    optionsController.current?.abort(); const controller = optionsController.current = new AbortController();
    try {
      const data = await request('options', null, {}, controller.signal);
      if (alive.current && !controller.signal.aborted) {
        if (data.workspace?.id !== target) throw Error(errorText('WORKSPACE_RESPONSE_MISMATCH'));
        setOptions(data);
      }
    } catch (error) { if (alive.current && !controller.signal.aborted) { setOptions(null); setError(error.message); } }
  }, []);
  React.useEffect(() => {
    alive.current = true; if (target) reloadOptions();
    return () => { alive.current = false; generation.current++; optionsController.current?.abort(); for (const controller of requests.current) controller.abort(); requests.current.clear(); };
  }, []);
  const blocked = busy || sourceBusy;
  const refreshing = () => { generation.current++; setSelection({}); setDetail(null); setResult(null); setError(''); setQuery(''); };
  const load = async (entry, version, selectAll = false) => {
    if (!target || blocked) return;
    const id = ++generation.current; setBusy(true); setError(''); setResult(null);
    try {
      const data = await request('detail', null, { targetWorkspaceId: target, id: entry.conversationId, version: version || entry.snapshotVersion });
      if (!alive.current || id !== generation.current) return;
      setDetail(data);
      if (selectAll) setSelection(previous => {
        const next = { ...previous }, keys = data.turns.filter(item => item.importable !== false && item.turn.messages.length).map(item => item.key);
        if (keys.length) next[entry.conversationId] = { id: entry.conversationId, version: data.version, turnKeys: keys }; else delete next[entry.conversationId]; return next;
      });
    } catch (error) { if (alive.current && id === generation.current) setError(error.message); }
    finally { if (alive.current && id === generation.current) setBusy(false); }
  };
  const chooseVersion = version => {
    const entry = detail.entry;
    setSelection(previous => { const next = { ...previous }; delete next[entry.conversationId]; return next; });
    load(entry, version);
  };
  const toggleTurn = key => {
    const id = detail.entry.conversationId;
    setResult(null);
    setSelection(previous => {
      const prior = previous[id]?.version === detail.version ? previous[id].turnKeys : [];
      const turnKeys = prior.includes(key) ? prior.filter(item => item !== key) : [...prior, key];
      const next = { ...previous }; if (!turnKeys.length) delete next[id]; else next[id] = { id, version: detail.version, turnKeys }; return next;
    });
  };
  const imported = async () => {
    const id = ++generation.current;
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await request('import', { targetWorkspaceId: target, selections: Object.values(selection).filter(item => item.turnKeys.length) });
      if (alive.current && id === generation.current) { onImported?.(response); setResult(response); setSelection({}); setDetail(null); }
    } catch (error) { if (alive.current && id === generation.current) setError(error.message); }
    finally { if (alive.current && id === generation.current) setBusy(false); }
  };
  const sources = [{ id: 'dsh', label: t('conversationSources.dsh') }, { id: 'codex', label: t('conversationSources.codex') }];
  const visible = (options?.sessions || []).filter(entry => entry.title.toLowerCase().includes(query.trim().toLowerCase()));
  const count = Object.values(selection).reduce((sum, item) => sum + item.turnKeys.length, 0);
  const renderTurns = entry => detail?.entry.conversationId === entry.conversationId && h('section', { id: turnsId, className: css.turns, 'aria-label': t('conversationImport.turns') },
    h(Select, { value: detail.version, disabled: blocked, 'aria-label': t('conversations.version'), options: detail.versions.map(version => ({ id: version.version, label: `${new Date(version.created_at).toLocaleString()} · ${version.version.slice(0, 8)}` })), onChange: event => chooseVersion(event.target.value) }),
    detail.turns.map(item => h('div', { key: item.key, className: css.turn },
      h(Checkbox, { disabled: blocked || item.importable === false || !item.turn.messages.length, checked: selection[detail.entry.conversationId]?.version === detail.version && !!selection[detail.entry.conversationId]?.turnKeys.includes(item.key), onChange: () => toggleTurn(item.key),
        label: `${t('conversationImport.turn', { number: item.number })} · ${item.knowledgeState === 'conflict' ? t('conversationImport.conflict') : item.knowledgeState === 'same' ? t('conversationImport.same') : item.knowledgeState === 'changed' ? t('conversationImport.changed') : t('conversationImport.new')}${!item.turn.syncable ? ' · ' + t('conversationImport.unfinished') : ''}` }),
      h('details', null, h('summary', null, t('conversationImport.previewTurn')), h('div', { className: css.transcript }, item.turn.messages.map((message, index) => h('div', { key: index }, h('strong', null, message.label), h('p', null, message.text))))))));
  const content = h('div', { className: `${embedded ? css.inlineModal : 'rh-modal'} ${css.modal}`, onClick: event => event.stopPropagation() },
      !embedded && h('h3', { className: 'rh-modal-title' }, t('conversationImport.title')),
      h('p', { className: css.hint }, t('conversationImport.description')),
      h('p', { className: css.hint }, t('conversationImport.mergeRules')),
      !target && h('p', { role: 'alert', className: 'rh-error' }, t('conversationImport.targetRequired')),
      h('section', { className: css.acquisition, 'aria-label': t('conversationSources.title') },
        h('h4', null, t('conversationSources.title')),
        target && options && h(ConversationSources, { workspaceId: target, acquireOnly: true, disabled: busy,
          onChanged: reloadOptions, onRefreshStart: refreshing, onBusyChange: setSourceBusy })),
      h('div', { className: css.toolbar },
        h(Input, { type: 'search', value: query, disabled: blocked, placeholder: t('conversationImport.search'), 'aria-label': t('conversationImport.search'), onChange: event => setQuery(event.target.value) })),
      error && h('p', { role: 'alert', className: 'rh-error' }, error),
      result && h('p', { role: 'status' }, t('conversationImport.result', { added: result.added, updated: result.updated, skipped: result.skipped })),
      h('div', { className: css.content },
        h('div', { className: css.sessions }, !options && !error && target && h('p', { role: 'status' }, t('common.loading')),
          options && sources.map(source => {
            const entries = visible.filter(entry => entry.source === source.id);
            return h('section', { key: source.id, className: css.sourceGroup, 'data-source': source.id, 'aria-label': source.label },
              h('h4', { className: css.sourceTitle }, source.label),
              !entries.length && h('p', { className: css.hint }, t('conversationImport.sourceEmpty')),
              entries.map(entry => h('div', { key: entry.conversationId, className: css.session },
            h(Checkbox, { label: entry.title, checked: !!selection[entry.conversationId], disabled: !target || blocked,
              indeterminate: !!selection[entry.conversationId] && selection[entry.conversationId].turnKeys.length < entry.turnCount,
              'aria-label': t('conversationImport.selectSession', { title: entry.title }),
              onChange: checked => { if (checked) load(entry, null, true); else setSelection(previous => { const next = { ...previous }; delete next[entry.conversationId]; return next; }); } }),
            h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !target || blocked,
              'aria-expanded': detail?.entry.conversationId === entry.conversationId,
              'aria-controls': detail?.entry.conversationId === entry.conversationId ? turnsId : undefined,
              onClick: () => detail?.entry.conversationId === entry.conversationId ? setDetail(null) : load(entry, selection[entry.conversationId]?.version) }, t(detail?.entry.conversationId === entry.conversationId ? 'conversationImport.collapseTurns' : 'conversationImport.chooseTurns')),
            renderTurns(entry))));
          }))),
      h('div', { className: css.summary }, t('conversationImport.selected', { sessions: Object.keys(selection).length, turns: count }),
        h('span', { className: css.hint }, t('conversationImport.frozen')),
        Object.keys(selection).length > 0 && h('details', null, h('summary', null, t('conversationImport.selectionSummary')), Object.values(selection).map(item => h('div', { key: item.id }, `${options.sessions.find(entry => entry.conversationId === item.id)?.title} · ${item.turnKeys.length}`)))),
      h('div', { className: 'rh-modal-actions' }, !embedded && h(Button, { onClick: onClose }, t('common.close')), h(Button, { className: 'rh-btn rh-btn-primary', disabled: blocked || !target || !count, onClick: imported }, busy ? t('common.loading') : t('conversationImport.import'))));
  return embedded ? h('section', { className: css.embedded, 'aria-label': t('conversationImport.title') }, content)
    : h(ModalFrame, { surfaceClassName: css.frame, onClick: onClose, 'aria-label': t('conversationImport.title') }, content);
}
module.exports = { ConversationKnowledgeImport };
