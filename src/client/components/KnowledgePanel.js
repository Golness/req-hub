'use strict';
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const React = require('react');
const h = React.createElement;
const { formatSourceLocation } = require('../utils/formatSourceLocation.js');
const { HeaderBack } = require('./shared/HeaderBack.js');
const { FilePreview } = require('./FilePreview.js');
const { EmptyState } = require('./shared/EmptyState.js');
const { Skeleton } = require('./shared/Skeleton.js');
const { knowledgeRequest } = require('../hooks/useKnowledge.js');

const LABELS = { pending: t("KnowledgePanel.message001"), running: t("KnowledgePanel.message002"), completed: t("KnowledgePanel.message003"), skipped: t("KnowledgePanel.message004"), failed: t("KnowledgePanel.message005"), stale: t("KnowledgePanel.message006"), cancelled: t("KnowledgePanel.message007"), interrupted: t("KnowledgePanel.message008"), partial: t("KnowledgePanel.message009"), queued: t("KnowledgePanel.message010"), cancelling: t("KnowledgePanel.message011") };

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
      h('div', { className: 'rh-workbench-tabs', role: 'tablist', 'aria-label': t("KnowledgePanel.message012") },
        [['preview', t("KnowledgePanel.message013")], ['result', t("KnowledgePanel.message014")]].map(([id, text]) => h('button', { key: id, role: 'tab', className: 'rh-workbench-tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, text))),
      h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: knowledge.refresh, disabled: knowledge.running }, t("KnowledgePanel.message015"))),
    (knowledge.error || error) && h('div', { className: 'rh-knowledge-error', role: 'alert' }, knowledge.error || error),
    tab === 'preview' ? selectedFile
      ? h(FilePreview, { key: selectedFile.path, workspaceId, relPath: selectedFile.path, name: selectedFile.name, onBack: onPreviewClose })
      : h(EmptyState, { title: t("KnowledgePanel.message016"), description: t("KnowledgePanel.message017") })
      : h('div', { className: 'rh-knowledge-results' },
        h('div', { className: 'rh-search-count' }, knowledge.status ? t("KnowledgePanel.message018", { value0: knowledge.status.entryCount, value1: knowledge.status.sourceCount }) : t("KnowledgePanel.message019")),
        knowledge.selected.length > 0 && h('details', null, h('summary', null, t("KnowledgePanel.message020", { value0: knowledge.selected.length })), h('ul', null, knowledge.selected.map(path => h('li', { key: path, title: path }, path)))),
        knowledge.job && h('section', { 'aria-label': t("KnowledgePanel.message021") },
          h('div', { className: 'rh-knowledge-toolbar' }, h('strong', null, t("KnowledgePanel.message022", { value0: LABELS[knowledge.job.status] || knowledge.job.status })),
            knowledge.running && h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: knowledge.cancel, disabled: knowledge.job.status === 'cancelling' }, t("KnowledgePanel.message023")),
            retry.length > 0 && !knowledge.running && h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: () => knowledge.start(retry) }, t("KnowledgePanel.message024", { value0: retry.length }))),
          h('p', null, Object.entries(knowledge.job.counts || {}).map(([key, value]) => `${LABELS[key] || key} ${value}`).join(' · ')),
          knowledge.job.error && h('p', { role: 'alert' }, knowledge.job.error),
          knowledge.job.files.map(file => h('div', { className: 'rh-knowledge-file-status', key: file.relativePath },
            h('span', { title: file.relativePath }, file.relativePath), h('span', null, LABELS[file.status] || file.status),
            file.characterCount !== undefined && h('span', null, t("KnowledgePanel.message025", { value0: file.characterCount })),
            (file.error || file.reason) && h('small', null, file.error || file.reason), file.warnings?.length > 0 && h('small', null, file.warnings.join('；'))))),
        !data && !error && h(Skeleton, { lines: 3 }),
        data?.entries?.length ? h('section', { 'aria-label': t("KnowledgePanel.message026") }, h('h3', null, t("KnowledgePanel.message027")), data.entries.map(entry => h('details', { className: 'rh-result-card', key: entry.id },
          h('summary', null, entry.title, ` · v${entry.version}`), h('div', { className: 'rh-knowledge-text' }, entry.body), entry.sources.map((source, i) => h('p', { key: i }, `${source.relativePath} · ${formatSourceLocation(source)}`)))))
          : data && !knowledge.job && h(EmptyState, { title: t("KnowledgePanel.message028"), description: t("KnowledgePanel.message029") }))
  );
}
module.exports = { KnowledgePanel };
