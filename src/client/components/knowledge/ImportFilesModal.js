'use strict';
const { localizeMessage } = require('../../utils/serverMessage.js');
const React = require('react');
const { t, hasLocaleKey } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { ActionBar } = require('../shared/ActionBar.js');
const { Input } = require('../shared/Input.js');
const { Select } = require('../shared/Select.js');
const { Checkbox, Modal } = require('../shared/controls.js');
const { PagedList } = require('../shared/PagedList.js');
const { EmptyState } = require('../shared/EmptyState.js');
const { Skeleton } = require('../shared/Skeleton.js');
const { knowledgeV2Request, knowledgeV2ErrorText } = require('../../hooks/useKnowledgeV2.js');
const css = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;
const { IconSearch } = require('../../icons.js').createIconComponents(h);

/** Resolve an enum-derived key without letting an unknown state break the list. */
const localized = (key, fallback) => (hasLocaleKey(key) ? t(key) : fallback);

const IMPORTABLE = new Set(['new', 'changed']);

/** Map a candidate state to a badge tone. */
const badgeTone = (state) => {
  if (state === 'imported') {
    return 'success';
  }
  if (state === 'changed') {
    return 'warning';
  }
  if (state === 'oversize' || state === 'unreadable') {
    return 'error';
  }
  return undefined;
};

/** Map an import outcome to a badge tone. */
const resultTone = (status) => {
  if (status === 'saved') {
    return 'success';
  }
  if (status === 'failed') {
    return 'error';
  }
  return undefined;
};

/**
 * Pick whitelisted files from the workspace docs root, showing snapshot state.
 * Path search applies on form submission; status filtering applies immediately.
 * @param props - Open state, workspace identity and result callbacks.
 * @returns The rendered modal, or nothing while closed.
 */
function ImportFilesModal({ open, workspaceId, docsDir, onClose, onImported, onOpenTasks }) {
  const [candidates, setCandidates] = React.useState(null);
  const [base, setBase] = React.useState(null);
  const [truncated, setTruncated] = React.useState(false);
  const [batchLimit, setBatchLimit] = React.useState(100);
  const [loadError, setLoadError] = React.useState(null);
  // `draft` is the editable text; `query` only changes when the search is submitted.
  const [query, setQuery] = React.useState('');
  const [draft, setDraft] = React.useState('');
  const [filter, setFilter] = React.useState('all');
  const [selected, setSelected] = React.useState(() => new Set());
  const [ingest, setIngest] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const generation = React.useRef(0);

  const load = React.useCallback(
    async (signal) => {
      const token = ++generation.current;
      setCandidates(null);
      setLoadError(null);
      try {
        const data = await knowledgeV2Request(
          '/sources/files/candidates',
          workspaceId,
          null,
          signal,
        );
        if (signal?.aborted || generation.current !== token) {
          return;
        }
        setCandidates(data.items);
        setBase(data.base || null);
        setTruncated(Boolean(data.truncated));
        setBatchLimit(data.batchLimit || 100);
        setSelected(new Set());
      } catch (failure) {
        if (!signal?.aborted && generation.current === token) {
          setLoadError(failure);
        }
      }
    },
    [workspaceId],
  );

  React.useEffect(() => {
    if (!open) {
      return undefined;
    }
    const controller = new AbortController();
    setQuery('');
    setDraft('');
    setBase(null);
    setFilter('all');
    setIngest(true);
    setBusy(false);
    setError(null);
    setResult(null);
    load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  const importable = (item) => IMPORTABLE.has(item.state);
  const needle = query.trim().toLowerCase();
  const visible = (candidates || []).filter((item) => {
    if (needle && !item.relativePath.toLowerCase().includes(needle)) {
      return false;
    }
    if (filter === 'available') {
      return importable(item);
    }
    if (filter === 'imported') {
      return item.state === 'imported';
    }
    return true;
  });
  const visibleAvailable = visible.filter(importable).length;
  const toggle = (item) => {
    if (!importable(item)) {
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(item.relativePath)) {
        next.delete(item.relativePath);
      } else {
        next.add(item.relativePath);
      }
      return next;
    });
  };
  const selectVisible = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const item of visible) {
        if (importable(item)) {
          next.add(item.relativePath);
        }
      }
      return next;
    });
  };
  const submit = async () => {
    const files = [...selected].map((relativePath) => ({ relativePath }));
    if (!files.length) {
      setError(new Error(t('kb.import.required')));
      return;
    }
    if (files.length > batchLimit) {
      setError(new Error(t('kb.import.batchLimit', { limit: batchLimit })));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await knowledgeV2Request('/sources/files', workspaceId, {
        files,
        requestKey: crypto.randomUUID(),
        ingest,
      });
      setResult(data);
      const settled = new Set(
        data.results
          .filter((item) => item.status === 'saved' || item.status === 'skipped')
          .map((item) => item.relativePath),
      );
      setCandidates((previous) =>
        previous.map((item) =>
          settled.has(item.relativePath) ? { ...item, state: 'imported' } : item,
        ),
      );
      setSelected(new Set());
      onImported?.(data);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return null;
  }
  const root = base?.path || docsDir || 'docs';
  // A single page (PagedList's default size) sizes to its content; more rows
  // keep a stable scrollable viewport instead of a tall, unbounded dialog.
  const compact = visible.length <= 10;
  const rows = visible.map((item) =>
    h(
      'div',
      { key: item.relativePath, className: css.candidateRow },
      h(Checkbox, {
        checked: selected.has(item.relativePath),
        disabled: busy || !importable(item),
        'aria-label': item.relativePath,
        onChange: () => toggle(item),
      }),
      h('span', { className: css.candidatePath, title: item.relativePath }, item.relativePath),
      h(
        'span',
        { className: css.badge, 'data-tone': badgeTone(item.state) },
        localized(`kb.import.state.${item.state}`, item.state),
      ),
    ),
  );
  const results =
    result &&
    h(
      React.Fragment,
      null,
      h(
        'p',
        { role: 'status' },
        t('kb.import.result', {
          saved: result.saved,
          skipped: result.skipped,
          failed: result.failed,
        }) + (result.job ? ` ${t('kb.import.jobQueued')}` : ''),
      ),
      h('h4', { className: css.catalogTitle }, t('kb.import.results')),
      h(
        'ul',
        { className: css.importResults },
        result.results.map((item) =>
          h(
            'li',
            { key: item.relativePath },
            h(
              'span',
              {
                className: css.badge,
                'data-tone': resultTone(item.status),
              },
              localized(`kb.import.item.${item.status}`, item.status),
            ),
            h('span', null, item.relativePath),
            item.code && h('span', { className: css.muted }, knowledgeV2ErrorText(item)),
          ),
        ),
      ),
    );
  const baseLabel =
    base?.workspace && base?.path
      ? t('kb.import.base', { workspace: base.workspace, path: base.path })
      : null;
  return h(
    Modal,
    { open: true, className: css.importDialog, title: t('kb.import.title'), onClose },
    h(
      'div',
      { className: css.importBody },
      baseLabel && h('p', { className: css.importRoot, title: baseLabel }, baseLabel),
      h(
        'div',
        { className: css.toolbar },
        h(
          'form',
          {
            className: css.searchForm,
            role: 'search',
            onSubmit: (event) => {
              event.preventDefault();
              setQuery(draft.trim());
            },
          },
          h(Input, {
            className: css.importSearch,
            size: 'sm',
            icon: h(IconSearch, { size: 14 }),
            type: 'search',
            value: draft,
            placeholder: t('kb.import.searchPlaceholder'),
            'aria-label': t('kb.import.search'),
            onChange: (event) => setDraft(event.target.value),
          }),
          h(
            Button,
            {
              type: 'submit',
              variant: 'outline',
              size: 'sm',
              disabled: busy || !candidates,
            },
            t('kb.import.searchAction'),
          ),
        ),
        h(Select, {
          size: 'sm',
          value: filter,
          'aria-label': t('kb.import.filter'),
          options: ['all', 'available', 'imported'].map((id) => ({
            id,
            label: localized(`kb.import.filter.${id}`, id),
          })),
          onChange: (event) => setFilter(event.target.value),
        }),
        h(
          'div',
          { className: css.toolbarActions },
          h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              disabled: busy || !visible.some(importable),
              onClick: selectVisible,
            },
            t('kb.import.selectAvailable'),
          ),
          h(
            Button,
            {
              variant: 'outline',
              size: 'sm',
              disabled: busy || !selected.size,
              onClick: () => setSelected(new Set()),
            },
            t('kb.import.clearSelection'),
          ),
        ),
      ),
      candidates &&
        h(
          'span',
          { className: css.muted, role: 'status' },
          t('kb.import.summary', {
            total: visible.length,
            available: visibleAvailable,
            selected: selected.size,
          }),
        ),
      truncated &&
        h(
          'p',
          { className: css.muted, role: 'status' },
          t('kb.import.truncated', { count: candidates?.length || 0 }),
        ),
      loadError && h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(loadError)),
      !candidates && !loadError && h(Skeleton, { lines: 4 }),
      candidates &&
        !visible.length &&
        (needle || filter !== 'all'
          ? h('p', { className: css.muted }, t('kb.import.noHits'))
          : h(EmptyState, { title: t('kb.import.empty', { root }) })),
      candidates &&
        visible.length > 0 &&
        h(
          'div',
          { className: css.candidateFrame, 'data-compact': compact ? 'true' : 'false' },
          h(
            PagedList,
            {
              resetKey: `${needle}|${filter}`,
              rowHeight: 40,
              inspect: false,
              plainRows: true,
              fitContent: compact,
              inset: true,
              busy,
            },
            rows,
          ),
        ),
      error &&
        h(
          'p',
          { role: 'alert', className: css.error },
          error.code ? knowledgeV2ErrorText(error) : localizeMessage(error.message),
        ),
      results && h('div', { className: css.resultPanel }, results),
      h(
        ActionBar,
        {
          leading: h(Checkbox, {
            checked: ingest,
            disabled: busy,
            onChange: (checked) => setIngest(checked),
            label: t('kb.import.ingest'),
          }),
        },
        result?.job &&
          h(
            Button,
            {
              variant: 'outline',
              tone: 'business',
              onClick: () => {
                onClose();
                onOpenTasks?.();
              },
            },
            t('kb.import.viewTasks'),
          ),
        h(Button, { variant: 'outline', onClick: onClose }, t('common.close')),
        h(
          Button,
          {
            variant: 'primary',
            disabled: busy || !selected.size || !candidates,
            onClick: submit,
          },
          busy ? t('common.loading') : t('kb.import.submit'),
        ),
      ),
    ),
  );
}
module.exports = { ImportFilesModal };
