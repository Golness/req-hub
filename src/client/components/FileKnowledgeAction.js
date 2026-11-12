'use strict';
const React = require('react');
const { t } = require('../locale.js');
const {
  knowledgeV2Request,
  knowledgeV2ErrorText,
  useKnowledgeJobs,
} = require('../hooks/useKnowledgeV2.js');
const { Button } = require('./shared/Button.js');
const { showToast } = require('./shared/ToastContainer.js');
const h = React.createElement;

/**
 * Import the saved document as a knowledge source, or queue its Wiki update.
 * @param props - {workspaceId, path, revision, onChanged, dirty} from the preview header.
 * @returns A knowledge status span, or the action button for the current source state.
 */
function FileKnowledgeAction({ workspaceId, path, revision, onChanged, dirty }) {
  const jobs = useKnowledgeJobs(workspaceId);
  const [state, setState] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const jobStatus = jobs.jobs.map((job) => `${job.id}:${job.status}`).join('|');
  React.useEffect(() => {
    const controller = new AbortController();
    setState(null);
    setError(null);
    knowledgeV2Request(
      `/source-state?path=${encodeURIComponent(path)}`,
      workspaceId,
      null,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setState(data);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(failure);
        }
      });
    return () => controller.abort();
  }, [workspaceId, path, revision, reload, jobStatus]);
  const refresh = () => {
    setReload((value) => value + 1);
    onChanged?.();
  };
  const importFile = async () => {
    setBusy(true);
    try {
      const result = await knowledgeV2Request('/sources/files', workspaceId, {
        files: [{ relativePath: path }],
        requestKey: crypto.randomUUID(),
        ingest: true,
      });
      const item = result.results?.[0];
      if (item?.status === 'failed') {
        showToast({ tone: 'error', text: knowledgeV2ErrorText(item) });
      } else if (item?.status === 'skipped') {
        showToast({ text: t('kb.file.unchanged') });
      } else {
        showToast({ text: result.job ? t('kb.file.savedToast') : t('kb.file.saved') });
      }
      refresh();
    } catch (failure) {
      showToast({ tone: 'error', text: knowledgeV2ErrorText(failure) });
    } finally {
      setBusy(false);
    }
  };
  const compile = async () => {
    setBusy(true);
    try {
      await knowledgeV2Request('/jobs', workspaceId, {
        kind: 'ingest',
        sourceIds: [state.sourceId],
        requestKey: crypto.randomUUID(),
      });
      showToast({ text: t('kb.file.jobQueued') });
      refresh();
    } catch (failure) {
      showToast({ tone: 'error', text: knowledgeV2ErrorText(failure) });
    } finally {
      setBusy(false);
    }
  };
  if (error) {
    return h(
      Button,
      {
        variant: 'ghost',
        size: 'sm',
        title: knowledgeV2ErrorText(error),
        onClick: () => setReload((value) => value + 1),
      },
      t('kb.file.retry'),
    );
  }
  if (state?.state === 'compiling') {
    return h('span', { role: 'status' }, t('kb.file.compiling'));
  }
  if (state?.state === 'failed') {
    const reason = state.error ? knowledgeV2ErrorText(state.error) : t('kb.file.failed');
    return h(
      React.Fragment,
      null,
      h('span', { role: 'status', title: reason }, t('kb.file.compileFailed')),
      h(
        Button,
        {
          variant: 'ghost',
          size: 'sm',
          disabled: dirty || busy,
          title: dirty ? t('kb.file.saveFirst') : reason,
          onClick: compile,
        },
        t('kb.file.retryCompile'),
      ),
    );
  }
  if (!dirty && state?.state === 'compiled') {
    return h('span', { role: 'status' }, t('kb.file.compiled'));
  }
  let label = t('kb.file.checking');
  let title;
  let onClick;
  if (state?.state === 'saved') {
    label = t('kb.file.compile');
    title = t('kb.file.addTitle');
    onClick = compile;
  } else if (state?.state === 'stale') {
    label = t('kb.file.update');
    title = t('kb.file.addTitle');
    onClick = importFile;
  } else if (state?.state === 'missing') {
    label = t('kb.file.add');
    title = t('kb.file.addTitle');
    onClick = importFile;
  }
  return h(
    Button,
    {
      variant: 'ghost',
      size: 'sm',
      disabled: dirty || busy || !state,
      title: dirty ? t('kb.file.saveFirst') : title,
      onClick,
    },
    label,
  );
}
module.exports = { FileKnowledgeAction };
