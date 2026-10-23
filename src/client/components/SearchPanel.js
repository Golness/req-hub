'use strict';
const React = require('react');
const h = React.createElement;
const { useSearch } = require('../hooks/useSearch.js');
const { knowledgeRequest } = require('../hooks/useKnowledge.js');
const { EmptyState } = require('./shared/EmptyState.js');
const { Skeleton } = require('./shared/Skeleton.js');

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
        h('input', { ref: inputRef, className: 'rh-search-input', type: 'search', 'aria-label': '搜索整个知识库', placeholder: '搜索整个知识库的内容…', value: query, onChange: e => setQuery(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) e.preventDefault(); } }),
        h('button', { className: 'rh-btn rh-btn-primary', type: 'submit', disabled: search.loading || !query.trim() }, '搜索'))),
    search.error && h('div', { role: 'alert', className: 'rh-knowledge-error' }, search.error, h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: submit }, '重试')),
    search.warnings?.length > 0 && h('div', { role: 'alert', className: 'rh-knowledge-error' }, `部分知识库暂时无法检索：${search.warnings.map(w => `${w.workspaceTitle}（${w.message}）`).join('；')}`),
    search.knowledgeReady === false && h(EmptyState, { title: '知识库尚无已入库内容', description: '先在知识库勾选文件并分析，再搜索知识内容。', actions: [{ label: '进入知识库', onClick: onOpenKnowledge }] }),
    h('div', { className: 'rh-knowledge-results' },
      search.loading ? h(Skeleton, { lines: 4 }) : detailId
        ? h('section', { 'aria-label': '知识详情' },
          h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: () => setDetailId(null) }, '返回搜索结果'),
          detailError && h('p', { role: 'alert' }, detailError),
          !detail && !detailError && h(Skeleton, { lines: 3 }),
          detail && h(React.Fragment, null, h('h3', null, detail.title), h('p', null, `${detail.workspaceTitle} · 版本 v${detail.version} · ${detail.tags.join(' · ')}`), h('div', { className: 'rh-knowledge-text' }, detail.body),
            h('h4', null, '来源文件'), detail.sources.map((source, i) => h('div', { key: i }, h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: () => onOpenSource?.(source), disabled: ['missing', 'unavailable'].includes(source.status), title: source.relativePath }, `${source.relativePath} · ${source.coordinate === 'extracted' ? '提取正文行' : '行'} ${source.startLine}–${source.endLine}`), ['missing', 'unavailable'].includes(source.status) && h('span', null, '来源不存在或无法读取'), source.status === 'stale' && h('span', null, '来源已更新，请重新分析'))),
            h('details', null, h('summary', null, '版本历史'), detail.versions?.map(version => h('div', { key: version.version }, h('strong', null, `v${version.version}`), h('div', { className: 'rh-knowledge-text' }, version.body))))))
        : search.searched && !search.error && search.knowledgeReady !== false
          ? h(React.Fragment, null, h('div', { className: 'rh-search-count' }, `找到 ${search.results.length} 条知识${search.hasMore ? '（还有更多）' : ''}`),
            search.results.length ? search.results.map(entry => h('button', { key: `${entry.workspaceId}:${entry.id}`,  type: 'button', className: 'rh-result-card rh-knowledge-hit', onClick: () => setDetailId({ id: entry.id, workspaceId: entry.workspaceId, workspaceTitle: entry.workspaceTitle }) }, h('strong', { className: 'rh-result-title' }, entry.title), h('div', { className: 'rh-result-summary' }, entry.snippet), h('div', { className: 'rh-result-meta' }, `${entry.workspaceTitle} · ${entry.sources.map(s => s.relativePath).join(' · ')}`))) : h(EmptyState, { title: '无匹配知识', description: '请尝试其他关键词，或分析更多来源文件。' }),
            search.hasMore && (limit < 100 ? h('button', { className: 'rh-btn rh-btn-ghost', onClick: () => { const next = Math.min(100, limit + 20); setLimit(next); search.handleSearch(query, next); } }, '显示更多') : h('p', null, '已显示前 100 条，请收窄查询。')))
          : search.knowledgeReady !== false && !search.error && h(EmptyState, { title: '搜索整个知识库', description: '输入关键词搜索所有工作区已入库的文档内容。' })));
}
module.exports = { SearchPanel };
