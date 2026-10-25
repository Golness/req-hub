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
})[code] || t('common.loadFailed');

function ConversationKnowledgeImport({ initialTarget = '', initialSourceWorkspace = initialTarget, onClose, onImported }) {
  const [options, setOptions] = React.useState(null), [target, setTarget] = React.useState(initialTarget);
  const [source, setSource] = React.useState(''), [query, setQuery] = React.useState('');
  const [selection, setSelection] = React.useState({}), [detail, setDetail] = React.useState(null);
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [result, setResult] = React.useState(null);
  const [sourceWorkspace, setSourceWorkspace] = React.useState(initialSourceWorkspace), [sourceBusy, setSourceBusy] = React.useState(false);
  const alive = React.useRef(true), generation = React.useRef(0);
  const optionsController = React.useRef(null);
  const request = async (action, body, params = {}, signal) => {
    const response = await fetch(`${ROUTE}/conversations-knowledge-${action}${body ? '' : '?' + new URLSearchParams(params)}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal } : { signal });
    const data = await response.json(); if (!response.ok || data.error) throw Error(errorText(data.error)); return data;
  };
  const reloadOptions = React.useCallback(async () => {
    optionsController.current?.abort(); const controller = optionsController.current = new AbortController();
    try { const data = await request('options', null, {}, controller.signal); if (alive.current && !controller.signal.aborted) setOptions(data); }
    catch (error) { if (alive.current && !controller.signal.aborted) setError(error.message); }
  }, []);
  React.useEffect(() => {
    alive.current = true; reloadOptions();
    return () => { alive.current = false; generation.current++; optionsController.current?.abort(); };
  }, []);
  const blocked = busy || sourceBusy;
  const refreshing = () => { generation.current++; setSelection({}); setDetail(null); setResult(null); setError(''); setSource(''); setQuery(''); };
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
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await request('import', { targetWorkspaceId: target, selections: Object.values(selection).filter(item => item.turnKeys.length) });
      onImported?.(response);
      if (alive.current) { setResult(response); setSelection({}); setDetail(null); }
    } catch (error) { if (alive.current) setError(error.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const sources = [...new Map((options?.sessions || []).map(entry => [entry.sourceScopeId, { id: entry.sourceScopeId, label: `${entry.source === 'dsh' ? 'DSH' : 'Codex'} · ${entry.sourceWorkspaceTitle} · ${entry.sourceWorkspacePaths.join(' · ')}` }])).values()];
  const visible = (options?.sessions || []).filter(entry => (!source || source === entry.sourceScopeId) && `${entry.title} ${entry.sourceWorkspaceTitle}`.toLowerCase().includes(query.trim().toLowerCase()));
  const count = Object.values(selection).reduce((sum, item) => sum + item.turnKeys.length, 0);
  return h(ModalFrame, { surfaceClassName: css.frame, onClick: onClose, 'aria-label': t('conversationImport.title') },
    h('div', { className: `rh-modal ${css.modal}`, onClick: event => event.stopPropagation() },
      h('h3', { className: 'rh-modal-title' }, t('conversationImport.title')),
      h('p', { className: css.hint }, t('conversationImport.description')),
      h('p', { className: css.hint }, t('conversationImport.mergeRules')),
      h('label', { className: css.field }, t('conversationImport.target'), h(Select, { value: target, disabled: blocked, searchable: true, 'aria-label': t('conversationImport.target'), options: [{ id: '', label: t('conversationImport.targetPlaceholder') }, ...(options?.targets || []).map(workspace => ({ id: workspace.id, label: `${workspace.title} · ${workspace.path}` }))], onChange: event => { generation.current++; setTarget(event.target.value); setSelection({}); setDetail(null); setResult(null); setError(''); } })),
      h('section', { className: css.acquisition, 'aria-label': t('conversationSources.title') },
        h('h4', null, t('conversationSources.title')),
        h('label', { className: css.field }, t('conversationSources.workspace'), h(Select, { value: sourceWorkspace, disabled: blocked, searchable: true, 'aria-label': t('conversationSources.workspace'),
          options: [{ id: '', label: t('conversationSources.workspacePlaceholder') }, ...(options?.targets || []).map(workspace => ({ id: workspace.id, label: `${workspace.title} · ${workspace.path}` }))],
          onChange: event => { setSourceWorkspace(event.target.value); setSourceBusy(false); } })),
        sourceWorkspace && options && h(ConversationSources, { key: sourceWorkspace, workspaceId: sourceWorkspace, acquireOnly: true, disabled: busy,
          onChanged: reloadOptions, onRefreshStart: refreshing, onBusyChange: setSourceBusy })),
      h('div', { className: css.toolbar },
        h(Select, { value: source, disabled: blocked, searchable: true, 'aria-label': t('conversationImport.source'), options: [{ id: '', label: t('conversationImport.allSources') }, ...sources], onChange: event => setSource(event.target.value) }),
        h(Input, { type: 'search', value: query, disabled: blocked, placeholder: t('conversations.search'), 'aria-label': t('conversations.search'), onChange: event => setQuery(event.target.value) })),
      error && h('p', { role: 'alert', className: 'rh-error' }, error),
      result && h('p', { role: 'status' }, t('conversationImport.result', { added: result.added, updated: result.updated, skipped: result.skipped })),
      h('div', { className: css.content },
        h('div', { className: css.sessions }, !options && h('p', { role: 'status' }, t('common.loading')), options && !visible.length && h('p', null, t('conversationImport.empty')),
          visible.map(entry => h('div', { key: entry.conversationId, className: css.session },
            h(Checkbox, { label: entry.title, checked: !!selection[entry.conversationId], disabled: !target || blocked,
              indeterminate: !!selection[entry.conversationId] && selection[entry.conversationId].turnKeys.length < entry.turnCount,
              'aria-label': t('conversationImport.selectSession', { title: entry.title }),
              onChange: checked => { if (checked) load(entry, null, true); else setSelection(previous => { const next = { ...previous }; delete next[entry.conversationId]; return next; }); } }),
            h('small', { className: css.hint }, `${entry.source === 'dsh' ? 'DSH' : 'Codex'} · ${entry.sourceWorkspaceTitle}`),
            h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: !target || blocked, onClick: () => load(entry, selection[entry.conversationId]?.version) }, t('conversationImport.chooseTurns'))))),
        detail ? h('section', { className: css.turns, 'aria-label': t('conversationImport.turns') },
          h('strong', null, detail.entry.title),
          h(Select, { value: detail.version, disabled: blocked, 'aria-label': t('conversations.version'), options: detail.versions.map(version => ({ id: version.version, label: `${new Date(version.created_at).toLocaleString()} · ${version.version.slice(0, 8)}` })), onChange: event => chooseVersion(event.target.value) }),
          detail.turns.map(item => h('div', { key: item.key, className: css.turn },
            h(Checkbox, { disabled: blocked || item.importable === false || !item.turn.messages.length, checked: selection[detail.entry.conversationId]?.version === detail.version && !!selection[detail.entry.conversationId]?.turnKeys.includes(item.key), onChange: () => toggleTurn(item.key),
              label: `${t('conversationImport.turn', { number: item.number })} · ${item.knowledgeState === 'conflict' ? t('conversationImport.conflict') : item.knowledgeState === 'same' ? t('conversationImport.same') : item.knowledgeState === 'changed' ? t('conversationImport.changed') : t('conversationImport.new')}${!item.turn.syncable ? ' · ' + t('conversationImport.unfinished') : ''}` }),
            h('details', null, h('summary', null, t('conversationImport.previewTurn')), h('div', { className: css.transcript }, item.turn.messages.map((message, index) => h('div', { key: index }, h('strong', null, message.label), h('p', null, message.text))))))))
          : h('p', { className: css.hint }, t('conversationImport.chooseHint'))),
      h('div', { className: css.summary }, t('conversationImport.selected', { sessions: Object.keys(selection).length, turns: count }),
        h('span', { className: css.hint }, t('conversationImport.frozen')),
        Object.keys(selection).length > 0 && h('details', null, h('summary', null, t('conversationImport.selectionSummary')), Object.values(selection).map(item => h('div', { key: item.id }, `${options.sessions.find(entry => entry.conversationId === item.id)?.title} · ${item.turnKeys.length}`)))),
      h('div', { className: 'rh-modal-actions' }, h(Button, { onClick: onClose }, t('common.close')), h(Button, { className: 'rh-btn rh-btn-primary', disabled: blocked || !target || !count, onClick: imported }, busy ? t('common.loading') : t('conversationImport.import')))));
}
module.exports = { ConversationKnowledgeImport };
