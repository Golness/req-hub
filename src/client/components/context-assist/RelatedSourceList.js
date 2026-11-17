'use strict';

const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const css = require('../ContextAssist.module.css').default;
const h = React.createElement;
const RELATED_BATCH_SIZE = 6;
const state = (value) => t(`enhancement.state.${value || 'unavailable'}`);
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

module.exports = { RelatedSourceList };
