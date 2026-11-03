'use strict';
const { Disclosure } = require('./shared/Disclosure.js');
const { t } = require('../locale.js');
const { Input } = require('./shared/Input.js');
const { Button } = require('./shared/Button.js');
const React = require('react');
const { createPortal } = require('react-dom');
const layoutCss = require('./ConversationSources.module.css').default;
const h = React.createElement;
const { ROUTE } = require('../constants.js');
const { SessionList } = require('./shared/SessionList.js');
const { readConversationResponse } = require('../utils/readConversationResponse.js');
const { ConversationRefreshProgress } = require('./ConversationRefreshProgress.js');

const EMPTY = { ids: [], versions: {} };
function ImportWarnings({ warnings = [] }) {
  return warnings.length
    ? h(
        Disclosure,
        {
          className: 'rh-codex-warnings',
          title: t('CodexSessionsSection.message001', { value0: warnings.length }),
        },
        h(
          'ul',
          null,
          warnings.map((warning, index) => h('li', { key: index }, warning)),
        ),
      )
    : null;
}
/**
 * Browse read-only Codex sessions matched to the current workspace path.
 * @param props - Owned selections and callbacks, including the unfiltered session count.
 * @returns The rendered component content.
 */
function CodexSessionsSection({
  workspaceId,
  selection = EMPTY,
  onSelectionChange = () => {},
  onView,
  disabled,
  acquireOnly,
  onChanged,
  onRefreshStart,
  onBusyChange,
  onCountChange,
  embedded = false,
  active = true,
  toolbarTarget,
}) {
  const [data, setData] = React.useState({ workspace: null, sessions: [] });
  React.useEffect(() => {
    onCountChange?.(data.sessions.length);
  }, [data.sessions.length, onCountChange]);
  const [loading, setLoading] = React.useState(true);
  const [progress, setProgress] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [warnings, setWarnings] = React.useState([]);
  const [search, setSearch] = React.useState('');
  const requestId = React.useRef(0);
  const mounted = React.useRef(true);
  const controller = React.useRef(null);
  const callbacks = React.useRef({});
  callbacks.current = { onChanged, onRefreshStart, onBusyChange };
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current++;
      controller.current?.abort();
    };
  }, []);
  const request = async (action, body, onProgress, signal) => {
    const response = await fetch(
      `${ROUTE}/codex/${action}${body ? '' : '?' + new URLSearchParams({ workspaceId, matchWorkspace: 'true' })}`,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workspaceId,
              ...body,
              matchWorkspace: true,
            }),
            signal,
          }
        : { signal },
    );
    return readConversationResponse(response, onProgress);
  };
  const load = async (action, body) => {
    const id = ++requestId.current;
    controller.current?.abort();
    const abort = (controller.current = new AbortController());
    callbacks.current.onBusyChange?.(true);
    if (action === 'refresh') {
      callbacks.current.onRefreshStart?.();
    }
    setLoading(true);
    setError(null);
    setProgress(action === 'refresh' ? { phase: 'queued', completed: 0, total: null } : null);
    try {
      const result = await request(
        action,
        body,
        (value) => {
          if (mounted.current && id === requestId.current) {
            setProgress(value);
          }
        },
        abort.signal,
      );
      if (!mounted.current || abort.signal.aborted || id !== requestId.current) {
        return;
      }
      const sessions = result.workspace ? result.sessions || [] : [];
      setData({ ...result, sessions });
      setWarnings(result.warnings || []);
      callbacks.current.onChanged?.();
      const ids =
        action === 'refresh'
          ? []
          : selection.ids.filter((selected) =>
              sessions.some(
                (session) =>
                  session.id === selected &&
                  session.snapshotVersion === selection.versions[selected] &&
                  session.syncTurnCount,
              ),
            );
      if (ids.length !== selection.ids.length) {
        onSelectionChange({
          ids,
          versions: Object.fromEntries(
            ids.map((selected) => [selected, selection.versions[selected]]),
          ),
        });
      }
    } catch (error) {
      if (!abort.signal.aborted && mounted.current && id === requestId.current) {
        setError(
          error.message === 'CODEX_WORKSPACE_AMBIGUOUS'
            ? t('conversationSources.codexAmbiguous')
            : error.message,
        );
        setData((previous) =>
          action === 'refresh' ? { ...previous, sessions: [] } : { workspace: null, sessions: [] },
        );
        onSelectionChange(EMPTY);
      }
    } finally {
      if (mounted.current && id === requestId.current) {
        setLoading(false);
        setProgress(null);
        callbacks.current.onBusyChange?.(false);
      }
    }
  };
  React.useEffect(() => {
    setData({ workspace: null, sessions: [] });
    setSearch('');
    load('sessions');
    return () => {
      requestId.current++;
      controller.current?.abort();
    };
  }, [workspaceId]);
  const refresh = () => {
    onSelectionChange(EMPTY);
    setSearch('');
    load('refresh', { stream: true });
  };
  const toggle = (id) => {
    const session = data.sessions.find((item) => item.id === id);
    if (disabled || !session?.snapshotVersion || !session.syncTurnCount) {
      return;
    }
    const ids = selection.ids.includes(id)
      ? selection.ids.filter((selected) => selected !== id)
      : [...selection.ids, id];
    onSelectionChange({
      ids,
      versions: Object.fromEntries(
        ids.map((selected) => [
          selected,
          selected === id ? session.snapshotVersion : selection.versions[selected],
        ]),
      ),
    });
  };
  const visible = data.sessions.filter((session) =>
    `${session.title} ${session.id}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  let searchPlaceholder;
  if (data.workspace) {
    if (search.trim()) {
      searchPlaceholder = t('CodexSessionsSection.message023');
    } else {
      searchPlaceholder = t('CodexSessionsSection.message024');
    }
  } else {
    searchPlaceholder = t('conversationSources.codexMissing');
  }
  const actions = h(
    'div',
    {
      className: layoutCss.sourceActions,
      hidden: embedded && !active,
    },
    h(
      Button,
      {
        size: 'sm',
        variant: 'ghost',
        disabled: loading || disabled,
        onClick: () => refresh(),
      },
      t('CodexSessionsSection.message013'),
    ),
  );
  return h(
    'section',
    {
      className:
        'rh-sync-source-section rh-sync-sessions' + (embedded ? ' ' + layoutCss.embedded : ''),
      'aria-label': t('CodexSessionsSection.message011'),
    },
    embedded && toolbarTarget
      ? createPortal(actions, toolbarTarget)
      : h(
          'div',
          { className: 'rh-sync-section-heading' },
          !embedded &&
            h(
              'h3',
              { className: 'rh-sync-section-title' },
              t(acquireOnly ? 'conversationSources.codex' : 'CodexSessionsSection.message012'),
            ),
          actions,
        ),
    h(
      'p',
      { className: 'rh-sync-hint' },
      t(acquireOnly ? 'conversationSources.codexHint' : 'CodexSessionsSection.message014'),
    ),
    data.workspace &&
      h(
        'p',
        {
          className: 'rh-sync-hint',
          title: `${data.workspace.path}\n${t('CodexSessionsSection.workspaceFixed')}`,
        },
        t('CodexSessionsSection.message015', {
          value0: data.workspace.title,
          value1: data.workspace.path,
        }),
      ),
    error && h('p', { role: 'alert', className: 'rh-error' }, error),
    !loading &&
      !error &&
      !data.workspace &&
      h('p', { className: 'rh-sync-hint', role: 'status' }, t('conversationSources.codexMissing')),
    loading && h(ConversationRefreshProgress, { progress, source: 'Codex' }),
    h(ImportWarnings, { warnings }),
    !acquireOnly &&
      data.workspace &&
      h(Input, {
        className: 'rh-search-input',
        type: 'search',
        value: search,
        'aria-label': t('CodexSessionsSection.message021'),
        placeholder: t('CodexSessionsSection.message022'),
        onChange: (event) => setSearch(event.target.value),
      }),
    !acquireOnly &&
      data.workspace &&
      h(SessionList, {
        sessions: visible,
        selectedIds: selection.ids,
        onToggle: toggle,
        onView,
        loading,
        disabled,
        source: ' Codex ',
        emptyText: searchPlaceholder,
      }),
    data.workspace &&
      !loading &&
      !error &&
      h(
        'p',
        { className: 'rh-sync-hint', role: 'status' },
        t('CodexSessionsSection.message026', {
          value0: data.sessions.filter((session) => session.snapshotVersion).length,
          value1: data.refreshedAt ? ' · ' + new Date(data.refreshedAt).toLocaleString() : '',
        }),
      ),
    !acquireOnly &&
      selection.ids.length > 0 &&
      h(
        'p',
        { className: 'rh-sync-hint' },
        t('CodexSessionsSection.message027', { value0: selection.ids.length }),
      ),
  );
}
module.exports = { CodexSessionsSection };
