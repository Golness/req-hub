'use strict';
const { Disclosure } = require('./Disclosure.js');
const React = require('react');
const { diffLines } = require('diff');
const { Button } = require('./Button.js');
const { t } = require('../../locale.js');
const css = require('./DiffReviewPage.module.css').default;
const h = React.createElement;
const ReviewContext = React.createContext(null);

// Keep unchanged text byte-for-byte; a change is one contiguous replacement.
/**
 * Split original and proposed text into reviewable changes.
 * @param before - Original document text.
 * @param after - Proposed document text.
 * @returns Unchanged text and undecided change parts.
 */
function reviewParts(before, after) {
  const parts = [];
  for (const change of diffLines(before, after)) {
    if (!change.added && !change.removed) {
      parts.push({ text: change.value });
      continue;
    }
    let part = parts.at(-1);
    if (!part || part.text !== undefined) {
      part = { before: '', after: '', decision: null };
      parts.push(part);
    }
    part[change.added ? 'after' : 'before'] += change.value;
  }
  return parts;
}
/**
 * Merge only the accepted review decisions.
 * @param parts - Text segments and review decisions.
 * @returns The reviewed document text.
 */
const mergeParts = (parts) =>
  parts
    .map((part) => part.text ?? (part.decision === 'accept' ? part.after : part.before))
    .join('');

/**
 * Review individual changes; identical documents show their result before optional content.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function DiffReviewPage({
  oldContent,
  newContent,
  fileName,
  oldLabel,
  newLabel,
  overview,
  evidence,
  onComplete,
  onBack,
  initialParts,
  onPartsChange,
}) {
  const [parts, setParts] = React.useState(
    () => initialParts || reviewParts(oldContent || '', newContent || ''),
  );
  const [conflict, setConflict] = React.useState(false);
  const [changesOnly, setChangesOnly] = React.useState(false);
  const back = React.useRef(null);
  React.useEffect(() => {
    back.current?.focus();
  }, []);
  const changes = parts.filter((part) => part.text === undefined);
  const pending = changes.filter((part) => !part.decision).length;
  const decide = (index, decision) => {
    const next = parts.map((part, i) =>
      part.text !== undefined || (index !== null && i !== index) ? part : { ...part, decision },
    );
    setParts(next);
    onPartsChange?.(next);
    if (next.every((part) => part.text !== undefined || part.decision)) {
      setConflict(onComplete(mergeParts(next)) === false);
    }
  };
  return h(
    'section',
    {
      className: css.page,
      'aria-label': t('review.title'),
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onBack();
        }
      },
    },
    h(
      'header',
      { className: css.header },
      h(
        'div',
        { className: css.heading },
        h('h2', null, t(onComplete ? 'review.title' : 'review.compareTitle')),
        h('span', { className: css.filename, title: fileName }, fileName),
      ),
      h(
        'span',
        { className: css.count, role: 'status' },
        t(onComplete ? 'review.count' : 'review.readCount', { count: changes.length, pending }),
      ),
      onComplete &&
        changes.length > 0 &&
        h(
          'div',
          { className: css.bulkActions },
          h(Button, { onClick: () => decide(null, 'accept') }, t('review.acceptAll')),
          h(Button, { onClick: () => decide(null, 'reject') }, t('review.rejectAll')),
        ),
      h(Button, { ref: back, className: css.back, onClick: onBack }, t('common.back')),
    ),
    h(
      'div',
      { className: css.body },
      conflict && h('p', { role: 'alert' }, t('review.changed')),
      !changes.length &&
        h(
          'div',
          { className: css.identical, role: 'status' },
          h('strong', null, t('review.identical')),
          h('span', null, t('review.identicalHelp')),
        ),
      h(
        'section',
        { className: css.overview },
        changes.length > 0 &&
          h(
            'div',
            { className: css.overviewHeading },
            h(
              'span',
              { className: css.mode },
              t(onComplete ? 'review.editMode' : 'review.readMode'),
            ),
            h('p', null, t(onComplete ? 'review.editHelp' : 'review.readHelp')),
          ),
        overview && h('p', { className: css.explanation }, overview),
        evidence?.length > 0 &&
          h(
            Disclosure,
            { title: t('review.sources') },
            evidence.map((item, index) =>
              h(
                'p',
                { key: index },
                `${item.workspaceTitle || ''} · ${(item.sources || []).map((source) => source.relativePath).join(' · ')} · v${item.version}`,
              ),
            ),
          ),
      ),
      h(
        'div',
        { className: css.labels },
        h(
          'div',
          null,
          h('span', null, t('review.baseVersion')),
          h('strong', null, oldLabel || t('DiffViewer.message003')),
        ),
        h(
          'div',
          null,
          h('span', null, t('review.targetVersion')),
          h('strong', null, newLabel || t('DiffViewer.message004')),
        ),
      ),
      !changes.length
        ? h(
            Disclosure,
            { title: t('review.showDocument'), lazy: true, className: css.document },
            h('pre', { className: css.fullText }, oldContent || t('review.empty')),
          )
        : h(
            'div',
            { className: css.comparison },
            h(
              'div',
              { className: css.toolbar },
              h('h3', null, t('review.changesTitle')),
              h(
                Button,
                {
                  size: 'sm',
                  variant: 'ghost',
                  'aria-pressed': changesOnly,
                  onClick: () => setChangesOnly((value) => !value),
                },
                t('review.changesOnly'),
              ),
            ),
            parts.map((part, index) =>
              part.text !== undefined
                ? !changesOnly &&
                  h(
                    'div',
                    { className: css.pair, key: index },
                    h('pre', { 'data-label': t('review.baseVersion') }, part.text),
                    h('pre', { 'data-label': t('review.targetVersion') }, part.text),
                  )
                : h(
                    'section',
                    {
                      key: index,
                      className: css.change,
                      'aria-label': t('review.change', { index: changes.indexOf(part) + 1 }),
                    },
                    h(
                      'div',
                      { className: css.actions },
                      h('span', null, t('review.change', { index: changes.indexOf(part) + 1 })),
                      onComplete &&
                        h(
                          React.Fragment,
                          null,
                          h(
                            Button,
                            {
                              size: 'sm',
                              'aria-pressed': part.decision === 'accept',
                              onClick: () => decide(index, 'accept'),
                            },
                            t('review.accept'),
                          ),
                          h(
                            Button,
                            {
                              size: 'sm',
                              'aria-pressed': part.decision === 'reject',
                              onClick: () => decide(index, 'reject'),
                            },
                            t('review.reject'),
                          ),
                        ),
                      part.decision &&
                        h(
                          'span',
                          null,
                          t(part.decision === 'accept' ? 'review.accepted' : 'review.rejected'),
                        ),
                    ),
                    h(
                      'div',
                      { className: css.pair },
                      h(
                        'pre',
                        { className: css.before, 'data-label': t('review.baseVersion') },
                        part.before || t('review.empty'),
                      ),
                      h(
                        'pre',
                        { className: css.after, 'data-label': t('review.targetVersion') },
                        part.after || t('review.empty'),
                      ),
                    ),
                  ),
            ),
          ),
    ),
  );
}

/**
 * Own one active document-review request above its reporting surface.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function DiffReviewProvider({ children }) {
  const origin = React.useRef(null);
  const [review, setReview] = React.useState(null);
  const open = React.useCallback((value) => setReview(value), []);
  const close = React.useCallback(
    (owner) => setReview((current) => (current?.owner === owner ? null : current)),
    [],
  );
  const value = React.useMemo(() => ({ open, close }), [open, close]);
  const restore = () => {
    const target = review?.returnFocus;
    setReview(null);
    queueMicrotask(() => {
      if (target?.isConnected && !target.disabled) {
        target.focus();
      } else {
        origin.current?.querySelector('button:not(:disabled)')?.focus();
      }
    });
  };
  return h(
    ReviewContext.Provider,
    { value },
    h(
      'div',
      { className: css.host },
      h('div', { ref: origin, className: css.origin, hidden: !!review }, children),
      review &&
        h(DiffReviewPage, {
          ...review,
          key: review.owner,
          onBack: restore,
          onComplete: review.onComplete
            ? (text) => {
                if (review.onComplete(text) === false) {
                  return false;
                }
                restore();
              }
            : undefined,
        }),
    ),
  );
}

// The fallback keeps independently mounted plugin components usable in tests.
/**
 * Read the review API; requests may retain an explicit opener across asynchronous preparation.
 * @returns The review API supplied by the provider.
 */
function useDiffReview() {
  const provider = React.useContext(ReviewContext);
  const owner = React.useId();
  const [local, setLocal] = React.useState(null);
  React.useEffect(() => () => provider?.close(owner), [provider, owner]);
  const open = (value) => {
    const config = { ...value, owner, returnFocus: value.returnFocus ?? document.activeElement };
    if (provider) {
      provider.open(config);
    } else {
      setLocal(config);
    }
  };
  const close = () => {
    const target = local?.returnFocus;
    setLocal(null);
    queueMicrotask(() => {
      if (target?.isConnected) {
        target.focus();
      }
    });
  };
  return {
    open,
    page:
      local &&
      h(DiffReviewPage, {
        ...local,
        onBack: close,
        onComplete: local.onComplete
          ? (text) => {
              if (local.onComplete(text) === false) {
                return false;
              }
              close();
            }
          : undefined,
      }),
  };
}
module.exports = { DiffReviewPage, DiffReviewProvider, useDiffReview, reviewParts, mergeParts };
