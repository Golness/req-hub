'use strict';
const { Input } = require('./shared/Input.js');
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const React = require('react');
const h = React.createElement;
const { formatSourceLocation } = require('../utils/formatSourceLocation.js');
const { HeaderBack } = require('./shared/HeaderBack.js');
const { useSearch } = require('../hooks/useSearch.js');
const { knowledgeRequest } = require('../hooks/useKnowledge.js');
const { EmptyState } = require('./shared/EmptyState.js');
const { Skeleton } = require('./shared/Skeleton.js');
const { ConversationProvenance } = require('./ConversationProvenance.js');
const { DocumentAssist } = require('./ContextAssist.js');

function SearchPanel({ onOpenKnowledge, onOpenSource, active = true }) {
  const [query, setQuery] = React.useState('');
  const [limit, setLimit] = React.useState(20);
  const [detail, setDetail] = React.useState(null);
  const [detailError, setDetailError] = React.useState(null);
  const [detailId, setDetailId] = React.useState(null);
  const inputRef = React.useRef(null);
  const search = useSearch();
  React.useEffect(() => { if (active) inputRef.current?.focus(); }, [active]);
  React.useEffect(() => {
    setDetail(null); setDetailError(null);
    if (!detailId) return;
    const controller = new AbortController();
    knowledgeRequest(`/entries/${encodeURIComponent(detailId.id)}`, detailId.workspaceId, null, controller.signal).then(result => {
      if (!controller.signal.aborted) setDetail({ ...result, workspaceTitle: detailId.workspaceTitle, sources: result.sources.map(source => ({ ...source, workspaceId: detailId.workspaceId, workspaceTitle: detailId.workspaceTitle })) });
    }).catch(e => { if (!controller.signal.aborted) setDetailError(e.message); });
    return () => controller.abort();
  }, [detailId]);
  const submit = event => {
    event?.preventDefault();
    if (!query.trim() || search.loading) return;
    setDetailId(null); setLimit(20); search.handleSearch(query, 20);
  };
  return h('div', { className: 'rh-knowledge-panel' },
    h('form', { className: 'rh-search-bar', role: 'search', onSubmit: submit },
      h('div', { className: 'rh-knowledge-toolbar' },
        h(Input, { ref: inputRef, className: 'rh-search-input', type: 'search', 'aria-label': t("SearchPanel.message001"), placeholder: t("SearchPanel.message002"), value: query, onChange: e => setQuery(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault(); } }),
        h(Button, { className: 'rh-btn rh-btn-primary', type: 'submit', disabled: search.loading || !query.trim() }, t("DocsViewerBody.message055")))),
    search.error && h('div', { role: 'alert', className: 'rh-knowledge-error' }, search.error, h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: submit }, t("common.retry"))),
    search.warnings?.length > 0 && h('div', { role: 'alert', className: 'rh-knowledge-error' }, t("SearchPanel.message003", { value0: search.warnings.map(w => `${w.workspaceTitle}（${w.message}）`).join('；') })),
    search.knowledgeReady === false && h(EmptyState, { title: t("SearchPanel.message004"), description: t("SearchPanel.message005"), actions: [{ label: t("SearchPanel.message006"), onClick: onOpenKnowledge }] }),
    h('div', { className: 'rh-knowledge-results' },
      search.loading ? h(Skeleton, { lines: 4 }) : detailId
        ? h('section', { 'aria-label': t("SearchPanel.message007") },
          h(HeaderBack, { onBack: () => setDetailId(null), active, label: t("SearchPanel.message008") }),
          detailError && h('p', { role: 'alert' }, detailError),
          !detail && !detailError && h(Skeleton, { lines: 3 }),
          detail && h(React.Fragment, null, h('h3', null, detail.title), h('p', null, t("SearchPanel.message009", { value0: detail.workspaceTitle, value1: detail.version, value2: detail.tags.join(' · ') })), h(ConversationProvenance, { conversation: detail.conversation }), h('div', { className: 'rh-knowledge-text' }, detail.body),
            !detail.conversation && h(DocumentAssist, { key: detail.id, workspaceId: detailId.workspaceId, documentId: detail.id, onOpenSource }),
            h('h4', null, t("SearchPanel.message010")), detail.sources.map((source, i) => h('div', { key: i }, source.conversation ? h('p', null, `${source.conversation.title} · ${formatSourceLocation(source)}`) : h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: () => onOpenSource?.(source), disabled: ['missing', 'unavailable'].includes(source.status), title: source.relativePath }, `${source.relativePath} · ${formatSourceLocation(source)}`), ['missing', 'unavailable'].includes(source.status) && h('span', null, t("SearchPanel.message011")), source.status === 'stale' && h('span', null, t("SearchPanel.message012")))),
            h('details', null, h('summary', null, t("SearchPanel.message013")), detail.versions?.map(version => h('div', { key: version.version }, h('strong', null, `v${version.version}`), h(ConversationProvenance, { conversation: version.conversation }), h('div', { className: 'rh-knowledge-text' }, version.body))))))
        : search.searched && !search.error && search.knowledgeReady !== false
          ? h(React.Fragment, null, h('div', { className: 'rh-search-count' }, t("SearchPanel.message015", { value0: search.results.length, value1: search.hasMore ? t("SearchPanel.message014") : '' })),
            search.results.length ? search.results.map(entry => h('button', { key: `${entry.workspaceId}:${entry.id}`,  type: 'button', className: 'rh-result-card rh-knowledge-hit', onClick: () => setDetailId({ id: entry.id, workspaceId: entry.workspaceId, workspaceTitle: entry.workspaceTitle }) }, h('strong', { className: 'rh-result-title' }, entry.title), h('div', { className: 'rh-result-summary' }, entry.snippet), h('div', { className: 'rh-result-meta' }, `${entry.workspaceTitle} · ${entry.sources.map(s => `${s.conversation?.title || s.relativePath} · ${formatSourceLocation(s)}`).join(' · ')}`))) : h(EmptyState, { title: t("SearchPanel.message016"), description: t("SearchPanel.message017") }),
            search.hasMore && (limit < 100 ? h(Button, { className: 'rh-btn rh-btn-ghost', onClick: () => { const next = Math.min(100, limit + 20); setLimit(next); search.handleSearch(query, next); } }, t("SearchPanel.message018")) : h('p', null, t("SearchPanel.message019"))))
          : search.knowledgeReady !== false && !search.error && h(EmptyState, { title: t("SearchPanel.message001"), description: t("SearchPanel.message020") })));
}
module.exports = { SearchPanel };
