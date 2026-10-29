'use strict';
const React = require('react');
const { diffLines } = require('diff');
const { Button } = require('./Button.js');
const { t } = require('../../locale.js');
const css = require('./DiffReviewPage.module.css').default;
const h = React.createElement;
const ReviewContext = React.createContext(null);

// Keep unchanged text byte-for-byte; a change is one contiguous replacement.
function reviewParts(before, after) {
  const parts = [];
  for (const change of diffLines(before, after)) {
    if (!change.added && !change.removed) { parts.push({ text: change.value }); continue; }
    let part = parts.at(-1);
    if (!part || part.text !== undefined) { part = { before: '', after: '', decision: null }; parts.push(part); }
    part[change.added ? 'after' : 'before'] += change.value;
  }
  return parts;
}
const mergeParts = parts => parts.map(part => part.text ?? (part.decision === 'accept' ? part.after : part.before)).join('');

function DiffReviewPage({ oldContent, newContent, fileName, oldLabel, newLabel, overview, evidence, onComplete, onBack, initialParts, onPartsChange }) {
  const [parts, setParts] = React.useState(() => initialParts || reviewParts(oldContent || '', newContent || ''));
  const [conflict, setConflict] = React.useState(false);
  const back = React.useRef(null);
  React.useEffect(() => { back.current?.focus(); }, []);
  const changes = parts.filter(part => part.text === undefined);
  const pending = changes.filter(part => !part.decision).length;
  const decide = (index, decision) => {
    const next = parts.map((part, i) => part.text !== undefined || index !== null && i !== index ? part : { ...part, decision });
    setParts(next); onPartsChange?.(next);
    if (next.every(part => part.text !== undefined || part.decision)) {
      setConflict(onComplete(mergeParts(next)) === false);
    }
  };
  return h('section', { className: css.page, 'aria-label': t('review.title'), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); onBack(); } } },
    h('header', { className: css.header },
      h('span', { className: css.filename, title: fileName }, fileName || t('review.title')),
      h('span', { role: 'status' }, t('review.count', { count: changes.length, pending })),
      onComplete && h('div', { className: css.bulkActions },
        h(Button, { onClick: () => decide(null, 'accept') }, t('review.acceptAll')),
        h(Button, { onClick: () => decide(null, 'reject') }, t('review.rejectAll'))),
      h(Button, { ref: back, className: css.back, onClick: onBack }, t('common.back'))),
    h('div', { className: css.body },
      conflict && h('p', { role: 'alert' }, t('review.changed')),
      h('section', { className: css.overview }, h('h3', null, t('review.overview')), h('p', null, overview || t(onComplete ? 'review.editHelp' : 'review.readHelp')),
        evidence?.length > 0 && h('details', null, h('summary', null, t('review.sources')), evidence.map((item, index) => h('p', { key: index }, `${item.workspaceTitle || ''} · ${(item.sources || []).map(source => source.relativePath).join(' · ')} · v${item.version}`)))),
      h('div', { className: css.comparison },
        h('div', { className: css.labels }, h('span', null, oldLabel || t('DiffViewer.message003')), h('span', null, newLabel || t('DiffViewer.message004'))),
        parts.map((part, index) => part.text !== undefined
          ? h('div', { className: css.pair, key: index }, h('pre', null, part.text), h('pre', null, part.text))
          : h('section', { key: index, className: css.change, 'aria-label': t('review.change', { index: changes.indexOf(part) + 1 }) },
            h('div', { className: css.actions }, h('span', null, t('review.change', { index: changes.indexOf(part) + 1 })),
              onComplete && h(React.Fragment, null,
                h(Button, { size: 'sm', 'aria-pressed': part.decision === 'accept', onClick: () => decide(index, 'accept') }, t('review.accept')),
                h(Button, { size: 'sm', 'aria-pressed': part.decision === 'reject', onClick: () => decide(index, 'reject') }, t('review.reject'))),
              part.decision && h('span', null, t(part.decision === 'accept' ? 'review.accepted' : 'review.rejected'))),
            h('div', { className: css.pair }, h('pre', { className: css.before }, part.before || t('review.empty')), h('pre', { className: css.after }, part.after || t('review.empty'))))),
        !changes.length && h('p', { role: 'status' }, t('review.identical')))));
}

function DiffReviewProvider({ children }) {
  const origin = React.useRef(null);
  const [review, setReview] = React.useState(null);
  const open = React.useCallback(value => setReview(value), []);
  const close = React.useCallback(owner => setReview(current => current?.owner === owner ? null : current), []);
  const value = React.useMemo(() => ({ open, close }), [open, close]);
  const restore = () => { const target = review?.returnFocus; setReview(null); queueMicrotask(() => { if (target?.isConnected && !target.disabled) target.focus(); else origin.current?.querySelector('button:not(:disabled)')?.focus(); }); };
  return h(ReviewContext.Provider, { value }, h('div', { className: css.host },
    h('div', { ref: origin, className: css.origin, hidden: !!review }, children),
    review && h(DiffReviewPage, { ...review, key: review.owner, onBack: restore, onComplete: review.onComplete ? text => { if (review.onComplete(text) === false) return false; restore(); } : undefined })));
}

// The fallback keeps independently mounted plugin components usable in tests.
function useDiffReview() {
  const provider = React.useContext(ReviewContext), owner = React.useId();
  const [local, setLocal] = React.useState(null);
  React.useEffect(() => () => provider?.close(owner), [provider, owner]);
  const open = value => {
    const config = { ...value, owner, returnFocus: document.activeElement };
    if (provider) provider.open(config); else setLocal(config);
  };
  const close = () => { const target = local?.returnFocus; setLocal(null); queueMicrotask(() => { if (target?.isConnected) target.focus(); }); };
  return { open, page: local && h(DiffReviewPage, { ...local, onBack: close, onComplete: local.onComplete ? text => { if (local.onComplete(text) === false) return false; close(); } : undefined }) };
}
module.exports = { DiffReviewPage, DiffReviewProvider, useDiffReview, reviewParts, mergeParts };
