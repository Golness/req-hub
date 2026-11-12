'use strict';
const React = require('react');
const { Button } = require('./shared/Button.js');
const { Disclosure } = require('./shared/Disclosure.js');
const { ScrollList } = require('./shared/ScrollList.js');
const { RetrySyncTaskButton } = require('./shared/RetrySyncTaskButton.js');
const { SyncChunkDetails } = require('./SyncChunkDetails.js');
const { t, hasLocaleKey } = require('../locale.js');
const { syncActivityText, syncErrorText, syncPhaseLabel } = require('../utils/syncFeedback.js');
const css = require('./SyncSteps.module.css').default;
const h = React.createElement;

function statusLabel(status) {
  const keys = {
    completed: 'sync.steps.completed',
    running: 'SyncPanel.message021',
    failed: 'sync.steps.failed',
    aborted: 'SyncPanel.message022',
    skipped: 'sync.steps.skipped',
    cancelling: 'SyncStatusBar.message001',
  };
  return t(keys[status] || 'sync.steps.queued');
}

function stepSummary(step) {
  if (step.status === 'running' && step.activity) {
    return syncActivityText(step.activity);
  }
  const key = `sync.step.${step.phase}.${step.status}`;
  if (hasLocaleKey(key)) {
    return t(key);
  }
  const fallback = `sync.step.${step.status}`;
  return hasLocaleKey(fallback) ? t(fallback) : t('sync.step.pending');
}

function hasChunkDetails(chunk) {
  return !!(
    chunk.files?.length ||
    chunk.turns?.length ||
    chunk.messages?.length ||
    chunk.sessionId ||
    chunk.inputBudget ||
    Number.isFinite(chunk.tokens)
  );
}

function chunkSources(chunk) {
  if (chunk.files?.length) {
    return t('sync.details.files', { count: chunk.files.length });
  }
  const count = chunk.turns?.length || chunk.messages?.length;
  return count ? t('sync.details.turns', { count }) : '';
}

function artifactLabel(name) {
  const keys = {
    'code-diffs.md': 'sync.artifact.code',
    'discussion-diffs.md': 'sync.artifact.discussion',
    'document.patch': 'sync.artifact.patch',
    'applied-document.diff': 'sync.artifact.diff',
  };
  return keys[name] ? t(keys[name]) : name;
}

function codeScopeText(task, step) {
  const parts = [];
  const commits = task.selectedCommitHashes || task.commitHashes || [];
  if (commits.length) {
    parts.push(t('sync.scope.commits', { count: commits.length }));
  }
  if (step.hasUncommitted || task.hasUncommitted) {
    parts.push(t('sync.scope.working'));
  }
  return parts.join('、') || t('sync.scope.selected');
}

/**
 * Keep progress readable and open complete evidence metadata only on request.
 * @param props - The chunk, its stable display index and scoped retry callback.
 * @returns A compact task row with an optional detail dialog.
 */
function SyncChunk({ chunk, index, task, phase, onRetry }) {
  const [open, setOpen] = React.useState(false);
  const title = t('sync.details.task', { number: index + 1 });
  const details = hasChunkDetails(chunk);
  return h(
    'article',
    { className: css.chunk, 'data-status': chunk.status },
    h(
      'div',
      { className: css.chunkHeading },
      h('span', { className: css.fileName }, title),
      h('span', { className: css.status, 'data-status': chunk.status }, statusLabel(chunk.status)),
      h('span', { className: css.hint }, chunkSources(chunk)),
      details &&
        h(
          Button,
          {
            size: 'sm',
            variant: 'ghost',
            className: css.detailsAction,
            'aria-haspopup': 'dialog',
            onClick: () => setOpen(true),
          },
          t('sync.details.open'),
        ),
    ),
    chunk.error && h('p', { className: css.error, role: 'alert' }, syncErrorText(chunk.error)),
    chunk.reused && h('p', { className: css.hint }, t('sync.retry.reused')),
    ['failed', 'aborted'].includes(chunk.status) &&
      task &&
      h(RetrySyncTaskButton, {
        task,
        phase,
        chunkIndex: chunk.index ?? index,
        onTask: onRetry,
      }),
    open && details && h(SyncChunkDetails, { chunk, title, onClose: () => setOpen(false) }),
  );
}

/**
 * Present user-facing progress and expand only sections with additional information.
 * @param props - Steps, scoped task data and authorized artifact/retry callbacks.
 * @returns Accessible steps that preserve explicit expansion choices during updates.
 */
function SyncStepList({ steps = [], generatedFiles = [], onViewFile, task, onRetry }) {
  const id = React.useId();
  const [expanded, setExpanded] = React.useState({});
  React.useEffect(() => setExpanded({}), [task?.id]);
  return h(
    'div',
    { className: css.steps },
    steps.map((step, index) => {
      const chunks = step.chunks || [];
      const files = generatedFiles.filter((file) => file.phase === step.phase);
      for (const name of step.files || []) {
        if (!files.some((file) => file.fileName === name)) {
          files.push({ fileName: name });
        }
      }
      const visibleFiles = files.filter(
        (file) => step.phase !== 'init' && !/\.json$|\.prev$/.test(file.fileName),
      );
      const internalFiles = files.filter((file) => !visibleFiles.includes(file));
      const technical = !!(
        Number.isFinite(step.sourceTokens) ||
        step.totalTokens ||
        step.inputBudget?.model ||
        step.inputBudget?.limit ||
        internalFiles.length
      );
      const failure = step.error || (step.status === 'failed' ? step.text : '');
      const hasDetails = !!(chunks.length || files.length || step.log || technical);
      const open =
        hasDetails && (expanded[step.phase] ?? ['running', 'failed'].includes(step.status));
      const heading = [
        h(
          'span',
          { key: 'number', className: css.number, 'aria-hidden': true },
          String(index + 1).padStart(2, '0'),
        ),
        h(
          'span',
          { key: 'label', className: `rh-sync-step-label ${css.label}` },
          syncPhaseLabel(step),
        ),
        h(
          'span',
          { key: 'status', className: css.status, 'data-status': step.status },
          statusLabel(step.status),
        ),
      ];
      if (hasDetails) {
        heading.push(
          h(
            'span',
            { key: 'toggle', className: css.toggle, 'aria-hidden': true },
            t(open ? 'disclosure.collapse' : 'disclosure.expand'),
          ),
        );
      }
      return h(
        'section',
        {
          key: step.phase,
          className: `rh-sync-step ${css.step}`,
          'data-sync-step': step.phase,
          'data-status': step.status,
        },
        h(
          'div',
          { className: css.header },
          hasDetails
            ? h(
                Button,
                {
                  variant: 'ghost',
                  className: css.heading,
                  'aria-expanded': open,
                  'aria-controls': `${id}-${index}`,
                  onClick: () => setExpanded((previous) => ({ ...previous, [step.phase]: !open })),
                },
                heading,
              )
            : h('div', { className: css.heading }, heading),
          ['failed', 'aborted'].includes(step.status) &&
            task &&
            h(RetrySyncTaskButton, {
              task,
              phase: step.phase,
              onTask: onRetry,
              className: css.retry,
            }),
        ),
        h('p', { className: css.summary }, stepSummary(step)),
        step.phase === 'init' &&
          task &&
          h(
            'dl',
            { className: `${css.facts} ${css.scope}` },
            h('dt', null, t('sync.scope.code')),
            h('dd', null, codeScopeText(task, step)),
            h('dt', null, t('sync.scope.sessions')),
            h(
              'dd',
              null,
              task.sessionIds?.length
                ? t('sync.scope.sessionCount', { count: task.sessionIds.length })
                : t('sync.scope.noSessions'),
            ),
          ),
        failure &&
          h(
            'p',
            { className: `${css.summary} ${css.error}`, role: 'alert' },
            syncErrorText(failure),
          ),
        step.reused && h('p', { className: css.summary }, t('sync.retry.reused')),
        hasDetails &&
          h(
            'div',
            { id: `${id}-${index}`, hidden: !open, className: css.detail },
            chunks.length > 0 &&
              h(
                ScrollList,
                { label: t('sync.details.tasks') },
                chunks.map((chunk, i) =>
                  h(SyncChunk, {
                    key: chunk.index ?? i,
                    chunk,
                    index: i,
                    task,
                    phase: step.phase,
                    onRetry,
                  }),
                ),
              ),
            visibleFiles.length > 0 &&
              h(
                'section',
                { className: css.files },
                h('h3', { className: css.subheading }, t('sync.details.artifacts')),
                h(
                  ScrollList,
                  { label: t('sync.details.artifacts') },
                  visibleFiles.map((file, i) =>
                    file.artifactId && onViewFile
                      ? h(
                          Button,
                          {
                            key: file.artifactId,
                            variant: 'ghost',
                            tone: 'business',
                            size: 'sm',
                            className: css.artifact,
                            onClick: () => onViewFile(file),
                          },
                          artifactLabel(file.fileName),
                        )
                      : h('span', { key: i, className: css.path }, file.fileName),
                  ),
                ),
              ),
            technical &&
              h(
                Disclosure,
                { title: t('sync.details.technical') },
                h(
                  'dl',
                  { className: css.facts },
                  Number.isFinite(step.sourceTokens) &&
                    h(
                      React.Fragment,
                      null,
                      h('dt', null, t('sync.details.sourceTokens')),
                      h('dd', null, step.sourceTokens.toLocaleString()),
                    ),
                  !!step.totalTokens &&
                    h(
                      React.Fragment,
                      null,
                      h('dt', null, t('sync.details.tokens')),
                      h('dd', null, step.totalTokens.toLocaleString()),
                    ),
                  step.inputBudget?.model &&
                    h(
                      React.Fragment,
                      null,
                      h('dt', null, t('sync.details.model')),
                      h('dd', null, step.inputBudget.model),
                    ),
                  step.inputBudget?.limit &&
                    h(
                      React.Fragment,
                      null,
                      h('dt', null, t('sync.details.limit')),
                      h('dd', null, step.inputBudget.limit.toLocaleString()),
                    ),
                ),
                internalFiles.length > 0 &&
                  h(
                    'section',
                    { className: css.files },
                    h('h3', { className: css.subheading }, t('sync.details.internalFiles')),
                    h(
                      ScrollList,
                      { label: t('sync.details.internalFiles') },
                      internalFiles.map((file, i) =>
                        file.artifactId && onViewFile
                          ? h(
                              Button,
                              {
                                key: file.artifactId,
                                variant: 'ghost',
                                size: 'sm',
                                className: css.artifact,
                                onClick: () => onViewFile(file),
                              },
                              file.fileName,
                            )
                          : h('span', { key: i, className: css.path }, file.fileName),
                      ),
                    ),
                  ),
                step.text && h('p', { className: css.hint }, step.text),
                h('p', { className: css.hint }, t('sync.budget.notice')),
              ),
            step.log &&
              h(
                Disclosure,
                { title: t('SyncPanel.message028') },
                h('pre', { className: css.log }, step.log),
              ),
          ),
      );
    }),
  );
}
module.exports = { SyncStepList };
