'use strict';
const { formatDateTime, useTimeZone } = require('../time.js');
const { PagedList } = require('./shared/PagedList.js');
const { Disclosure } = require('./shared/Disclosure.js');
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { Button } = require('./shared/Button.js');
const { SettingsActionBar } = require('./shared/SettingsActionBar.js');
const { Checkbox, HoverCard, Modal } = require('./shared/controls.js');
const { Select } = require('./shared/Select.js');
const { Input } = require('./shared/Input.js');
const { DiffViewer } = require('./shared/DiffViewer.js');
const { GitNexusTaskStatus } = require('./GitNexusTaskStatus.js');
const { AiTaskStatus } = require('./shared/AiTaskStatus.js');
const { SessionSelectionContext } = require('../context.js');
const css = require('./ContextAssist.module.css').default;
const formCss = require('./shared/SettingsForm.module.css').default;
const settingsCss = require('./EnhancementSettings.module.css').default;
const h = React.createElement;
const { IconInfo } = require('../icons.js').createIconComponents(h);
const codeJobKinds = ['code-refresh', 'code-index'];
const RELATED_BATCH_SIZE = 6;
const active = (job) => ['queued', 'preparing', 'running', 'cancelling'].includes(job?.status);
const state = (value) => t(`enhancement.state.${value || 'unavailable'}`);
const indexState = (code) =>
  code?.status && code.status !== 'disabled' ? state(code.status) : t('assist.settings.unchecked');

function useAssist(workspaceId, context, revision, jobKinds) {
  const session = React.useContext(SessionSelectionContext);
  const key = JSON.stringify(context || null);
  const [data, setData] = React.useState(null);
  const [job, setJob] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [reload, refresh] = React.useReducer((value) => value + 1, 0);
  const controller = React.useRef(null);
  const request = React.useCallback(
    async (path, body, signal) => {
      const headers = { ...(session() ? { 'x-session-id': session() } : {}) };
      const response = await fetch(
        `${ROUTE}/knowledge/enhancements/${path}${body ? '' : `${path.includes('?') ? '&' : '?'}workspaceId=${encodeURIComponent(workspaceId)}`}`,
        body
          ? {
              method: 'POST',
              signal,
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...body, workspaceId }),
            }
          : { signal, headers },
      );
      const value = await response.json();
      if (!response.ok) {
        throw new Error(value.error || 'ENHANCEMENT_FAILED');
      }
      return value;
    },
    [workspaceId, session],
  );
  React.useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    setJob(null);
    setData(null);
    setError('');
    setBusy(false);
    return () => abort.abort();
  }, [workspaceId, key]);
  React.useEffect(() => {
    const abort = new AbortController();
    const path = context
      ? `context?${new URLSearchParams(Object.entries(context).filter(([, value]) => value !== undefined && value !== null))}`
      : 'jobs';
    request(path, null, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) {
          setData(value);
          setJob(
            (old) =>
              old ||
              value.jobs?.find(
                (job) => active(job) && (!jobKinds || jobKinds.includes(job.kind)),
              ) ||
              null,
          );
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setError(error.message);
        }
      });
    return () => abort.abort();
  }, [workspaceId, key, reload, revision, request, jobKinds]);
  React.useEffect(() => {
    if (!active(job)) {
      return;
    }
    const abort = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const value = await request(`jobs/${job.id}`, null, abort.signal);
        if (abort.signal.aborted) {
          return;
        }
        setJob(value);
        if (active(value)) {
          timer = setTimeout(poll, 1000);
        } else {
          refresh();
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          setError(error.message);
          timer = setTimeout(poll, 3000);
        }
      }
    };
    poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [job?.id, active(job), request]);
  const perform = async (operation) => {
    const signal = controller.current.signal;
    if (busy || signal.aborted) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await operation(signal);
    } catch (error) {
      if (!signal.aborted) {
        setError(error.message);
      }
    } finally {
      if (!signal.aborted) {
        setBusy(false);
      }
    }
  };
  const start = (kind, mode, draft, referenceRefs) =>
    perform(async (signal) => {
      setJob(
        await request(
          'jobs',
          {
            kind,
            mode,
            context,
            ...(draft !== undefined ? { draft } : {}),
            ...(referenceRefs ? { referenceRefs } : {}),
            requestKey: crypto.randomUUID(),
            sessionId: session(),
            useCode: kind === 'graph-build',
          },
          signal,
        ),
      );
    });
  return {
    data,
    job,
    setJob,
    busy,
    error,
    request,
    perform,
    start,
    refresh,
    locked: busy || active(job),
    cancel: () =>
      perform(async (signal) => setJob(await request(`jobs/${job.id}/cancel`, {}, signal))),
  };
}

function TaskResult({ api }) {
  const { job } = api;
  if (!job) {
    return null;
  }
  const percent = job.activity?.percent;
  return h(
    'section',
    { className: css.task, 'aria-label': t('enhancement.task') },
    h(
      'div',
      { className: css.actions },
      h('span', { role: 'status' }, state(job.status)),
      active(job) &&
        h(
          Button,
          {
            size: 'sm',
            tone: 'warning',
            disabled: api.busy || job.status === 'cancelling',
            onClick: api.cancel,
          },
          t('enhancement.cancel'),
        ),
    ),
    active(job) &&
      job.kind !== 'code-index' &&
      h(AiTaskStatus, {
        startedAt: job.createdAt,
        stage: job.activity?.stage,
        cancelling: job.status === 'cancelling',
      }),
    active(job) &&
      job.kind === 'code-index' &&
      h(
        React.Fragment,
        null,
        h(
          'span',
          null,
          t(
            ['index_preparing', 'index_running', 'mcp_status', 'mcp_query'].includes(
              job.activity?.stage,
            )
              ? `enhancement.stage.${job.activity.stage}`
              : 'enhancement.stage.index_preparing',
          ),
        ),
        Number.isFinite(percent) &&
          h('progress', {
            max: 100,
            value: percent,
            'aria-label': t('enhancement.indexProgress'),
          }),
        h(
          'small',
          null,
          Number.isFinite(percent) ? `${percent}%` : t('enhancement.indexIndeterminate'),
        ),
      ),
    job.error && h('p', { role: 'alert' }, t('enhancement.error', { code: job.error.code })),
    job.result?.indexUpdated && h('p', null, t('enhancement.indexUpdated')),
    job.result?.indexUpdated &&
      job.result.code?.status !== 'ready' &&
      h('small', null, t('enhancement.indexCheckPending')),
    job.result?.findings?.map((item) =>
      h(
        Disclosure,
        { key: item.id, title: item.reason || t(`enhancement.finding.${item.kind}`) },
        item.question && h('p', null, item.question),
        item.proposal &&
          h(DiffViewer, {
            oldContent: item.evidence?.[0]?.quote || '',
            newContent: item.proposal,
            fileName: item.subject || 'proposal',
            oldLabel: t('enhancement.fragmentOriginal'),
            newLabel: t('enhancement.fragmentProposal'),
          }),
        h('pre', null, JSON.stringify(item.evidence, null, 2)),
      ),
    ),
    job.result?.patterns?.map((item) =>
      h(
        Disclosure,
        { key: item.id, title: t('enhancement.patterns') },
        h('pre', null, item.content),
        h(
          'div',
          { className: css.actions },
          ['confirmed', 'rejected'].map((decision) =>
            h(
              Button,
              {
                key: decision,
                size: 'sm',
                disabled: api.locked || item.status === decision,
                onClick: () =>
                  api.perform(async (signal) =>
                    api.setJob(
                      await api.request(
                        'reviews',
                        { jobId: job.id, expectedSeq: job.seq, resultId: item.id, decision },
                        signal,
                      ),
                    ),
                  ),
              },
              state(decision),
            ),
          ),
        ),
      ),
    ),
    job.indexLogs?.length > 0 &&
      h(
        Disclosure,
        {
          compact: true,
          className: css.indexLogs,
          defaultOpen: active(job),
          title: t('enhancement.indexLogs'),
        },
        h('pre', { className: css.indexLogBody }, job.indexLogs.join('\n')),
      ),
  );
}

function CodeStatus({ api }) {
  useTimeZone();
  const code = api.job?.result?.code || api.data?.graph?.code;
  return h(
    'div',
    { className: css.stack },
    h('p', null, t('enhancement.mcp', { status: indexState(code) })),
    code?.indexedAt &&
      h(
        'small',
        null,
        t('enhancement.indexVersion', {
          date: formatDateTime(code.indexedAt),
          commit: code.lastCommit || '',
        }),
      ),
    h(
      'div',
      { className: css.actions },
      h(
        Button,
        { size: 'sm', disabled: api.locked, onClick: () => api.start('code-refresh') },
        t('enhancement.refreshCode'),
      ),
      h(
        Button,
        { size: 'sm', disabled: api.locked, onClick: () => api.start('code-index') },
        t('enhancement.updateIndex'),
      ),
    ),
  );
}
function TaskHistory({ api }) {
  useTimeZone();
  if (!api.data?.jobs?.length) {
    return null;
  }
  return h(
    Disclosure,
    { title: t('enhancement.history') },
    h(
      'div',
      { className: `${css.stack} ${css.history}` },
      h(
        PagedList,
        { className: css.pagedSection },
        api.data.jobs.map((job) =>
          h(
            Button,
            {
              key: job.id,
              size: 'sm',
              disabled: api.busy,
              onClick: () =>
                api.perform(async (signal) =>
                  api.setJob(await api.request(`jobs/${job.id}`, null, signal)),
                ),
            },
            `${t(`enhancement.kind.${job.kind}`)} · ${state(job.status)} · ${formatDateTime(job.createdAt)}`,
          ),
        ),
      ),
    ),
  );
}

/**
 * Configure the code provider and show only current code-index operations.
 * Completed workspace-wide history remains in the document assistant.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function EnhancementSettings({ workspaceId }) {
  useTimeZone();
  const api = useAssist(workspaceId, undefined, undefined, codeJobKinds);
  const data = api.data;
  const formId = React.useId();
  const [saveNotice, setSaveNotice] = React.useState(null);
  React.useEffect(() => {
    if (!saveNotice) {
      return;
    }
    const timer = setTimeout(() => setSaveNotice(null), 2000);
    return () => clearTimeout(timer);
  }, [saveNotice]);
  const configure = (values) =>
    api.perform(async (signal) => {
      setSaveNotice(null);
      const current = await fetch(`${ROUTE}/config`, { signal });
      if (!current.ok) {
        throw new Error('ENHANCEMENT_FAILED');
      }
      const config = await current.json();
      const result = await fetch(`${ROUTE}/config`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enhancements: { ...config.enhancements, ...values } }),
      });
      if (!result.ok) {
        throw new Error('ENHANCEMENT_FAILED');
      }
      if (signal.aborted) {
        return;
      }
      api.setJob(null);
      setSaveNotice({});
      api.refresh();
    });
  const field = (key, control) => {
    const text = t(`assist.settings.${key}`);
    return h(
      'div',
      { className: formCss.field },
      h(
        'div',
        { className: formCss.fieldTitle },
        h('span', { id: `${formId}-${key}` }, text),
        h(HoverCard, {
          surfaceClassName: formCss.helpBubble,
          anchor: h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: formCss.helpButton,
              'aria-label': t('schedule.help', { title: text }),
            },
            h(IconInfo, { size: 14 }),
          ),
          content: t(`assist.settings.${key}Help`),
        }),
      ),
      control,
    );
  };
  const code = api.job?.result?.code || data?.graph?.code;
  let indexStatus = indexState(code);
  if (active(api.job)) {
    indexStatus = t(
      api.job.kind === 'code-index'
        ? 'assist.settings.updatingIndex'
        : 'assist.settings.checkingIndex',
    );
  }
  return h(
    'section',
    { className: `${formCss.panel} ${settingsCss.panel}`, 'aria-label': t('assist.settings') },
    api.error && h('p', { role: 'alert' }, t('enhancement.error', { code: api.error })),
    !data
      ? h(
          'div',
          null,
          !api.error && h('p', { role: 'status' }, t('common.loading')),
          api.error && h(Button, { onClick: api.refresh }, t('common.retry')),
        )
      : h(
          React.Fragment,
          null,
          h(
            'div',
            { className: settingsCss.layout },
            h(
              'section',
              { className: settingsCss.group, 'aria-labelledby': `${formId}-connection` },
              h(
                'div',
                { className: settingsCss.header },
                h('h3', { id: `${formId}-connection` }, t('assist.settings.connection')),
                h(
                  'span',
                  { className: formCss.saveNotice, role: 'status' },
                  saveNotice ? t('assist.settings.saved') : '',
                ),
              ),
              field(
                'server',
                h(Select, {
                  className: settingsCss.serverSelect,
                  'aria-labelledby': `${formId}-server`,
                  disabled: api.locked,
                  value: data.mcpServer || 'gitnexus',
                  onChange: (event) => configure({ gitnexusServer: event.target.value }),
                  options: [
                    ...new Set([data.mcpServer || 'gitnexus', ...(data.mcpServers || [])]),
                  ].map((server) => ({ id: server, label: server })),
                }),
              ),
              field(
                'registration',
                h(
                  'span',
                  null,
                  t(data.mcpAvailable ? 'assist.settings.registered' : 'assist.settings.absent'),
                ),
              ),
            ),
            h(
              'section',
              { className: settingsCss.group, 'aria-labelledby': `${formId}-code-index` },
              h('h3', { id: `${formId}-code-index` }, t('assist.settings.codeIndex')),
              field(
                'index',
                h('span', { role: active(api.job) ? 'status' : undefined }, indexStatus),
              ),
              code?.indexedAt &&
                h(
                  'p',
                  { className: `${formCss.muted} ${settingsCss.version}` },
                  t('enhancement.indexVersion', {
                    date: formatDateTime(code.indexedAt),
                    commit: code.lastCommit || '',
                  }),
                ),
              h(
                SettingsActionBar,
                null,
                h(
                  Button,
                  { disabled: api.locked, onClick: () => api.start('code-refresh') },
                  t('enhancement.refreshCode'),
                ),
                h(
                  Button,
                  {
                    variant: 'primary',
                    disabled: api.locked,
                    onClick: () => api.start('code-index'),
                  },
                  t('enhancement.updateIndex'),
                ),
              ),
              h('p', { className: formCss.muted }, t('assist.settings.operationsHelp')),
            ),
            api.job &&
              h(
                'section',
                { className: settingsCss.group, 'aria-labelledby': `${formId}-task` },
                h('h3', { id: `${formId}-task` }, t('assist.settings.currentTask')),
                h(GitNexusTaskStatus, {
                  key: api.job.id,
                  job: api.job,
                  busy: api.busy,
                  onCancel: api.cancel,
                }),
              ),
          ),
        ),
  );
}

/** Reveal related documents in small batches while keeping keyboard loading available. */
function RelatedSourceList({ docs = [], workspaceId, onOpenSource }) {
  const [visibleCount, setVisibleCount] = React.useState(RELATED_BATCH_SIZE);
  const documentKey = docs.map((doc) => doc.id).join('|');
  React.useEffect(() => {
    setVisibleCount(RELATED_BATCH_SIZE);
  }, [documentKey]);
  const hasMore = visibleCount < docs.length;
  const loadMore = () => {
    setVisibleCount((count) => Math.min(count + RELATED_BATCH_SIZE, docs.length));
  };
  const handleScroll = (event) => {
    const list = event.currentTarget;
    if (hasMore && list.scrollTop + list.clientHeight >= list.scrollHeight - 24) {
      loadMore();
    }
  };
  return h(
    'div',
    { className: css.relatedSourceList },
    h(
      'div',
      {
        className: css.relatedScroll,
        role: 'list',
        tabIndex: 0,
        'aria-label': t('assist.relatedTitle'),
        onScroll: handleScroll,
      },
      docs.slice(0, visibleCount).map((doc) => {
        const name = doc.title || doc.path;
        const reasons = (doc.reasons || []).filter((reason) => reason !== 'same_requirement');
        return h(
          'article',
          { key: doc.id, className: css.relatedItem, role: 'listitem' },
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              className: css.relatedName,
              disabled: !onOpenSource,
              title: `${name}\n${doc.path}`,
              onClick: () =>
                onOpenSource?.({ relativePath: doc.path, workspaceId, title: doc.title }),
            },
            name,
          ),
          h(
            'div',
            { className: css.relatedMeta },
            (reasons.length > 0 || doc.confirmed) &&
              h(
                'small',
                null,
                [
                  ...reasons.map((reason) => t(`assist.reason.${reason}`)),
                  doc.confirmed ? state('confirmed') : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
              ),
            doc.reasons?.includes('same_requirement') &&
              h('span', { className: css.relatedTag }, t('assist.reason.same_requirement')),
          ),
        );
      }),
    ),
    docs.length > RELATED_BATCH_SIZE &&
      h(
        'div',
        { className: css.relatedProgress },
        h(
          'small',
          { role: 'status', 'aria-live': 'polite' },
          t('assist.relatedProgress', {
            shown: Math.min(visibleCount, docs.length),
            total: docs.length,
          }),
        ),
        hasMore &&
          h(Button, { size: 'sm', variant: 'ghost', onClick: loadMore }, t('assist.loadMore')),
      ),
  );
}

/** Keep document checks visible while their progress and results use a modal. */
function DocumentAssistantView({
  api,
  data,
  workspaceId,
  dirty,
  disabled,
  draft,
  checkedDraft,
  setCheckedDraft,
  onOpenSource,
  references,
}) {
  const [resultOpen, setResultOpen] = React.useState(false);
  const locked = api.locked || disabled || dirty;
  const checkDisabled = locked || !data?.enabled || (!draft?.trim() && !data?.documentRefs?.length);
  const runCheck = (kind, forceDraft = false) => {
    setCheckedDraft(draft);
    setResultOpen(true);
    api.start(kind, { draft: forceDraft ? draft : undefined, references });
  };
  return h(
    'section',
    { className: css.assistantLayout },
    h(
      'div',
      { className: css.assistantContent },
      api.busy && !active(api.job) && h('p', { role: 'status' }, t('ai.preparing')),
      api.error && h('p', { role: 'alert' }, t('enhancement.error', { code: api.error })),
      !data
        ? h('p', null, t('common.loading'))
        : h(
            React.Fragment,
            null,
            !data.enabled && h('p', null, t('assist.disabled')),
            dirty && h('p', null, t('kb.saveFirst')),
            api.job &&
              checkedDraft !== undefined &&
              checkedDraft !== draft &&
              h('p', { role: 'status' }, t('assist.draftChanged')),
            data.limited && h('p', { role: 'status' }, t('assist.limited')),
            data.impactLimited && h('p', { role: 'status' }, t('enhancement.truncated')),
            !data.indexed && h('p', null, t('assist.importFirst')),
            h('p', { className: css.hint }, t('assist.referenceHelp')),
            h('h4', null, t('assist.relatedTitle')),
            data.related?.length
              ? h(RelatedSourceList, {
                  docs: data.related,
                  workspaceId,
                  onOpenSource,
                })
              : h('p', null, t('assist.noRelated')),
          ),
    ),
    h(
      'div',
      {
        className: css.assistantFooter,
        role: 'region',
        'aria-label': t('assist.checkDocument'),
      },
      h('h4', null, t('assist.checkDocument')),
      h(
        'div',
        { className: css.checkActions },
        h(
          Button,
          {
            size: 'sm',
            disabled: checkDisabled,
            onClick: () => runCheck('quality-check'),
          },
          t('ai.structureCheck'),
        ),
        h(
          Button,
          {
            size: 'sm',
            disabled: checkDisabled,
            onClick: () => runCheck('semantic-check'),
          },
          t('ai.semanticCheck'),
        ),
        h(
          Button,
          {
            size: 'sm',
            disabled: locked || !data,
            onClick: () => api.reload(),
          },
          t('common.refresh'),
        ),
        api.job &&
          h(
            Button,
            { size: 'sm', variant: 'ghost', onClick: () => setResultOpen(true) },
            t('assist.viewCheckResult'),
          ),
      ),
    ),
    h(
      Modal,
      {
        open: resultOpen,
        title: t('assist.checkDocument'),
        className: css.checkDialog,
        onClose: () => setResultOpen(false),
      },
      api.error && h('p', { role: 'alert' }, t('enhancement.error', { code: api.error })),
      api.job
        ? h(React.Fragment, null, h(TaskResult, { api }), h(TaskHistory, { api }))
        : !api.error && h('p', { role: 'status' }, t('ai.preparing')),
    ),
  );
}

/**
 * Show scoped document associations and user-requested analysis.
 * Assistant presentation omits graph editing and index administration.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function DocumentAssist({
  workspaceId,
  path,
  documentId,
  requirementPath,
  mode = 'document',
  draft,
  revision,
  dirty,
  onOpenSource,
  references = [],
  onReferencesChange,
  disabled,
  compact = false,
  assistant = false,
}) {
  const context = {
    ...(path ? { path } : {}),
    ...(documentId ? { documentId } : {}),
    ...(requirementPath ? { requirementPath } : {}),
  };
  const api = useAssist(workspaceId, context, revision);
  const data = api.data;
  const locked = api.locked || disabled || dirty;
  const graph = data?.graph;
  const [depth, setDepth] = React.useState(2);
  const [impact, setImpact] = React.useState(null);
  const [sourceId, setSourceId] = React.useState('');
  const [targetId, setTargetId] = React.useState('');
  const [note, setNote] = React.useState('');
  const [checkedDraft, setCheckedDraft] = React.useState(undefined);
  const review = (relation, decision) =>
    api.perform(async (signal) => {
      await api.request(
        'reviews',
        {
          expectedRevision: graph.id,
          expectedReviewSeq: graph.reviewSeq,
          resultId: relation.id,
          basisHash: relation.basisHash,
          decision,
        },
        signal,
      );
      api.refresh();
    });
  const choose = (doc, checked) =>
    onReferencesChange(
      checked
        ? [
            ...references.filter((item) => item.id !== doc.id),
            { id: doc.id, scopeId: doc.scopeId, version: doc.version },
          ]
        : references.filter((item) => item.id !== doc.id),
    );
  let promptKey;
  if (mode === 'sync') {
    promptKey = 'assist.sync';
  } else if (mode === 'writing') {
    promptKey = 'assist.writing';
  } else {
    promptKey = 'assist.document';
  }
  if (assistant) {
    return h(DocumentAssistantView, {
      api,
      data,
      workspaceId,
      dirty,
      disabled,
      draft,
      checkedDraft,
      setCheckedDraft,
      onOpenSource,
      references,
    });
  }
  return h(
    compact || assistant ? 'section' : Disclosure,
    {
      className: compact || assistant ? css.compact : css.assist,
      title:
        compact || assistant
          ? undefined
          : t(promptKey) + (api.locked ? ` · ${state(api.job?.status || 'preparing')}` : ''),
    },
    h(
      'div',
      { className: css.stack },
      api.busy && !active(api.job) && h('p', { role: 'status' }, t('ai.preparing')),
      api.error && h('p', { role: 'alert' }, t('enhancement.error', { code: api.error })),
      !data
        ? h('p', null, t('common.loading'))
        : h(
            React.Fragment,
            null,
            !data.enabled && h('p', null, t('assist.disabled')),
            dirty && h('p', null, t('kb.saveFirst')),
            api.job &&
              checkedDraft !== undefined &&
              checkedDraft !== draft &&
              h('p', { role: 'status' }, t('assist.draftChanged')),
            data.limited && h('p', { role: 'status' }, t('assist.limited')),
            data.impactLimited && h('p', { role: 'status' }, t('enhancement.truncated')),
            ((mode === 'document' && !data.indexed) ||
              (mode === 'sync' && !data.documentRefs?.length)) &&
              h('p', null, t('assist.importFirst')),
            !compact &&
              h(
                'p',
                { className: css.hint },
                t(mode === 'sync' ? 'assist.syncHelp' : 'assist.referenceHelp'),
              ),
            onReferencesChange &&
              h(
                'p',
                { className: css.hint },
                t('assist.selectedReferences', { count: references.length }),
              ),
            assistant && h('h4', null, t('assist.relatedTitle')),
            !compact &&
              data.related?.map((doc) =>
                h(
                  'div',
                  { key: doc.id, className: css.related },
                  onReferencesChange &&
                    h(Checkbox, {
                      disabled:
                        locked ||
                        (references.length >= 30 && !references.some((item) => item.id === doc.id)),
                      checked: references.some((item) => item.id === doc.id),
                      label: doc.title,
                      onChange: (checked) => choose(doc, checked),
                    }),
                  h(
                    Button,
                    {
                      size: 'sm',
                      disabled: !onOpenSource,
                      title: doc.path,
                      onClick: () =>
                        onOpenSource?.({ relativePath: doc.path, workspaceId, title: doc.title }),
                    },
                    doc.path,
                  ),
                  h(
                    'small',
                    null,
                    doc.reasons.map((reason) => t(`assist.reason.${reason}`)).join(' · '),
                    doc.confirmed ? ` · ${state('confirmed')}` : '',
                  ),
                ),
              ),
            !compact && !data.related?.length && h('p', null, t('assist.noRelated')),
            assistant && h('h4', null, t('assist.checkDocument')),
            h(
              'div',
              { className: css.actions },
              (mode !== 'sync'
                ? [
                    ['quality-check', 'rules', 'enhancement.rules'],
                    ['quality-check', 'semantic', 'enhancement.semantic'],
                    ...(mode === 'writing'
                      ? [['pattern-propose', null, 'enhancement.patterns']]
                      : []),
                  ]
                : [['consistency-check', null, 'enhancement.consistency']]
              ).map(([kind, type, label]) =>
                h(
                  Button,
                  {
                    size: 'sm',
                    key: label,
                    disabled:
                      locked || !data.enabled || !(draft?.trim() || data.documentRefs?.length),
                    onClick: () => {
                      setCheckedDraft(draft);
                      api.start(kind, type, draft, references);
                    },
                  },
                  t(label),
                ),
              ),
              h(
                Button,
                { size: 'sm', disabled: locked, onClick: api.refresh },
                t('enhancement.refresh'),
              ),
            ),
            h(TaskResult, { api }),
            !compact && h(TaskHistory, { api }),
            !compact &&
              !assistant &&
              graph?.relations?.length > 0 &&
              h(
                Disclosure,
                { title: t('assist.review') },
                h(
                  'div',
                  { className: css.stack },
                  h(
                    PagedList,
                    { className: css.pagedSection },
                    graph.relations.map((relation) =>
                      h(
                        'div',
                        { key: relation.id, className: css.related },
                        h(
                          'span',
                          null,
                          `${graph.entities.find((item) => item.id === relation.sourceId)?.key} → ${graph.entities.find((item) => item.id === relation.targetId)?.key}`,
                        ),
                        h(
                          'small',
                          null,
                          t(`enhancement.relation.${relation.type}`),
                          ` · ${state(relation.reviewState)}`,
                        ),
                        h(
                          Disclosure,
                          { title: t('enhancement.evidence') },
                          h('pre', null, JSON.stringify(relation.evidence, null, 2)),
                        ),
                        h(
                          'div',
                          { className: css.actions },
                          ['confirmed', 'rejected'].map((decision) =>
                            h(
                              Button,
                              {
                                key: decision,
                                size: 'sm',
                                disabled:
                                  locked || graph.stale || relation.reviewState === decision,
                                onClick: () => review(relation, decision),
                              },
                              state(decision),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            !compact &&
              !assistant &&
              h(
                Disclosure,
                { title: t('assist.advanced') },
                h(
                  'div',
                  { className: css.stack },
                  h(CodeStatus, { api }),
                  h(
                    Button,
                    {
                      size: 'sm',
                      disabled:
                        locked || !data.enabled || !data.documentRefs?.length || data.limited,
                      onClick: () => api.start('graph-build'),
                    },
                    t('assist.refreshRelations'),
                  ),
                  graph &&
                    h(
                      React.Fragment,
                      null,
                      h(
                        'label',
                        { className: css.field },
                        t('enhancement.depth'),
                        h(Input, {
                          type: 'number',
                          min: 1,
                          max: data.limits?.maxDepth || 5,
                          value: depth,
                          onChange: (event) => setDepth(Number(event.target.value)),
                        }),
                      ),
                      h(
                        'div',
                        { className: css.actions },
                        h(
                          PagedList,
                          { className: css.pagedSection },
                          graph.entities
                            .filter((entity) =>
                              entity.documents.some((doc) =>
                                data.documentRefs.some((ref) => ref.id === doc.id),
                              ),
                            )
                            .map((entity) =>
                              h(
                                Button,
                                {
                                  key: entity.id,
                                  size: 'sm',
                                  disabled: locked || graph.stale,
                                  onClick: () =>
                                    api.perform(async (signal) =>
                                      setImpact(
                                        await api.request(
                                          `../graph/impact?entityId=${entity.id}&revision=${graph.id}&reviewSeq=${graph.reviewSeq}&direction=dependents&depth=${depth}`,
                                          null,
                                          signal,
                                        ),
                                      ),
                                    ),
                                },
                                t('enhancement.impact'),
                              ),
                            ),
                        ),
                      ),
                      impact &&
                        h(
                          'div',
                          { className: css.stack },
                          h(
                            PagedList,
                            { className: css.pagedSection },
                            impact.results.map((item) =>
                              h(
                                'div',
                                { key: item.id },
                                h(
                                  'p',
                                  null,
                                  graph.entities.find((entity) => entity.id === item.id)?.key ||
                                    item.id,
                                ),
                                (
                                  graph.entities.find((entity) => entity.id === item.id)
                                    ?.documents || []
                                ).map((doc) =>
                                  h(
                                    Button,
                                    {
                                      key: doc.id,
                                      size: 'sm',
                                      disabled: !onOpenSource,
                                      title: doc.path,
                                      onClick: () =>
                                        onOpenSource?.({ relativePath: doc.path, workspaceId }),
                                    },
                                    doc.path,
                                  ),
                                ),
                              ),
                            ),
                          ),
                          impact.truncated && h('p', null, t('enhancement.truncated')),
                        ),
                      h(
                        'div',
                        { className: css.fields },
                        [
                          [sourceId, setSourceId, 'enhancement.from'],
                          [targetId, setTargetId, 'enhancement.to'],
                        ].map(([value, update, label]) =>
                          h(
                            'label',
                            { key: label, className: css.field },
                            t(label),
                            h(
                              Select,
                              {
                                disabled: locked,
                                value,
                                onChange: (event) => update(event.target.value),
                              },
                              h('option', { value: '' }, t(label)),
                              graph.entities.map((entity) =>
                                h('option', { key: entity.id, value: entity.id }, entity.key),
                              ),
                            ),
                          ),
                        ),
                      ),
                      h(Input, {
                        'aria-label': t('enhancement.note'),
                        placeholder: t('enhancement.note'),
                        value: note,
                        maxLength: 1000,
                        disabled: locked,
                        onChange: (event) => setNote(event.target.value),
                      }),
                      h(
                        'div',
                        { className: css.actions },
                        h(
                          Button,
                          {
                            size: 'sm',
                            disabled:
                              locked ||
                              graph.stale ||
                              !sourceId ||
                              !targetId ||
                              sourceId === targetId ||
                              !note.trim(),
                            onClick: () =>
                              api.perform(async (signal) => {
                                await api.request(
                                  'reviews',
                                  {
                                    expectedRevision: graph.id,
                                    expectedReviewSeq: graph.reviewSeq,
                                    sourceId,
                                    targetId,
                                    note,
                                  },
                                  signal,
                                );
                                setNote('');
                                api.refresh();
                              }),
                          },
                          t('enhancement.addManual'),
                        ),
                      ),
                    ),
                ),
              ),
          ),
    ),
  );
}
module.exports = { DocumentAssist, EnhancementSettings };
