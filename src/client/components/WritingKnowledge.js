'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { Button } = require('./shared/Button.js');
const { Checkbox, Modal } = require('./shared/controls.js');
const { DocumentAssist } = require('./ContextAssist.js');
const { Disclosure } = require('./shared/Disclosure.js');
const css = require('./WritingKnowledge.module.css').default;
const h = React.createElement;
const ERROR_KEYS = {
  WRITING_KNOWLEDGE_BUDGET: 'writing.wikiBudget',
  WRITING_SCOPE_DENIED: 'writing.scopeDenied',
};

/**
 * Show scoped Wiki knowledge beside a draft. Selection never expands automatically.
 * @param props - Scope choices, draft context and actual task citations.
 * @returns The collapsible assistant and its focus-managed drawer.
 */
function WritingKnowledge({
  workspaceId,
  requirementPath,
  scopes,
  selected,
  onSelect,
  draft,
  evidence,
  overview,
  locked,
  open,
  onClose,
}) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [revision, setRevision] = React.useState(0);
  const [detail, setDetail] = React.useState(null);
  const [adjusting, setAdjusting] = React.useState(false);
  const owner = React.useRef(null);
  const selectedKey = JSON.stringify(selected);
  const context = draft.slice(0, 800);
  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    setDetail(null);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `${ROUTE}/writing/knowledge?` +
            new URLSearchParams({
              workspaceId,
              scopeIds: selectedKey,
              q: context,
            }),
          { signal: controller.signal },
        );
        const value = await response.json();
        if (!response.ok) {
          throw new Error(value.error || 'WRITING_KNOWLEDGE_FAILED');
        }
        if (!controller.signal.aborted) {
          setData(value);
          setError(null);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure.message);
        }
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, selectedKey, context, revision]);
  const inspect = async (page, snapshotId) => {
    const scope = scopes.find((item) => item.id === page.scopeId);
    if (!scope) {
      return;
    }
    const signal = owner.current?.signal;
    try {
      const path = snapshotId ? '/evidence/' + snapshotId : '/pages/' + page.pageId;
      const response = await fetch(
        `${ROUTE}/knowledge/wiki${path}?workspaceId=${encodeURIComponent(scope.workspaceId)}`,
        { signal },
      );
      const value = await response.json();
      if (!response.ok) {
        throw new Error(value.error || 'WIKI_FAILED');
      }
      if (!signal?.aborted) {
        setDetail({ ...value, scopeId: page.scopeId });
      }
    } catch (failure) {
      if (!signal?.aborted) {
        setError(failure.message);
      }
    }
  };
  const body = h(
    'div',
    { className: css.body },
    h(
      'div',
      { className: css.heading },
      h('h3', null, t('writing.wikiAssistant')),
      h(Button, { size: 'sm', onClick: onClose }, t('writing.hideAssistant')),
    ),
    h(
      'section',
      null,
      h('h4', null, t('writing.knowledgeScope')),
      h(
        'p',
        null,
        selected
          .map((id) => scopes.find((scope) => scope.id === id)?.title || t('writing.missingScope'))
          .join('、') || t('writing.noKnowledge'),
      ),
      h(
        Button,
        {
          size: 'sm',
          disabled: locked,
          'aria-expanded': adjusting,
          onClick: () => setAdjusting(!adjusting),
        },
        t('writing.adjustScope'),
      ),
      adjusting &&
        h(
          'div',
          { className: css.scopes },
          scopes.map((scope) =>
            h(Checkbox, {
              key: scope.id,
              checked: selected.includes(scope.id),
              label: scope.title,
              disabled: locked,
              onChange: (checked) =>
                onSelect(
                  checked ? [...selected, scope.id] : selected.filter((id) => id !== scope.id),
                ),
            }),
          ),
        ),
      selected.some((id) => !scopes.some((scope) => scope.id === id)) &&
        h(
          Button,
          {
            size: 'sm',
            disabled: locked,
            onClick: () =>
              onSelect(selected.filter((id) => scopes.some((scope) => scope.id === id))),
          },
          t('writing.removeMissingScopes'),
        ),
    ),
    error && h('p', { role: 'alert' }, t(ERROR_KEYS[error] || 'wiki.error', { code: error })),
    h(
      'section',
      null,
      h(
        'div',
        { className: css.heading },
        h('h4', null, t('writing.relatedWiki')),
        h(
          Button,
          { size: 'sm', onClick: () => setRevision((value) => value + 1) },
          t('wiki.refresh'),
        ),
      ),
      !data && !error && h('p', { role: 'status' }, t('common.loading')),
      data &&
        !data.items?.length &&
        h(
          'p',
          { className: css.hint },
          t(data.hasWiki ? 'writing.noRelatedWiki' : 'writing.noWikiYet'),
        ),
      data?.items?.map((page) =>
        h(
          'article',
          { className: css.item, key: page.id },
          h(Button, { onClick: () => inspect(page) }, page.title),
          h('small', null, `v${page.version}`),
          h('p', null, page.summary),
        ),
      ),
      data?.hasMore && h('p', { className: css.hint }, t('writing.moreInWiki')),
    ),
    h(
      'section',
      null,
      h('h4', null, t('writing.usedKnowledge', { count: evidence.length })),
      !evidence.length && h('p', { className: css.hint }, t('writing.noCitationsYet')),
      evidence.map((item) =>
        h(
          Disclosure,
          { key: item.id, title: `${item.title || item.id} · v${item.version}` },
          h('p', null, item.sources?.map((source) => source.relativePath).join('、')),
          item.evidence?.map((ref, index) =>
            h(
              Button,
              { key: index, size: 'sm', onClick: () => inspect(item, ref.snapshotId) },
              `${ref.title || ref.documentId} · v${ref.version} · ${ref.startLine}–${ref.endLine}`,
            ),
          ),
        ),
      ),
    ),
    h(
      Disclosure,
      { title: t('writing.checkDraft'), lazy: true },
      h(DocumentAssist, {
        workspaceId,
        requirementPath,
        mode: 'writing',
        draft,
        disabled: locked,
        compact: true,
      }),
    ),
    overview &&
      h('section', null, h('h4', null, t('writing.pendingKnowledge')), h('p', null, overview)),
    detail &&
      h(
        'section',
        null,
        h(
          'div',
          { className: css.heading },
          h('h4', null, detail.title),
          h(Button, { size: 'sm', onClick: () => setDetail(null) }, t('wiki.close')),
        ),
        h('pre', { className: css.text }, detail.body),
      ),
  );
  if (open) {
    return h(
      Modal,
      { open, title: t('writing.wikiAssistant'), onClose, className: css.drawer },
      body,
    );
  }
  return h('aside', { className: css.aside, 'aria-label': t('writing.wikiAssistant') }, body);
}
module.exports = { WritingKnowledge };
