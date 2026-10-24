'use strict';
const React = require('react');
const h = React.createElement;
const { formatSourceLocation } = require('../utils/formatSourceLocation.js');
const { HeaderBack } = require('./shared/HeaderBack.js');
const { FilePreview } = require('./FilePreview.js');
const { EmptyState } = require('./shared/EmptyState.js');
const { Skeleton } = require('./shared/Skeleton.js');
const { knowledgeRequest } = require('../hooks/useKnowledge.js');

const LABELS = { pending: '等待', running: '分析中', completed: '已完成', skipped: '已跳过', failed: '失败', stale: '文件已改变', cancelled: '已取消', interrupted: '已中断', partial: '部分完成', queued: '排队中', cancelling: '取消中' };

function KnowledgePanel({ workspaceId, knowledge, selectedFile, onPreviewClose }) {
  const [tab, setTab] = React.useState('result');
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => { if (selectedFile) setTab('preview'); }, [selectedFile?.path]);
  React.useEffect(() => { if (knowledge.job) setTab('result'); }, [knowledge.job?.id]);
  React.useEffect(() => {
    const controller = new AbortController();
    setError(null);
    knowledgeRequest('/entries', workspaceId, null, controller.signal).then(setData).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [workspaceId, knowledge.job?.updatedAt]);
  const retry = knowledge.job?.files.filter(f => ['failed', 'stale', 'cancelled', 'interrupted'].includes(f.status)).map(f => f.relativePath) || [];
  return h('div', { className: 'rh-knowledge-panel' },
    tab === 'preview' && selectedFile && h(HeaderBack, { onBack: onPreviewClose }),
    h('div', { className: 'rh-knowledge-toolbar' },
      h('div', { className: 'rh-workbench-tabs', role: 'tablist', 'aria-label': '知识库内容' },
        [['preview', '文档预览'], ['result', '分析结果']].map(([id, text]) => h('button', { key: id, role: 'tab', className: 'rh-workbench-tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, text))),
      h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: knowledge.refresh, disabled: knowledge.running }, '刷新')),
    (knowledge.error || error) && h('div', { className: 'rh-knowledge-error', role: 'alert' }, knowledge.error || error),
    tab === 'preview' ? selectedFile
      ? h(FilePreview, { key: selectedFile.path, workspaceId, relPath: selectedFile.path, name: selectedFile.name, onBack: onPreviewClose })
      : h(EmptyState, { title: '选择文件查看内容', description: '单击文件行预览；勾选复选框加入分析清单。' })
      : h('div', { className: 'rh-knowledge-results' },
        h('div', { className: 'rh-search-count' }, knowledge.status ? `知识库：${knowledge.status.entryCount} 篇文档 · ${knowledge.status.sourceCount} 个来源文件` : '正在获取知识库状态…'),
        knowledge.selected.length > 0 && h('details', null, h('summary', null, `已选 ${knowledge.selected.length} 个文件（跨需求累计）`), h('ul', null, knowledge.selected.map(path => h('li', { key: path, title: path }, path)))),
        knowledge.job && h('section', { 'aria-label': '构建进度' },
          h('div', { className: 'rh-knowledge-toolbar' }, h('strong', null, `最近构建 · ${LABELS[knowledge.job.status] || knowledge.job.status}`),
            knowledge.running && h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: knowledge.cancel, disabled: knowledge.job.status === 'cancelling' }, '取消分析'),
            retry.length > 0 && !knowledge.running && h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: () => knowledge.start(retry) }, `重试未完成项（${retry.length}）`)),
          h('p', null, Object.entries(knowledge.job.counts || {}).map(([key, value]) => `${LABELS[key] || key} ${value}`).join(' · ')),
          knowledge.job.error && h('p', { role: 'alert' }, knowledge.job.error),
          knowledge.job.files.map(file => h('div', { className: 'rh-knowledge-file-status', key: file.relativePath },
            h('span', { title: file.relativePath }, file.relativePath), h('span', null, LABELS[file.status] || file.status),
            file.characterCount !== undefined && h('span', null, `${file.characterCount} 字符`),
            (file.error || file.reason) && h('small', null, file.error || file.reason), file.warnings?.length > 0 && h('small', null, file.warnings.join('；'))))),
        !data && !error && h(Skeleton, { lines: 3 }),
        data?.entries?.length ? h('section', { 'aria-label': '已入库文档' }, h('h3', null, '已入库文档（最近 100 条）'), data.entries.map(entry => h('details', { className: 'rh-result-card', key: entry.id },
          h('summary', null, entry.title, ` · v${entry.version}`), h('div', { className: 'rh-knowledge-text' }, entry.body), entry.sources.map((source, i) => h('p', { key: i }, `${source.relativePath} · ${formatSourceLocation(source)}`)))))
          : data && !knowledge.job && h(EmptyState, { title: '当前工作区尚未构建知识库', description: '在左侧文件树勾选文件，然后点击右上角“分析”。' }))
  );
}
module.exports = { KnowledgePanel };
