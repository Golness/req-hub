'use strict';
const { useAssist } = require('./context-assist/useAssist.js');
const { TaskResult } = require('./context-assist/TaskResult.js');
const { CodeStatus } = require('./context-assist/Status.js');
const { TaskHistory } = require('./context-assist/Status.js');
const { DocumentAssistantView } = require('./context-assist/DocumentAssistantView.js');
const { EnhancementSettings } = require('./context-assist/EnhancementSettings.js');
const { PagedList } = require('./shared/PagedList.js');
const { Disclosure } = require('./shared/Disclosure.js');
const React = require('react');
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const { Checkbox, HoverCard, Modal } = require('./shared/controls.js');
const { Select } = require('./shared/Select.js');
const { Input } = require('./shared/Input.js');
const css = require('./ContextAssist.module.css').default;
const h = React.createElement;
const active = (job) => ['queued', 'preparing', 'running', 'cancelling'].includes(job?.status);
const state = (value) => t(`enhancement.state.${value || 'unavailable'}`);
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
