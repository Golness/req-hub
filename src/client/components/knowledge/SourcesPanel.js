'use strict';
const React = require('react');
const { t, hasLocaleKey } = require('../../locale.js');
const { formatDateTime, useTimeZone } = require('../../time.js');
const { Button } = require('../shared/Button.js');
const { Input } = require('../shared/Input.js');
const { Select } = require('../shared/Select.js');
const { Checkbox, Modal } = require('../shared/controls.js');
const { PagedList } = require('../shared/PagedList.js');
const { EmptyState } = require('../shared/EmptyState.js');
const { Skeleton } = require('../shared/Skeleton.js');
const { showToast } = require('../shared/ToastContainer.js');
const { showConfirm } = require('../shared/ConfirmDialog.js');
const { ConversationKnowledgeImport } = require('../ConversationKnowledgeImport.js');
const { ImportFilesModal } = require('./ImportFilesModal.js');
const { knowledgeV2Request, knowledgeV2ErrorText } = require('../../hooks/useKnowledgeV2.js');
const css = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;
const { IconSearch, IconPlus } = require('../../icons.js').createIconComponents(h);

const PAGE_SIZE = 50;

/** Resolve an enum-derived key without letting an unknown kind break the list. */
const localized = (key, fallback) => (hasLocaleKey(key) ? t(key) : fallback);

/**
 * Unified source list: import files or sessions, inspect snapshots, update and delete.
 * @param props - Workspace identity, refresh signals and navigation callbacks.
 * @returns The rendered component content.
 */
function SourcesPanel({
  workspaceId,
  refreshKey,
  generationId,
  sourceRequest,
  onChanged,
  onOpenFile,
  onOpenTasks,
  docsDir,
}) {
  useTimeZone();
  const [query, setQuery] = React.useState('');
  const [kind, setKind] = React.useState('all');
  const [items, setItems] = React.useState(null);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState(() => new Set());
  const [detail, setDetail] = React.useState(null);
  const [detailError, setDetailError] = React.useState(null);
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [sessionsOpen, setSessionsOpen] = React.useState(false);
  const generation = React.useRef(0);
  const listKey = `${query}|${kind}`;
  React.useEffect(() => {
    const token = ++generation.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError(null);
      setItems(null);
      setSelected(new Set());
      const params = new URLSearchParams({ offset: '0', limit: String(PAGE_SIZE) });
      if (query.trim()) {
        params.set('query', query.trim());
      }
      if (kind !== 'all') {
        params.set('kind', kind);
      }
      knowledgeV2Request(`/sources?${params}`, workspaceId, null, controller.signal)
        .then((data) => {
          if (!controller.signal.aborted && generation.current === token) {
            setItems(data.items);
            setTotal(data.total);
          }
        })
        .catch((failure) => {
          if (!controller.signal.aborted && generation.current === token) {
            setError(failure);
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, listKey, refreshKey, generationId]);
  const loadMore = async () => {
    const params = new URLSearchParams({ offset: String(items.length), limit: String(PAGE_SIZE) });
    if (query.trim()) {
      params.set('query', query.trim());
    }
    if (kind !== 'all') {
      params.set('kind', kind);
    }
    const data = await knowledgeV2Request(`/sources?${params}`, workspaceId);
    setItems((previous) => [...previous, ...data.items]);
    setTotal(data.total);
  };
  const openDetail = React.useCallback(
    async (sourceId) => {
      setDetail(null);
      setDetailError(null);
      try {
        const data = await knowledgeV2Request(
          `/sources/${encodeURIComponent(sourceId)}`,
          workspaceId,
        );
        setDetail(data);
      } catch (failure) {
        setDetailError(failure);
      }
    },
    [workspaceId],
  );
  React.useEffect(() => {
    if (sourceRequest?.sourceId) {
      openDetail(sourceRequest.sourceId);
    }
  }, [sourceRequest, openDetail]);
  const toggle = (id) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  const ingestSelected = async () => {
    setBusy(true);
    try {
      await knowledgeV2Request('/jobs', workspaceId, {
        kind: 'ingest',
        sourceIds: [...selected],
        requestKey: crypto.randomUUID(),
      });
      showToast({ tone: 'success', text: t('kb.file.jobQueued') });
      setSelected(new Set());
      onChanged?.();
    } catch (failure) {
      showToast({ tone: 'error', text: knowledgeV2ErrorText(failure) });
    } finally {
      setBusy(false);
    }
  };
  const updateSource = async (source) => {
    if (source.kind === 'session') {
      setSessionsOpen(true);
      return;
    }
    setBusy(true);
    try {
      const result = await knowledgeV2Request('/sources/files', workspaceId, {
        files: [{ relativePath: source.origin.relativePath }],
        requestKey: crypto.randomUUID(),
        ingest: true,
      });
      const saved = result.results.find((item) => item.status === 'saved');
      showToast({
        tone: 'success',
        text: saved ? t('kb.file.savedToast') : t('kb.file.unchanged'),
      });
      onChanged?.();
    } catch (failure) {
      showToast({ tone: 'error', text: knowledgeV2ErrorText(failure) });
    } finally {
      setBusy(false);
    }
  };
  const deleteSource = async (source) => {
    const confirmed = await showConfirm({
      title: t('kb.sources.deleteTitle'),
      message: t('kb.sources.deleteMessage', { title: source.title }),
      confirmText: t('kb.sources.deleteConfirm'),
      variant: 'danger',
    });
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      await knowledgeV2Request(`/sources/${encodeURIComponent(source.id)}/delete`, workspaceId, {});
      showToast({ tone: 'success', text: t('kb.sources.deleted') });
      setDetail(null);
      onChanged?.();
    } catch (failure) {
      showToast({ tone: 'error', text: knowledgeV2ErrorText(failure) });
    } finally {
      setBusy(false);
    }
  };
  const toolbar = h(
    'div',
    { className: css.toolbar },
    h(Input, {
      icon: h(IconSearch, { size: 14 }),
      type: 'search',
      value: query,
      placeholder: t('kb.sources.search'),
      'aria-label': t('kb.sources.search'),
      onChange: (event) => setQuery(event.target.value),
    }),
    h(Select, {
      value: kind,
      'aria-label': t('kb.sources.kind'),
      options: ['all', 'file', 'session'].map((id) => ({
        id,
        label: localized(`kb.sources.kind.${id}`, id),
      })),
      onChange: (event) => setKind(event.target.value),
    }),
    h('span', { className: css.toolbarSpacer }),
    h(
      Button,
      {
        variant: 'primary',
        size: 'sm',
        icon: h(IconPlus, { size: 14 }),
        onClick: () => setFilesOpen(true),
      },
      t('kb.wiki.importFiles'),
    ),
    h(
      Button,
      { variant: 'outline', size: 'sm', onClick: () => setSessionsOpen(true) },
      t('kb.wiki.importSessions'),
    ),
  );
  if (error) {
    return h(
      React.Fragment,
      null,
      toolbar,
      h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(error)),
    );
  }
  if (!items) {
    return h(React.Fragment, null, toolbar, h(Skeleton, { lines: 4 }));
  }
  const filtering = query.trim() || kind !== 'all';
  return h(
    React.Fragment,
    null,
    toolbar,
    h(
      'div',
      { className: css.toolbar },
      h('span', { className: css.muted, role: 'status' }, t('kb.sources.count', { count: total })),
      selected.size > 0 &&
        h(
          React.Fragment,
          null,
          h('span', { className: css.muted }, t('kb.sources.selected', { count: selected.size })),
          h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              disabled: busy,
              onClick: ingestSelected,
            },
            t('kb.sources.ingestSelected'),
          ),
        ),
    ),
    !items.length &&
      (filtering
        ? h('p', { className: css.muted }, t('kb.sources.noHits'))
        : h(EmptyState, {
            title: t('kb.sources.empty'),
            description: t('kb.sources.emptyHint'),
            actions: [
              {
                label: t('kb.wiki.importFiles'),
                variant: 'primary',
                onClick: () => setFilesOpen(true),
              },
              { label: t('kb.wiki.importSessions'), onClick: () => setSessionsOpen(true) },
            ],
          })),
    items.length > 0 &&
      h(
        PagedList,
        {
          className: css.scroll,
          rowHeight: 56,
          inspect: false,
          plainRows: true,
          resetKey: `${listKey}|${refreshKey}|${generationId}`,
          hasMore: items.length < total,
          onMore: loadMore,
          busy,
        },
        items.map((source) =>
          h(
            'div',
            { key: source.id, className: css.sourceRow },
            h(Checkbox, {
              checked: selected.has(source.id),
              disabled: busy,
              'aria-label': source.title,
              onChange: () => toggle(source.id),
            }),
            h('span', { className: css.rowTitle, title: source.title }, source.title),
            h(
              'span',
              { className: css.rowMeta },
              source.kind === 'file'
                ? t('kb.sources.originFile', { path: source.origin.relativePath })
                : t('kb.sources.originSession', {
                    provider: source.origin.provider,
                    sessionId: source.origin.sessionId,
                  }),
            ),
            h(
              'div',
              { className: css.rowActions },
              h(
                'span',
                {
                  className: css.badge,
                  'data-tone': source.compiled ? 'success' : undefined,
                },
                source.compiled ? t('kb.sources.status.compiled') : t('kb.sources.status.pending'),
              ),
              h(
                Button,
                { variant: 'ghost', size: 'sm', onClick: () => openDetail(source.id) },
                t('kb.sources.view'),
              ),
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'sm',
                  disabled: busy,
                  title:
                    source.kind === 'file'
                      ? t('kb.sources.updateHint')
                      : t('kb.sources.sessionUpdateHint'),
                  onClick: () => updateSource(source),
                },
                t('kb.sources.update'),
              ),
              h(
                Button,
                {
                  variant: 'outline',
                  tone: 'danger',
                  size: 'sm',
                  disabled: busy,
                  onClick: () => deleteSource(source),
                },
                t('kb.sources.delete'),
              ),
            ),
          ),
        ),
      ),
    h(ImportFilesModal, {
      open: filesOpen,
      workspaceId,
      docsDir,
      onClose: () => setFilesOpen(false),
      onImported: () => onChanged?.(),
      onOpenTasks,
    }),
    sessionsOpen &&
      h(ConversationKnowledgeImport, {
        initialTarget: workspaceId,
        onClose: () => setSessionsOpen(false),
        onImported: () => onChanged?.(),
      }),
    (detail || detailError) &&
      h(
        Modal,
        {
          open: true,
          title: detail?.source.title || t('kb.sources.detail'),
          onClose: () => {
            setDetail(null);
            setDetailError(null);
          },
        },
        detailError &&
          h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(detailError)),
        detail &&
          h(
            React.Fragment,
            null,
            h(
              'dl',
              { className: css.detailMeta },
              h(
                'div',
                null,
                h('dt', null, t('kb.sources.kind')),
                h(
                  'dd',
                  null,
                  localized(`kb.sources.kind.${detail.source.kind}`, detail.source.kind),
                ),
              ),
              h(
                'div',
                null,
                h('dt', null, t('kb.sources.revisionLabel')),
                h('dd', null, detail.source.revision),
              ),
              h(
                'div',
                null,
                h('dt', null, t('kb.sources.importedAtLabel')),
                h('dd', null, formatDateTime(detail.provenance.importedAt)),
              ),
              h(
                'div',
                null,
                h('dt', null, t('kb.sources.bytesLabel')),
                h('dd', null, t('kb.sources.bytes', { bytes: detail.source.bytes })),
              ),
              h(
                'div',
                null,
                h('dt', null, t('kb.sources.provenance')),
                h(
                  'dd',
                  null,
                  detail.source.kind === 'file'
                    ? t('kb.sources.originFile', { path: detail.source.origin.relativePath })
                    : t('kb.sources.originSession', {
                        provider: detail.source.origin.provider,
                        sessionId: detail.source.origin.sessionId,
                      }),
                ),
              ),
            ),
            detail.source.kind === 'file' &&
              h(
                Button,
                {
                  variant: 'outline',
                  size: 'sm',
                  onClick: () => onOpenFile?.(detail.source.origin.relativePath),
                },
                t('kb.sources.openOriginal'),
              ),
            h('p', { className: css.muted }, t('kb.sources.snapshotReadonly')),
            h('pre', { className: css.snapshot }, detail.content),
          ),
      ),
  );
}
module.exports = { SourcesPanel };
