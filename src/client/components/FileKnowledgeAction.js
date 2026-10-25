'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { useKnowledge, knowledgeRequest } = require('../hooks/useKnowledge.js');
const { Button } = require('./shared/Button.js');
const { showToast } = require('./shared/ToastContainer.js');
const h = React.createElement;

/** Check exact source identity, independently of paginated entry lists. */
function FileKnowledgeAction({ workspaceId, path, revision, onChanged, dirty }) {
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const knowledge = useKnowledge(workspaceId);
  const [source, setSource] = React.useState(null), [error, setError] = React.useState('');
  const [reload, setReload] = React.useState(0);
  const [submitted, setSubmitted] = React.useState(null);
  React.useEffect(() => {
    if (!submitted || knowledge.job?.id !== submitted || ['queued', 'running', 'cancelling'].includes(knowledge.job.status)) return;
    const file = knowledge.job.files?.find(file => file.relativePath === path);
    if (file && !['completed', 'skipped'].includes(file.status)) showToast({ tone: 'error', text: file.error || knowledge.job.error || t('knowledgeLayout.failed') });
    setSubmitted(null); onChanged?.();
  }, [submitted, knowledge.job?.updatedAt, knowledge.job?.status]);
  React.useEffect(() => {
    const controller = new AbortController(); setSource(null); setError('');
    knowledgeRequest(`/source?path=${encodeURIComponent(path)}`, workspaceId, null, controller.signal)
      .then(data => { if (!controller.signal.aborted) setSource(data); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [workspaceId, path, revision, reload, knowledge.job?.updatedAt]);
  if (error) return h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', title: error, onClick: () => setReload(value => value + 1) }, t('knowledgeLayout.retryStatus'));
  if (!dirty && source?.indexed && source.status === 'active') return h('span', { role: 'status' }, t('knowledgeLayout.indexed'));
  return h(Button, { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: dirty || !source || knowledge.running, title: dirty ? t('knowledgeLayout.saveFirst') : knowledge.error || t('knowledgeLayout.savedFile'),
    onClick: async () => { const job = await knowledge.start([path]); if (!alive.current) return; if (job) { setSubmitted(job.id); onChanged?.(); } else showToast({ tone: 'error', text: t('knowledgeLayout.failed') }); } },
    knowledge.running ? t('knowledgeLayout.importing') : !source ? t('knowledgeLayout.checking') : source.indexed ? t('knowledgeLayout.update') : t('knowledgeLayout.import'));
}
module.exports = { FileKnowledgeAction };
