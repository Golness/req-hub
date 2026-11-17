'use strict';
const React = require('react');
const { t, hasLocaleKey } = require('../../locale.js');
const { formatDateTime, useTimeZone } = require('../../time.js');
const { Button } = require('../shared/Button.js');
const { Input } = require('../shared/Input.js');
const { EmptyState } = require('../shared/EmptyState.js');
const { Skeleton } = require('../shared/Skeleton.js');
const { showToast } = require('../shared/ToastContainer.js');
const { MilkdownEditor } = require('../MilkdownEditor.js');
const { knowledgeV2Request, knowledgeV2ErrorText } = require('../../hooks/useKnowledgeV2.js');
const css = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;
const { IconSearch, IconSync, IconChevronRight, IconChevronDown } =
  require('../../icons.js').createIconComponents(h);

const GROUPS = ['aggregate', 'entity', 'concept', 'topic', 'source', 'other'];

const groupOf = (page) => (GROUPS.includes(page.type) ? page.type : 'other');

/** Resolve an enum-derived key without letting an unknown value break the panel. */
const localized = (key, fallback) => (hasLocaleKey(key) ? t(key) : fallback);

const pageTitle = (page) => {
  if (page.type !== 'aggregate') {
    return page.title;
  }
  return localized(`kb.wiki.page.${page.pageId}`, page.title || page.pageId);
};

/** Strip Host frontmatter and turn wikilinks into interceptable wiki: links. */
const displayBody = (text) =>
  text.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/\[\[([^\[\]\n]+)\]\]/g, (_, inner) => {
    const split = inner.indexOf('|');
    const id = (split === -1 ? inner : inner.slice(0, split)).trim();
    const label = (split === -1 ? inner : inner.slice(split + 1)).trim();
    return `[${label.replace(/[()]/g, '')}](wiki:${id})`;
  });

/**
 * Browse the published Wiki generation: grouped catalog, page body and links.
 * @param props - Workspace identity, refresh signals and navigation callbacks.
 * @returns The rendered component content.
 */
function WikiBrowser({
  workspaceId,
  refreshKey,
  generationId,
  running,
  pageRequest,
  onChanged,
  onOpenImport,
  onOpenSource,
}) {
  useTimeZone();
  const [catalog, setCatalog] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [page, setPage] = React.useState(null);
  const [pageError, setPageError] = React.useState(null);
  const [filter, setFilter] = React.useState('');
  const [catalogOpen, setCatalogOpen] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [sourceTitles, setSourceTitles] = React.useState({});
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setError(null);
    knowledgeV2Request('/pages', workspaceId, null, controller.signal)
      .then((data) => {
        if (!Array.isArray(data.pages)) {
          throw Object.assign(new Error('API_RESPONSE_INVALID'), { code: 'API_RESPONSE_INVALID' });
        }
        if (!controller.signal.aborted) {
          setCatalog(data);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(failure);
        }
      });
    return () => controller.abort();
  }, [workspaceId, refreshKey, generationId, reload]);
  React.useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const titles = {};
      let offset = 0;
      for (;;) {
        const data = await knowledgeV2Request(
          `/sources?offset=${offset}&limit=200`,
          workspaceId,
          null,
          controller.signal,
        );
        for (const item of data.items) {
          titles[item.id] = item.title;
        }
        offset += data.items.length;
        if (!data.items.length || offset >= data.total) {
          break;
        }
      }
      if (!controller.signal.aborted) {
        setSourceTitles(titles);
      }
    };
    load().catch(() => {
      // Source titles are decorative; pages still render with raw source IDs.
    });
    return () => controller.abort();
  }, [workspaceId, refreshKey, generationId]);
  React.useEffect(() => {
    if (pageRequest?.pageId) {
      setSelected(pageRequest.pageId);
      setCatalogOpen(true);
    }
  }, [pageRequest]);
  React.useEffect(() => {
    if (!selected) {
      setPage(null);
      return;
    }
    const controller = new AbortController();
    setPage(null);
    setPageError(null);
    knowledgeV2Request(
      `/pages/${encodeURIComponent(selected)}`,
      workspaceId,
      null,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setPage(data);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setPageError(failure);
        }
      });
    return () => controller.abort();
  }, [workspaceId, selected, generationId, refreshKey]);
  const enqueue = async (kind) => {
    setBusy(true);
    try {
      let sourceIds;
      if (kind === 'ingest') {
        const pending = [];
        let offset = 0;
        for (;;) {
          const data = await knowledgeV2Request(`/sources?offset=${offset}&limit=200`, workspaceId);
          pending.push(...data.items.filter((item) => !item.compiled).map((item) => item.id));
          offset += data.items.length;
          if (!data.items.length || offset >= data.total) {
            break;
          }
        }
        if (!pending.length) {
          showToast({ tone: 'info', text: t('kb.error.KB_NOTHING_TO_COMPILE') });
          return;
        }
        sourceIds = pending;
      }
      await knowledgeV2Request('/jobs', workspaceId, {
        kind,
        sourceIds,
        requestKey: crypto.randomUUID(),
      });
      showToast({ tone: 'success', text: t('kb.file.jobQueued') });
      onChanged?.();
    } catch (failure) {
      showToast({ tone: 'error', text: knowledgeV2ErrorText(failure) });
    } finally {
      setBusy(false);
    }
  };
  const openLink = (event) => {
    const anchor = event.target.closest?.('a[href^="wiki:"]');
    if (anchor) {
      event.preventDefault();
      event.stopPropagation();
      setSelected(anchor.getAttribute('href').slice(5));
    }
  };
  if (error) {
    return h(
      'div',
      { className: css.toolbar },
      h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(error)),
      h(Button, { size: 'sm', onClick: () => setReload((value) => value + 1) }, t('common.retry')),
    );
  }
  if (!catalog) {
    return h(Skeleton, { lines: 4 });
  }
  if (!catalog.pages.length) {
    return h(EmptyState, {
      title: t('kb.wiki.empty'),
      description: t('kb.wiki.emptyHint'),
      actions: [{ label: t('kb.wiki.importFiles'), variant: 'primary', onClick: onOpenImport }],
    });
  }
  const needle = filter.trim().toLowerCase();
  const visible = catalog.pages.filter(
    (item) =>
      !needle ||
      item.title.toLowerCase().includes(needle) ||
      item.pageId.toLowerCase().includes(needle),
  );
  const groups = GROUPS.map((type) => ({
    type,
    pages: visible.filter((item) => groupOf(item) === type),
  })).filter((group) => group.pages.length);
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: css.toolbar },
      h(Input, {
        icon: h(IconSearch, { size: 14 }),
        type: 'search',
        value: filter,
        placeholder: t('kb.wiki.searchPlaceholder'),
        'aria-label': t('kb.wiki.search'),
        onChange: (event) => setFilter(event.target.value),
      }),
      h('span', { className: css.toolbarSpacer }),
      h(
        Button,
        {
          variant: 'primary',
          size: 'sm',
          icon: h(IconSync, { size: 14 }),
          disabled: busy || running,
          onClick: () => enqueue('ingest'),
        },
        t('kb.wiki.update'),
      ),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          disabled: busy || running,
          onClick: () => enqueue('rebuild'),
        },
        t('kb.wiki.rebuild'),
      ),
    ),
    running && h('p', { className: css.notice, role: 'status' }, t('kb.wiki.running')),
    h(
      'div',
      { className: css.wikiLayout },
      catalogOpen &&
        h(
          'nav',
          { className: css.catalog, 'aria-label': t('kb.wiki.catalog') },
          h(
            'div',
            { className: css.toolbar },
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                icon: h(IconChevronDown, { size: 14 }),
                'aria-label': t('kb.wiki.closeCatalog'),
                onClick: () => setCatalogOpen(false),
              },
              t('kb.wiki.catalog'),
            ),
          ),
          !groups.length && h('p', { className: css.muted }, t('kb.wiki.noHits')),
          groups.map((group) =>
            h(
              'div',
              { key: group.type, className: css.catalogGroup },
              h(
                'h3',
                { className: css.catalogTitle },
                localized(`kb.wiki.group.${group.type}`, group.type),
              ),
              group.pages.map((item) =>
                h(
                  'button',
                  {
                    key: item.pageId,
                    type: 'button',
                    className: css.pageButton,
                    'aria-current': selected === item.pageId ? 'true' : undefined,
                    title: item.pageId,
                    onClick: () => setSelected(item.pageId),
                  },
                  pageTitle(item),
                ),
              ),
            ),
          ),
        ),
      h(
        'div',
        { className: css.content, onClickCapture: openLink },
        !catalogOpen &&
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              icon: h(IconChevronRight, { size: 14 }),
              onClick: () => setCatalogOpen(true),
            },
            t('kb.wiki.openCatalog'),
          ),
        !selected && h(EmptyState, { title: t('kb.wiki.noPage') }),
        selected && !page && !pageError && h(Skeleton, { lines: 4 }),
        pageError &&
          h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(pageError)),
        page &&
          h(
            React.Fragment,
            null,
            h(
              'div',
              { className: css.pageMeta },
              h('span', null, t('kb.wiki.pageCount', { count: catalog.pages.length })),
              catalog.publishedAt &&
                h(
                  'span',
                  null,
                  t('kb.wiki.publishedAt', { time: formatDateTime(catalog.publishedAt) }),
                ),
            ),
            h(MilkdownEditor, { content: displayBody(page.text), readOnly: true }),
            page.links?.length > 0 &&
              h(
                'section',
                { 'aria-label': t('kb.wiki.links') },
                h('h3', { className: css.catalogTitle }, t('kb.wiki.links')),
                h(
                  'div',
                  { className: css.links },
                  page.links.map((link) => {
                    const [id, label] = link.split('|');
                    return h(
                      Button,
                      {
                        key: link,
                        variant: 'outline',
                        size: 'sm',
                        onClick: () => setSelected(id),
                      },
                      label || id,
                    );
                  }),
                ),
              ),
            page.meta?.sources?.length > 0 &&
              h(
                'section',
                { 'aria-label': t('kb.wiki.sources') },
                h('h3', { className: css.catalogTitle }, t('kb.wiki.sources')),
                h(
                  'div',
                  { className: css.links },
                  page.meta.sources.map((ref) =>
                    h(
                      Button,
                      {
                        key: ref.id,
                        variant: 'outline',
                        size: 'sm',
                        title: ref.id,
                        onClick: () => onOpenSource?.(ref.id),
                      },
                      sourceTitles[ref.id] || ref.id,
                    ),
                  ),
                ),
              ),
          ),
      ),
    ),
  );
}
module.exports = { WikiBrowser };
