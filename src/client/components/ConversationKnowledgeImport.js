'use strict';
const { formatDateTime, useTimeZone } = require('../time.js');
const { PagedList } = require('./shared/PagedList.js');
const { Disclosure } = require('./shared/Disclosure.js');
const React = require('react');
const { t } = require('../locale.js');
const { knowledgeV2Request, knowledgeV2ErrorText } = require('../hooks/useKnowledgeV2.js');
const { ModalFrame } = require('./shared/ModalFrame.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { Select } = require('./shared/Select.js');
const { Checkbox, Modal } = require('./shared/controls.js');
const { ConversationSources } = require('./ConversationSources.js');
const css = require('./ConversationKnowledgeImport.module.css').default;
const h = React.createElement;

/**
 * Select exact conversation turns and import them as knowledge sources.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function ConversationKnowledgeImport({
  initialTarget = '',
  onClose,
  onImported,
  embedded = false,
}) {
  useTimeZone();
  const target = initialTarget;
  const [options, setOptions] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [selection, setSelection] = React.useState({});
  const [detail, setDetail] = React.useState(null);
  const [mode, setMode] = React.useState('merge');
  const [ingest, setIngest] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [sourceBusy, setSourceBusy] = React.useState(false);
  const alive = React.useRef(true);
  const generation = React.useRef(0);
  const optionsController = React.useRef(null);
  const requests = React.useRef(new Set());
  const turnsId = React.useId();
  const request = async (path, body, signal) => {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      return await knowledgeV2Request(path, target, body, signal || controller.signal);
    } finally {
      requests.current.delete(controller);
    }
  };
  const reloadOptions = React.useCallback(async () => {
    optionsController.current?.abort();
    const controller = (optionsController.current = new AbortController());
    try {
      const data = await request('/sources/sessions', null, controller.signal);
      if (alive.current && !controller.signal.aborted) {
        if (data.workspace?.id !== target) {
          const mismatch = new Error('KB_WORKSPACE_INVALID');
          mismatch.code = 'KB_WORKSPACE_INVALID';
          throw mismatch;
        }
        setOptions(data);
      }
    } catch (failure) {
      if (alive.current && !controller.signal.aborted) {
        setOptions(null);
        setError(failure);
      }
    }
  }, []);
  React.useEffect(() => {
    alive.current = true;
    if (target) {
      reloadOptions();
    }
    return () => {
      alive.current = false;
      generation.current++;
      optionsController.current?.abort();
      for (const controller of requests.current) {
        controller.abort();
      }
      requests.current.clear();
    };
  }, []);
  const blocked = busy || sourceBusy;
  const refreshing = () => {
    generation.current++;
    setSelection({});
    setDetail(null);
    setResult(null);
    setError(null);
    setQuery('');
  };
  const load = async (entry, version, selectAll = false) => {
    if (!target || blocked) {
      return;
    }
    const id = ++generation.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({
        id: entry.conversationId,
        version: version || entry.snapshotVersion,
      });
      const data = await request(`/sources/sessions/detail?${params}`, null);
      if (!alive.current || id !== generation.current) {
        return;
      }
      setDetail(data);
      if (selectAll) {
        setSelection((previous) => {
          const next = { ...previous };
          const keys = data.turns
            .filter((item) => item.importable !== false)
            .map((item) => item.key);
          if (keys.length) {
            next[entry.conversationId] = {
              id: entry.conversationId,
              version: data.version,
              turnKeys: keys,
            };
          } else {
            delete next[entry.conversationId];
          }
          return next;
        });
      }
    } catch (failure) {
      if (alive.current && id === generation.current) {
        setError(failure);
      }
    } finally {
      if (alive.current && id === generation.current) {
        setBusy(false);
      }
    }
  };
  const chooseVersion = (version) => {
    const entry = detail.entry;
    setSelection((previous) => {
      const next = { ...previous };
      delete next[entry.conversationId];
      return next;
    });
    load(entry, version);
  };
  const toggleTurn = (key) => {
    const id = detail.entry.conversationId;
    setResult(null);
    setSelection((previous) => {
      const prior = previous[id]?.version === detail.version ? previous[id].turnKeys : [];
      const turnKeys = prior.includes(key) ? prior.filter((item) => item !== key) : [...prior, key];
      const next = { ...previous };
      if (!turnKeys.length) {
        delete next[id];
      } else {
        next[id] = { id, version: detail.version, turnKeys };
      }
      return next;
    });
  };
  const imported = async () => {
    const id = ++generation.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await request('/sources/sessions', {
        selections: Object.values(selection).filter((item) => item.turnKeys.length),
        mode,
        ingest,
      });
      if (alive.current && id === generation.current) {
        onImported?.(response);
        setResult(response);
        setSelection({});
        setDetail(null);
      }
    } catch (failure) {
      if (alive.current && id === generation.current) {
        setError(failure);
      }
    } finally {
      if (alive.current && id === generation.current) {
        setBusy(false);
      }
    }
  };
  const sources = [
    { id: 'dsh', label: t('conversationSources.dsh') },
    { id: 'codex', label: t('conversationSources.codex') },
  ];
  const visible = (options?.sessions || []).filter((entry) =>
    entry.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const count = Object.values(selection).reduce((sum, item) => sum + item.turnKeys.length, 0);
  const renderTurns = (entry) =>
    detail?.entry.conversationId === entry.conversationId &&
    h(
      'section',
      { id: turnsId, className: css.turns, 'aria-label': t('conversationImport.turns') },
      h(Select, {
        value: detail.version,
        disabled: blocked,
        'aria-label': t('conversations.version'),
        options: detail.versions.map((version) => ({
          id: version.version,
          label: `${formatDateTime(version.created_at)} · ${version.version.slice(0, 8)}`,
        })),
        onChange: (event) => chooseVersion(event.target.value),
      }),
      h(
        PagedList,
        { className: css.turnPages, rowHeight: 48, inspect: false },
        detail.turns.map((item) => {
          let knowledgeStateLabel;
          if (item.knowledgeState === 'conflict') {
            knowledgeStateLabel = t('conversationImport.conflict');
          } else if (item.knowledgeState === 'same') {
            knowledgeStateLabel = t('conversationImport.same');
          } else if (item.knowledgeState === 'changed') {
            knowledgeStateLabel = t('conversationImport.changed');
          } else {
            knowledgeStateLabel = t('conversationImport.new');
          }
          return h(
            'div',
            { key: item.key, className: css.turn },
            h(Checkbox, {
              disabled: blocked || item.importable === false,
              checked:
                selection[detail.entry.conversationId]?.version === detail.version &&
                !!selection[detail.entry.conversationId]?.turnKeys.includes(item.key),
              onChange: () => toggleTurn(item.key),
              label: `${t('conversationImport.turn', { number: item.number })} · ${knowledgeStateLabel}${!item.syncable ? ' · ' + t('conversationImport.unfinished') : ''}`,
            }),
          );
        }),
      ),
    );
  const content = h(
    'div',
    {
      className: `${embedded ? css.inlineModal : 'rh-modal'} ${css.modal}`,
      onClick: (event) => event.stopPropagation(),
    },
    !embedded && h('h3', { className: 'rh-modal-title' }, t('conversationImport.title')),
    h('p', { className: css.hint }, t('conversationImport.description')),
    h('p', { className: css.hint }, t('conversationImport.modeHint')),
    !target &&
      h('p', { role: 'alert', className: 'rh-error' }, t('conversationImport.targetRequired')),
    h(
      'section',
      { className: css.acquisition, 'aria-label': t('conversationSources.title') },
      h('h4', null, t('conversationSources.title')),
      target &&
        options &&
        h(ConversationSources, {
          workspaceId: target,
          acquireOnly: true,
          disabled: busy,
          onChanged: reloadOptions,
          onRefreshStart: refreshing,
          onBusyChange: setSourceBusy,
        }),
    ),
    h(
      'div',
      { className: css.toolbar },
      h(Input, {
        type: 'search',
        value: query,
        disabled: blocked,
        placeholder: t('conversationImport.search'),
        'aria-label': t('conversationImport.search'),
        onChange: (event) => setQuery(event.target.value),
      }),
    ),
    error && h('p', { role: 'alert', className: 'rh-error' }, knowledgeV2ErrorText(error)),
    result &&
      h(
        'p',
        { role: 'status' },
        t('conversationImport.resultV2', { saved: result.saved, skipped: result.skipped }) +
          (result.job ? ` ${t('conversationImport.jobQueued')}` : ''),
      ),
    h(
      'div',
      { className: css.content },
      h(
        'div',
        { className: css.sessions },
        !options && !error && target && h('p', { role: 'status' }, t('common.loading')),
        options &&
          sources.map((source) => {
            const entries = visible.filter((entry) => entry.source === source.id);
            return h(
              'section',
              {
                key: source.id,
                className: css.sourceGroup,
                'data-source': source.id,
                'aria-label': source.label,
              },
              h('h4', { className: css.sourceTitle }, source.label),
              !entries.length &&
                h('p', { className: css.hint }, t('conversationImport.sourceEmpty')),
              h(
                PagedList,
                { resetKey: query, inspect: false },
                entries.map((entry) =>
                  h(
                    'div',
                    { key: entry.conversationId, className: css.session },
                    h(Checkbox, {
                      label: entry.title,
                      checked: !!selection[entry.conversationId],
                      disabled: !target || blocked,
                      indeterminate:
                        !!selection[entry.conversationId] &&
                        selection[entry.conversationId].turnKeys.length < entry.turnCount,
                      'aria-label': t('conversationImport.selectSession', { title: entry.title }),
                      onChange: (checked) => {
                        if (checked) {
                          load(entry, null, true);
                        } else {
                          setSelection((previous) => {
                            const next = { ...previous };
                            delete next[entry.conversationId];
                            return next;
                          });
                        }
                      },
                    }),
                    h(
                      Button,
                      {
                        className: 'rh-btn rh-btn-ghost rh-btn-sm',
                        disabled: !target || blocked,
                        'aria-expanded': detail?.entry.conversationId === entry.conversationId,
                        'aria-controls':
                          detail?.entry.conversationId === entry.conversationId
                            ? turnsId
                            : undefined,
                        onClick: () =>
                          detail?.entry.conversationId === entry.conversationId
                            ? setDetail(null)
                            : load(entry, selection[entry.conversationId]?.version),
                      },
                      t(
                        detail?.entry.conversationId === entry.conversationId
                          ? 'conversationImport.collapseTurns'
                          : 'conversationImport.chooseTurns',
                      ),
                    ),
                  ),
                ),
              ),
            );
          }),
      ),
    ),
    h(
      'div',
      { className: css.summary },
      t('conversationImport.selected', { sessions: Object.keys(selection).length, turns: count }),
      h('span', { className: css.hint }, t('conversationImport.frozen')),
      Object.keys(selection).length > 0 &&
        h(
          Disclosure,
          { title: t('conversationImport.selectionSummary') },
          Object.values(selection).map((item) =>
            h(
              'div',
              { key: item.id },
              `${options.sessions.find((entry) => entry.conversationId === item.id)?.title} · ${item.turnKeys.length}`,
            ),
          ),
        ),
    ),
    h(
      'div',
      { className: css.toolbar },
      h(Select, {
        value: mode,
        disabled: blocked,
        'aria-label': t('conversationImport.mode'),
        options: [
          { id: 'merge', label: t('conversationImport.mode.merge') },
          { id: 'replace', label: t('conversationImport.mode.replace') },
        ],
        onChange: (event) => setMode(event.target.value),
      }),
      h(Checkbox, {
        checked: ingest,
        disabled: blocked,
        onChange: (checked) => setIngest(checked),
        label: t('conversationImport.ingest'),
      }),
    ),
    h(
      'div',
      { className: 'rh-modal-actions' },
      !embedded && h(Button, { onClick: onClose }, t('common.close')),
      h(
        Button,
        {
          className: 'rh-btn rh-btn-primary',
          disabled: blocked || !target || !count,
          onClick: imported,
        },
        busy ? t('common.loading') : t('conversationImport.import'),
      ),
    ),
    detail &&
      h(
        Modal,
        { open: true, title: t('conversationImport.turns'), onClose: () => setDetail(null) },
        renderTurns(detail.entry),
      ),
  );
  return embedded
    ? h(
        'section',
        { className: css.embedded, 'aria-label': t('conversationImport.title') },
        content,
      )
    : h(
        ModalFrame,
        {
          surfaceClassName: css.frame,
          onClick: onClose,
          'aria-label': t('conversationImport.title'),
        },
        content,
      );
}
module.exports = { ConversationKnowledgeImport };
