'use strict';
const { TaskResult } = require('./TaskResult.js');
const { TaskHistory } = require('./Status.js');
const { RelatedSourceList } = require('./RelatedSourceList.js');
const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { Checkbox, HoverCard, Modal } = require('../shared/controls.js');
const css = require('../ContextAssist.module.css').default;
const h = React.createElement;
const active = (job) => ['queued', 'preparing', 'running', 'cancelling'].includes(job?.status);
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

module.exports = { DocumentAssistantView };
