'use strict';
const clientApi = require('../api/index.js');
const { clientError } = require('../utils/serverMessage.js');
const { formatDateTime, useTimeZone } = require('../time.js');
const { PagedList } = require('./shared/PagedList.js');
const { Disclosure } = require('./shared/Disclosure.js');
const { ActionBar } = require('./shared/ActionBar.js');
const { Skeleton } = require('./shared/Skeleton.js');
const React = require('react');
const { t } = require('../locale.js');
const { knowledgeV2Request, knowledgeV2ErrorText } = require('../hooks/useKnowledgeV2.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { Select } = require('./shared/Select.js');
const { Checkbox, Modal } = require('./shared/controls.js');
const { DshSessionsSection } = require('./DshSessionsSection.js');
const { CodexSessionsSection } = require('./CodexSessionsSection.js');
const css = require('./ConversationKnowledgeImport.module.css').default;
const h = React.createElement;
const { IconSearch, IconChevronDown } = require('../icons.js').createIconComponents(h);

const SOURCES = ['dsh', 'codex'];
const EMPTY_QUERIES = { dsh: '', codex: '' };
const EMPTY_ACTIVITY = { dsh: false, codex: false };

/**
 * Resolve readable messages for one turn. A Host with older server code (or a
 * legacy frozen snapshot) omits detail.messages; in that case fall back to the
 * same /session-turns snapshot the sync feature uses, matched by turn number.
 * @param item - One turn from knowledge-v2 session detail.
 * @param index - Turn position, used when turn numbers are unavailable.
 * @param fallback - {status, turns} from the sync-side snapshot, if any.
 * @returns [{key, role, kind, label, text}] with non-empty text only.
 */
function previewMessages(item, index, fallback) {
  const own = Array.isArray(item.messages) ? item.messages : [];
  const turns = Array.isArray(fallback?.turns) ? fallback.turns : [];
  const candidate = turns.find((turn) => turn.turnNumber === item.number) || turns[index];
  const source = own.length ? own : Array.isArray(candidate?.messages) ? candidate.messages : [];
  return source
    .map((message, position) => {
      const role = message?.role === 'user' ? 'user' : 'assistant';
      const text =
        typeof message?.text === 'string' ? message.text : String(message?.content ?? '');
      return {
        key: position,
        role,
        kind: message?.kind || (role === 'user' ? 'input' : 'final'),
        label:
          message?.label ||
          (role === 'user'
            ? t('conversationImport.roleUser')
            : t('conversationImport.roleAssistant')),
        text,
      };
    })
    .filter((message) => message.text.trim());
}

/**
 * Select exact conversation turns and import them as knowledge sources.
 * One source is visible at a time; both panels stay mounted so drafts and
 * selections survive tab switches, matching the sync session picker.
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
  const [queries, setQueries] = React.useState(EMPTY_QUERIES);
  const [source, setSource] = React.useState('dsh');
  const [panelTargets, setPanelTargets] = React.useState({});
  const [activity, setActivity] = React.useState(EMPTY_ACTIVITY);
  const [selection, setSelection] = React.useState({});
  const [detail, setDetail] = React.useState(null);
  const [detailMode, setDetailMode] = React.useState('select');
  const [previewFallback, setPreviewFallback] = React.useState(null);
  const [expandedTurns, setExpandedTurns] = React.useState(new Set());
  const [mode, setMode] = React.useState('merge');
  const [ingest, setIngest] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const alive = React.useRef(true);
  const generation = React.useRef(0);
  const initialSourcePicked = React.useRef(false);
  const optionsController = React.useRef(null);
  const requests = React.useRef(new Set());
  const turnsId = React.useId();
  const previewId = React.useId();
  const tabId = React.useId();
  const request = async (path, body, signal) => {
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      return await knowledgeV2Request(path, target, body, signal || controller.signal);
    } finally {
      requests.current.delete(controller);
    }
  };
  /**
   * A Host running older server code returns turns without their frozen text.
   * Read the sync-side snapshot on demand so the preview never opens empty.
   */
  React.useEffect(() => {
    if (!detail || detailMode !== 'preview') {
      setPreviewFallback(null);
      return undefined;
    }
    const incomplete = (detail.turns || []).some(
      (item) => !Array.isArray(item.messages) || !item.messages.length,
    );
    const sessionId = detail.entry?.id || detail.entry?.conversationId;
    if (!incomplete || !target || !sessionId) {
      setPreviewFallback(null);
      return undefined;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      workspaceId: target,
      sessionId,
      version: detail.version,
    });
    setPreviewFallback({ status: 'loading', turns: [] });
    (async () => {
      try {
        const response = await clientApi.request(clientApi.endpoint('session-turns', `${params}`), {
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok || data.success === false || !Array.isArray(data.turns)) {
          throw clientError(data.error, 'KB_SESSION_CONTENT_MISSING');
        }
        if (!controller.signal.aborted) {
          setPreviewFallback({ status: 'ready', turns: data.turns });
        }
      } catch {
        if (!controller.signal.aborted) {
          setPreviewFallback({ status: 'failed', turns: [] });
        }
      }
    })();
    return () => controller.abort();
  }, [detail, detailMode, target]);
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
  // Open on the source that actually has sessions so an empty tab is never the default.
  React.useEffect(() => {
    if (!options || initialSourcePicked.current) {
      return;
    }
    initialSourcePicked.current = true;
    const sessions = options.sessions || [];
    if (
      !sessions.some((entry) => entry.source === 'dsh') &&
      sessions.some((entry) => entry.source === 'codex')
    ) {
      setSource('codex');
    }
  }, [options]);
  const blocked = busy || activity.dsh || activity.codex;
  const setDshTarget = React.useCallback(
    (node) =>
      setPanelTargets((previous) =>
        previous.dsh === node ? previous : { ...previous, dsh: node },
      ),
    [],
  );
  const setCodexTarget = React.useCallback(
    (node) =>
      setPanelTargets((previous) =>
        previous.codex === node ? previous : { ...previous, codex: node },
      ),
    [],
  );
  const changeActivity = (id, value) =>
    setActivity((previous) => (previous[id] === value ? previous : { ...previous, [id]: value }));
  const refreshing = () => {
    generation.current++;
    setSelection({});
    setDetail(null);
    setExpandedTurns(new Set());
    setResult(null);
    setError(null);
    setQueries(EMPTY_QUERIES);
  };
  const load = async (entry, version, selectAll = false) => {
    if (!target || blocked) {
      return;
    }
    const id = ++generation.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setPreviewFallback(null);
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
  /** Reuse the frozen snapshot for both turn selection and read-only preview. */
  const openDetail = (entry, nextMode, version) => {
    setDetailMode(nextMode);
    setExpandedTurns(new Set());
    const wanted = version || entry.snapshotVersion;
    if (detail?.entry.conversationId === entry.conversationId && detail?.version === wanted) {
      return;
    }
    load(entry, wanted);
  };
  const chooseVersion = (version) => {
    const entry = detail.entry;
    setExpandedTurns(new Set());
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
        setExpandedTurns(new Set());
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
  const sessions = options?.sessions || [];
  const byId = new Map(sessions.map((entry) => [entry.conversationId, entry]));
  const count = Object.values(selection).reduce((sum, item) => sum + item.turnKeys.length, 0);
  const totalFor = (id) => sessions.filter((entry) => entry.source === id).length;
  const selectedFor = (id) =>
    Object.keys(selection).filter((key) => byId.get(key)?.source === id).length;
  const visibleFor = (id) => {
    const needle = queries[id].trim().toLowerCase();
    return sessions.filter(
      (entry) => entry.source === id && entry.title.toLowerCase().includes(needle),
    );
  };
  const turnsFor = (entry) => selection[entry.conversationId]?.turnKeys.length || 0;
  const scopeLabel = options?.workspace?.path
    ? t('conversationImport.scope', {
        workspace: options.workspace.title || options.workspace.id,
        path: options.workspace.path,
      })
    : null;
  const acquisition = (id) =>
    id === 'dsh'
      ? h(DshSessionsSection, {
          workspaceId: target,
          acquireOnly: true,
          embedded: true,
          active: source === 'dsh',
          compact: true,
          toolbarTarget: panelTargets.dsh,
          disabled: blocked,
          onChanged: reloadOptions,
          onRefreshStart: refreshing,
          onBusyChange: (value) => changeActivity('dsh', value),
        })
      : h(CodexSessionsSection, {
          workspaceId: target,
          acquireOnly: true,
          embedded: true,
          active: source === 'codex',
          compact: true,
          toolbarTarget: panelTargets.codex,
          disabled: blocked,
          onChanged: reloadOptions,
          onRefreshStart: refreshing,
          onBusyChange: (value) => changeActivity('codex', value),
        });
  const renderRows = (id, entries) =>
    entries.map((entry) => {
      const selectedTurns = turnsFor(entry);
      const selected = !!selection[entry.conversationId];
      const available = !!entry.snapshotVersion && (entry.turnCount ?? 0) > 0;
      const isCurrent = detail?.entry.conversationId === entry.conversationId;
      const expanded = detailMode === 'select' && isCurrent;
      const previewing = detailMode === 'preview' && isCurrent;
      const statusId = `${id}-${entry.conversationId}-state`;
      return h(
        'div',
        {
          key: entry.conversationId,
          className: `rh-session-row ${css.row}`,
          'data-unavailable': !available || blocked,
        },
        h(
          'label',
          {
            className: `rh-session-choice ${css.choice}`,
            'data-selected': selected,
            'data-blocked': blocked || !available,
          },
          h('input', {
            type: 'checkbox',
            checked: selected,
            disabled: !target || blocked,
            'aria-describedby': statusId,
            'aria-label': t('conversationImport.selectSession', { title: entry.title }),
            ref: (node) => {
              if (node) {
                node.indeterminate = selected && selectedTurns < (entry.turnCount ?? 0);
              }
            },
            onChange: (event) => {
              if (event.target.checked) {
                setDetailMode('select');
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
            'span',
            { className: 'rh-session-info' },
            h(
              'span',
              { className: css.titleRow },
              h('span', { className: 'rh-session-title', title: entry.title }, entry.title),
              h(
                'span',
                { id: statusId, className: css.status },
                entry.state === 'saved'
                  ? t('conversationImport.state.saved')
                  : t('conversationImport.state.missing'),
              ),
            ),
            h(
              'span',
              { className: 'rh-session-meta' },
              t('conversationImport.meta', {
                turns: entry.turnCount ?? 0,
                version: entry.snapshotVersion || t('conversationImport.noSnapshot'),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: css.rowActions },
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              disabled: !target || blocked || !entry.snapshotVersion,
              'aria-expanded': previewing,
              'aria-controls': previewing ? previewId : undefined,
              onClick: () =>
                previewing
                  ? setDetail(null)
                  : openDetail(entry, 'preview', selection[entry.conversationId]?.version),
            },
            t('SessionList.message005'),
          ),
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              disabled: !target || blocked,
              'aria-expanded': expanded,
              'aria-controls': expanded ? turnsId : undefined,
              onClick: () =>
                expanded
                  ? setDetail(null)
                  : openDetail(entry, 'select', selection[entry.conversationId]?.version),
            },
            t(expanded ? 'conversationImport.collapseTurns' : 'conversationImport.chooseTurns'),
          ),
        ),
      );
    });
  const renderPanel = (id, label) => {
    const visible = visibleFor(id);
    const compact = visible.length <= 5;
    return h(
      'div',
      {
        key: id,
        id: `${tabId}-${id}-panel`,
        role: 'tabpanel',
        'aria-labelledby': `${tabId}-${id}`,
        'aria-label': label,
        'data-source': id,
        hidden: source !== id,
        className: css.panel,
      },
      h(
        'div',
        { className: css.sourceCard },
        h(
          'div',
          { className: css.sourceHeader },
          h('span', { className: css.sectionLabel }, t('conversationImport.acquisition')),
          h('div', {
            className: css.actionSlot,
            ref: id === 'dsh' ? setDshTarget : setCodexTarget,
          }),
        ),
        target && options && acquisition(id),
      ),
      h(
        'div',
        { className: css.filterBar },
        h(Input, {
          className: css.search,
          size: 'sm',
          icon: h(IconSearch, { size: 14 }),
          type: 'search',
          value: queries[id],
          disabled: blocked,
          placeholder: t('conversationImport.search'),
          'aria-label': t('conversationImport.search'),
          onChange: (event) =>
            setQueries((previous) => ({ ...previous, [id]: event.target.value })),
        }),
        h(
          'span',
          { className: css.count, role: 'status' },
          t('conversationImport.count', {
            total: visible.length,
            selected: selectedFor(id),
          }),
        ),
      ),
      h(
        'div',
        { className: css.listFrame, 'data-compact': compact ? 'true' : 'false' },
        !options && !error && target && h(Skeleton, { lines: 4 }),
        options &&
          !visible.length &&
          h(
            'p',
            { className: css.empty, role: 'status' },
            t(queries[id].trim() ? 'conversationImport.noHits' : 'conversationImport.empty'),
          ),
        options &&
          visible.length > 0 &&
          h(
            PagedList,
            {
              resetKey: `${id}|${queries[id]}`,
              rowHeight: 56,
              inspect: false,
              plainRows: true,
              fitContent: compact,
              inset: true,
              busy: blocked,
            },
            renderRows(id, visible),
          ),
      ),
    );
  };
  const renderTurns = () =>
    h(
      'section',
      { id: turnsId, className: css.turns, 'aria-label': t('conversationImport.turns') },
      h('p', { className: css.hint }, t('conversationImport.turnsHint')),
      h(
        'div',
        { className: css.turnToolbar },
        h('span', { className: css.fieldLabel }, t('conversations.version')),
        h(Select, {
          size: 'sm',
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
          'span',
          { className: css.count, role: 'status' },
          t('conversationImport.turnsSelected', {
            count: selection[detail.entry.conversationId]?.turnKeys.length || 0,
          }),
        ),
      ),
      h(
        'div',
        { className: css.turnFrame },
        h(
          PagedList,
          { rowHeight: 48, inspect: false, plainRows: true, inset: true, busy: blocked },
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
      ),
      h(
        ActionBar,
        null,
        h(
          Button,
          { variant: 'primary', onClick: () => setDetail(null) },
          t('conversationImport.done'),
        ),
      ),
    );
  const toggleExpanded = (key) =>
    setExpandedTurns((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  const renderPreview = () => {
    const turns = detail.turns || [];
    const allExpanded = turns.length > 0 && expandedTurns.size >= turns.length;
    return h(
      'section',
      { id: previewId, className: css.preview, 'aria-label': t('SyncPanel.message007') },
      h('p', { className: css.hint }, t('conversationImport.previewHint')),
      h(
        'div',
        { className: css.turnToolbar },
        h(
          'span',
          { className: css.count, role: 'status' },
          t('conversationImport.meta', { turns: turns.length, version: detail.version }),
        ),
        h(
          Button,
          {
            variant: 'outline',
            size: 'sm',
            disabled: !turns.length,
            onClick: () =>
              setExpandedTurns(allExpanded ? new Set() : new Set(turns.map((item) => item.key))),
          },
          t(allExpanded ? 'SyncPanel.message010' : 'SyncPanel.message011'),
        ),
      ),
      previewFallback?.status === 'loading' &&
        h('p', { className: css.notice, role: 'status' }, t('conversationImport.previewLoading')),
      previewFallback?.status === 'ready' &&
        h('p', { className: css.notice, role: 'status' }, t('conversationImport.previewFallback')),
      previewFallback?.status === 'failed' &&
        h(
          'p',
          { className: css.notice, role: 'alert' },
          t('conversationImport.previewUnavailable'),
        ),
      h(
        'div',
        { className: css.previewFrame },
        !turns.length
          ? h('p', { className: css.empty, role: 'status' }, t('SyncPanel.message006'))
          : h(
              PagedList,
              {
                rowHeight: 52,
                inspect: false,
                plainRows: true,
                inset: true,
                resetKey: detail.version,
              },
              turns.map((item, index) => {
                const messages = previewMessages(item, index, previewFallback);
                const opened = expandedTurns.has(item.key);
                const summary = messages.find((message) => message.role === 'user')?.text || '';
                return h(
                  'div',
                  { key: item.key, className: css.turnCard },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: css.turnHeader,
                      'aria-expanded': opened,
                      onClick: () => toggleExpanded(item.key),
                    },
                    h(
                      'span',
                      { className: css.turnLabel },
                      t('conversationImport.turn', { number: item.number }),
                    ),
                    h(
                      'span',
                      { className: css.turnSummary, title: summary },
                      summary.slice(0, 100),
                    ),
                    !item.syncable &&
                      h('span', { className: css.turnFlag }, t('conversationImport.unfinished')),
                    h(
                      'span',
                      { className: css.chevron, 'aria-hidden': true },
                      h(IconChevronDown, { size: 12 }),
                    ),
                  ),
                  opened &&
                    h(
                      'div',
                      { className: css.turnBody },
                      messages.length
                        ? messages.map((message) =>
                            h(
                              'div',
                              { key: message.key, className: css.message },
                              h('div', { className: css.messageLabel }, message.label),
                              h(
                                'div',
                                { className: css.messageText, 'data-kind': message.kind },
                                message.text,
                              ),
                            ),
                          )
                        : h(
                            'p',
                            { className: css.turnEmpty, role: 'status' },
                            t('conversationImport.previewEmpty'),
                          ),
                    ),
                );
              }),
            ),
      ),
      h(
        ActionBar,
        null,
        h(
          Button,
          { variant: 'primary', onClick: () => setDetail(null) },
          t('conversationImport.done'),
        ),
      ),
    );
  };
  const body = h(
    'div',
    { className: css.body },
    h(
      'div',
      { className: css.tabBar },
      h(
        'div',
        {
          className: `rh-workbench-tabs ${css.tabs}`,
          role: 'tablist',
          'aria-label': t('conversationImport.sourceTabs'),
        },
        SOURCES.map((id, index) =>
          h(
            'button',
            {
              key: id,
              id: `${tabId}-${id}`,
              type: 'button',
              role: 'tab',
              className: 'rh-workbench-tab',
              'aria-selected': source === id,
              'aria-controls': `${tabId}-${id}-panel`,
              tabIndex: source === id ? 0 : -1,
              onClick: () => setSource(id),
              onKeyDown: (event) => {
                let next;
                if (event.key === 'ArrowRight') {
                  next = (index + 1) % SOURCES.length;
                } else if (event.key === 'ArrowLeft') {
                  next = (index + SOURCES.length - 1) % SOURCES.length;
                } else if (event.key === 'Home') {
                  next = 0;
                } else if (event.key === 'End') {
                  next = SOURCES.length - 1;
                }
                if (next !== undefined) {
                  event.preventDefault();
                  setSource(SOURCES[next]);
                  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
                }
              },
            },
            t(`conversationImport.tab.${id}`, {
              total: totalFor(id),
              count: selectedFor(id),
            }),
          ),
        ),
      ),
      h(
        'span',
        {
          className: css.tabHint,
          title: scopeLabel || t('conversationImport.description'),
        },
        scopeLabel || t('conversationImport.description'),
      ),
    ),
    renderPanel('dsh', t('conversationSources.dsh')),
    renderPanel('codex', t('conversationSources.codex')),
    !target &&
      h('p', { role: 'alert', className: css.error }, t('conversationImport.targetRequired')),
    error && h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(error)),
    result &&
      h(
        'p',
        { role: 'status', className: css.notice },
        t('conversationImport.resultV2', { saved: result.saved, skipped: result.skipped }) +
          (result.job ? ` ${t('conversationImport.jobQueued')}` : ''),
      ),
    h(
      ActionBar,
      {
        'aria-label': t('conversationImport.selectionSummary'),
        leading: h(
          'div',
          { className: css.footerFields },
          h(
            'div',
            { className: css.fieldRow },
            h('span', { className: css.fieldLabel }, t('conversationImport.mode')),
            h(Select, {
              size: 'sm',
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
            'span',
            { className: css.summary, role: 'status' },
            t('conversationImport.selected', {
              sessions: Object.keys(selection).length,
              turns: count,
            }),
          ),
          h('span', { className: css.hint }, t('conversationImport.frozen')),
          Object.keys(selection).length > 0 &&
            h(
              Disclosure,
              { title: t('conversationImport.selectionSummary') },
              Object.values(selection).map((item) =>
                h('div', { key: item.id }, `${byId.get(item.id)?.title} · ${item.turnKeys.length}`),
              ),
            ),
        ),
      },
      !embedded && h(Button, { variant: 'outline', onClick: onClose }, t('common.close')),
      h(
        Button,
        {
          variant: 'primary',
          disabled: blocked || !target || !count,
          onClick: imported,
        },
        busy ? t('common.loading') : t('conversationImport.import'),
      ),
    ),
    detail &&
      h(
        Modal,
        {
          open: true,
          title: t(detailMode === 'preview' ? 'SyncPanel.message007' : 'conversationImport.turns'),
          className: css.turnDialog,
          onClose: () => setDetail(null),
        },
        detailMode === 'preview' ? renderPreview() : renderTurns(),
      ),
  );
  return embedded
    ? h('section', { className: css.embedded, 'aria-label': t('conversationImport.title') }, body)
    : h(
        Modal,
        {
          open: true,
          title: t('conversationImport.title'),
          className: css.dialog,
          onClose,
        },
        body,
      );
}
module.exports = { ConversationKnowledgeImport };
