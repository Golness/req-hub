'use strict';
const { Disclosure } = require('./shared/Disclosure.js');
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const React = require('react');
const h = React.createElement;
const css = require('./KnowledgePanel.module.css').default;
const { formatSourceLocation } = require('../utils/formatSourceLocation.js');
const { EmptyState } = require('./shared/EmptyState.js');
const { Skeleton } = require('./shared/Skeleton.js');
const { knowledgeRequest } = require('../hooks/useKnowledge.js');
const { ConversationKnowledgeImport } = require('./ConversationKnowledgeImport.js');
const { ConversationProvenance } = require('./ConversationProvenance.js');
const { WikiPanel } = require('./WikiPanel.js');
const { EnhancementSettings } = require('./ContextAssist.js');
const { WikiSettings } = require('./WikiSettings.js');
const { WikiEvents } = require('./WikiEvents.js');
const { WikiUpdateAction } = require('./WikiUpdateAction.js');
const { knowledgeSection } = require('./knowledge-navigation.js');

const LABELS = {
  pending: t('KnowledgePanel.message001'),
  running: t('KnowledgePanel.message002'),
  completed: t('KnowledgePanel.message003'),
  skipped: t('KnowledgePanel.message004'),
  failed: t('KnowledgePanel.message005'),
  stale: t('KnowledgePanel.message006'),
  cancelled: t('KnowledgePanel.message007'),
  interrupted: t('KnowledgePanel.message008'),
  partial: t('KnowledgePanel.message009'),
  queued: t('KnowledgePanel.message010'),
  cancelling: t('KnowledgePanel.message011'),
};

/**
 * Browse scoped knowledge and its source documents.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function KnowledgeContent({
  workspaceId,
  knowledge,
  tab,
  documentView,
  selectedFile,
  viewHidden = false,
  refreshKey = 0,
}) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (tab !== 'files') {
      return;
    }
    const controller = new AbortController();
    setError(null);
    knowledgeRequest('/entries?type=document', workspaceId, null, controller.signal)
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
        }
      });
    return () => controller.abort();
  }, [workspaceId, knowledge.job?.updatedAt, revision, tab]);
  const retry =
    knowledge.job?.files
      .filter((f) => ['failed', 'stale', 'cancelled', 'interrupted'].includes(f.status))
      .map((f) => f.relativePath) || [];
  if (tab === 'events') {
    return h(WikiEvents, { key: workspaceId, workspaceId });
  }
  if (tab === 'code') {
    return h(
      'div',
      { className: css.maintenance },
      h(EnhancementSettings, { workspaceId }),
      h(WikiSettings, { workspaceId }),
    );
  }
  if (['index', 'wiki', 'query', 'review', 'lint', 'rules', 'changes'].includes(tab)) {
    return h(WikiPanel, { key: workspaceId + ':' + tab, workspaceId, tab, refreshKey });
  }
  return h(
    'div',
    { className: 'rh-knowledge-panel' },
    tab === 'files' &&
      h(
        'div',
        { className: 'rh-knowledge-toolbar' },
        h(
          Button,
          {
            className: 'rh-btn rh-btn-ghost rh-btn-sm',
            onClick: () => {
              setRevision((value) => value + 1);
              knowledge.refresh();
            },
            disabled: knowledge.running,
          },
          t('KnowledgePanel.message015'),
        ),
      ),
    tab === 'files' &&
      (knowledge.error || error) &&
      h('div', { className: 'rh-knowledge-error', role: 'alert' }, knowledge.error || error),
    h(
      'div',
      {
        className: css.body,
        id: viewHidden || tab === 'search' ? undefined : 'knowledge-content',
        role: tab === 'search' ? undefined : 'tabpanel',
        'aria-labelledby':
          tab === 'search'
            ? undefined
            : tab === 'documents'
              ? 'knowledge-tab-documents'
              : 'knowledge-tab-files',
      },
      h(
        'div',
        { className: css.documentPane, hidden: tab !== 'documents' },
        selectedFile
          ? documentView
          : h(EmptyState, {
              title: t('KnowledgePanel.message016'),
              description: t('KnowledgePanel.message017'),
            }),
      ),
      tab === 'sessions'
        ? h(ConversationKnowledgeImport, {
            key: workspaceId,
            initialTarget: workspaceId,
            embedded: true,
            onImported: () => {
              setRevision((value) => value + 1);
              knowledge.refresh();
            },
          })
        : tab === 'files' &&
            h(
              'div',
              { className: 'rh-knowledge-results' },
              h(
                'div',
                { className: 'rh-search-count' },
                knowledge.status
                  ? t('knowledgeLayout.documentCount', {
                      count:
                        knowledge.status.documentCount ??
                        data?.entries?.filter((entry) => !entry.conversation).length ??
                        0,
                    })
                  : t('KnowledgePanel.message019'),
              ),
              knowledge.selected.length > 0 &&
                h(
                  Disclosure,
                  { title: t('KnowledgePanel.message020', { value0: knowledge.selected.length }) },
                  h(
                    'ul',
                    null,
                    knowledge.selected.map((path) => h('li', { key: path, title: path }, path)),
                  ),
                ),
              knowledge.job &&
                h(
                  'section',
                  { 'aria-label': t('KnowledgePanel.message021') },
                  h(
                    'div',
                    { className: 'rh-knowledge-toolbar' },
                    h(
                      'strong',
                      null,
                      t('KnowledgePanel.message022', {
                        value0: LABELS[knowledge.job.status] || knowledge.job.status,
                      }),
                    ),
                    knowledge.running &&
                      h(
                        Button,
                        {
                          className: 'rh-btn rh-btn-ghost rh-btn-sm',
                          onClick: knowledge.cancel,
                          disabled: knowledge.job.status === 'cancelling',
                        },
                        t('KnowledgePanel.message023'),
                      ),
                    retry.length > 0 &&
                      !knowledge.running &&
                      h(
                        Button,
                        {
                          className: 'rh-btn rh-btn-ghost rh-btn-sm',
                          onClick: () => knowledge.start(retry),
                        },
                        t('KnowledgePanel.message024', { value0: retry.length }),
                      ),
                  ),
                  h(
                    'p',
                    null,
                    Object.entries(knowledge.job.counts || {})
                      .map(([key, value]) => `${LABELS[key] || key} ${value}`)
                      .join(' · '),
                  ),
                  knowledge.job.error && h('p', { role: 'alert' }, knowledge.job.error),
                  knowledge.job.files.map((file) =>
                    h(
                      'div',
                      { className: 'rh-knowledge-file-status', key: file.relativePath },
                      h('span', { title: file.relativePath }, file.relativePath),
                      h('span', null, LABELS[file.status] || file.status),
                      file.characterCount !== undefined &&
                        h(
                          'span',
                          null,
                          t('KnowledgePanel.message025', { value0: file.characterCount }),
                        ),
                      (file.error || file.reason) && h('small', null, file.error || file.reason),
                      file.warnings?.length > 0 && h('small', null, file.warnings.join('；')),
                    ),
                  ),
                ),
              !data && !error && h(Skeleton, { lines: 3 }),
              data?.entries?.some((entry) => !entry.conversation)
                ? h(
                    'section',
                    { 'aria-label': t('KnowledgePanel.message026') },
                    h('h3', null, t('KnowledgePanel.message027')),
                    data.entries
                      .filter((entry) => !entry.conversation)
                      .map((entry) =>
                        h(
                          Disclosure,
                          {
                            className: 'rh-result-card',
                            key: entry.id,
                            title: h('span', null, entry.title, ` · v${entry.version}`),
                          },
                          h(ConversationProvenance, { conversation: entry.conversation }),
                          h('div', { className: 'rh-knowledge-text' }, entry.body),
                          entry.sources.map((source, i) =>
                            h(
                              'p',
                              { key: i },
                              `${source.conversation?.title || source.relativePath} · ${formatSourceLocation(source)}`,
                            ),
                          ),
                        ),
                      ),
                  )
                : data &&
                    !knowledge.job &&
                    h(EmptyState, {
                      title: t('KnowledgePanel.message028'),
                      description: t('KnowledgePanel.message029'),
                    }),
            ),
    ),
  );
}
/**
 * Group browsing, source ingestion, review and maintenance without losing leaf routes.
 * @param props - Workspace state and the leaf navigation callback.
 * @returns The knowledge workspace with contextual secondary navigation.
 */
function KnowledgePanel(props) {
  const [asking, setAsking] = React.useState(false);
  const [wikiRevision, refreshWiki] = React.useReducer((value) => value + 1, 0);
  const sourceMounted = React.useRef(false);
  const section = knowledgeSection(props.tab);
  if (section === 'sources') {
    sourceMounted.current = true;
  }
  return h(
    'div',
    { className: css.workspace },
    section === 'wiki' &&
      h(
        WikiUpdateAction,
        {
          key: props.workspaceId,
          workspaceId: props.workspaceId,
          onUpdated: refreshWiki,
          onOpenEvents: () => props.onTabChange('events'),
        },
        h(
          Button,
          {
            size: 'sm',
            'aria-expanded': asking,
            onClick: () => setAsking(!asking),
          },
          t(asking ? 'knowledge.closeAsk' : 'knowledge.ask'),
        ),
      ),
    h(
      'div',
      { className: css.columns },
      h(
        'div',
        { className: `${css.primary}${section === 'sources' ? ` ${css.sourcePrimary}` : ''}` },
        sourceMounted.current &&
          h(
            'div',
            { className: css.sourceView, hidden: section !== 'sources' },
            h(KnowledgeContent, {
              ...props,
              tab: section === 'sources' ? props.tab : 'documents',
              viewHidden: section !== 'sources',
              refreshKey: wikiRevision,
            }),
          ),
        section !== 'sources' && h(KnowledgeContent, { ...props, refreshKey: wikiRevision }),
      ),
      asking &&
        section === 'wiki' &&
        h(
          'aside',
          { className: css.questions, 'aria-label': t('knowledge.ask') },
          h(WikiPanel, {
            key: props.workspaceId + ':questions',
            workspaceId: props.workspaceId,
            tab: 'query',
            embedded: true,
          }),
        ),
    ),
  );
}
module.exports = { KnowledgePanel };
