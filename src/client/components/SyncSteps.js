'use strict';
const React = require('react');
const { Button } = require('./shared/Button.js');
const { Disclosure } = require('./shared/Disclosure.js');
const { t } = require('../locale.js');
const { syncActivityText, syncErrorText } = require('../utils/syncFeedback.js');
const css = require('./SyncSteps.module.css').default;
const h = React.createElement;

function tokens(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value || 0);
}

function statusLabel(status) {
  const keys = {
    completed: 'sync.steps.completed',
    running: 'SyncPanel.message021',
    failed: 'KnowledgePanel.message005',
    aborted: 'SyncPanel.message022',
    skipped: 'sync.steps.skipped',
    cancelling: 'SyncStatusBar.message001',
  };
  return t(keys[status] || 'KnowledgePanel.message010');
}

function budgetText(value) {
  return t('sync.budget.breakdown', {
    evidence: tokens(value.evidenceTokens),
    common: tokens(value.commonTokens),
    prompt: tokens(value.promptTokens),
    reserved: tokens(value.reservedTokens),
  });
}

/**
 * Show one chunk summary and keep evidence metadata available without crowding the step.
 * @param props - The chunk and its display position.
 * @returns A compact chunk with optional evidence details and a visible failure reason.
 */
function SyncChunk({ chunk, index }) {
  const title = h(
    'span',
    { className: css.chunkHeading },
    h('span', null, t('SyncPanel.message020', { value0: index + 1 })),
    h('span', { className: css.status, 'data-status': chunk.status }, statusLabel(chunk.status)),
    h('span', { className: css.metric }, t('sync.budget.label', { tokens: tokens(chunk.tokens) })),
  );
  return h(
    'div',
    { className: css.chunk, 'data-status': chunk.status },
    h(
      Disclosure,
      { title, className: css.chunkDetails },
      chunk.sessionId && h('code', { className: css.session }, chunk.sessionId),
      chunk.inputBudget && h('p', { className: css.hint }, budgetText(chunk.inputBudget)),
      chunk.files?.length > 0 &&
        h(
          'div',
          { className: css.paths },
          chunk.files.slice(0, 5).map((file, i) => h('code', { key: i }, file.file || file)),
          chunk.files.length > 5 &&
            h(
              'span',
              null,
              t('SyncPanel.message024', {
                value0: chunk.files.length - 5,
              }),
            ),
        ),
      chunk.messages?.length > 0 &&
        h(
          'div',
          { className: css.messages },
          chunk.messages
            .slice(0, 3)
            .map((message, i) =>
              h(
                'div',
                { key: i },
                t(message.role === 'user' ? 'SyncPanel.message025' : 'SyncPanel.message026'),
                ` ${message.preview?.substring(0, 30) || ''}…`,
              ),
            ),
          chunk.messages.length > 3 &&
            h(
              'span',
              null,
              t('SyncPanel.message027', {
                value0: chunk.messages.length - 3,
              }),
            ),
        ),
    ),
    chunk.error && h('p', { className: css.error }, syncErrorText(chunk.error)),
  );
}

/**
 * Present active and historical steps; only active or failed steps open automatically.
 * @param props - Steps, generated artifacts and the existing artifact preview callback.
 * @returns Keyboard-accessible steps retaining manual expansion across task updates.
 */
function SyncStepList({ steps = [], generatedFiles = [], onViewFile }) {
  const id = React.useId();
  const [expanded, setExpanded] = React.useState({});
  return h(
    'div',
    { className: css.steps },
    steps.map((step, index) => {
      const open = expanded[step.phase] ?? ['running', 'failed'].includes(step.status);
      const chunks = step.chunks || [];
      const files = generatedFiles.filter((file) => file.phase === step.phase);
      for (const name of step.files || []) {
        if (!files.some((file) => file.fileName === name)) {
          files.push({ fileName: name });
        }
      }
      const budget =
        chunks.length && chunks.every((chunk) => chunk.inputBudget)
          ? chunks.reduce(
              (sum, chunk) =>
                Object.fromEntries(
                  Object.keys(sum).map((key) => [key, sum[key] + chunk.inputBudget[key]]),
                ),
              { evidenceTokens: 0, commonTokens: 0, promptTokens: 0, reservedTokens: 0 },
            )
          : null;
      return h(
        'section',
        {
          key: step.phase,
          className: `rh-sync-step ${css.step}`,
          'data-sync-step': step.phase,
          'data-status': step.status,
        },
        h(
          Button,
          {
            variant: 'ghost',
            className: css.heading,
            'aria-expanded': open,
            'aria-controls': `${id}-${index}`,
            onClick: () => setExpanded((previous) => ({ ...previous, [step.phase]: !open })),
          },
          h(
            'span',
            { className: css.number, 'aria-hidden': true },
            String(index + 1).padStart(2, '0'),
          ),
          h('span', { className: `rh-sync-step-label ${css.label}` }, step.label),
          h(
            'span',
            { className: css.status, 'data-status': step.status },
            statusLabel(step.status),
          ),
          h(
            'span',
            { className: css.toggle, 'aria-hidden': true },
            t(open ? 'disclosure.collapse' : 'disclosure.expand'),
          ),
        ),
        (step.text || step.activity) &&
          h(
            'p',
            { className: css.summary },
            step.status === 'running' && step.activity
              ? syncActivityText(step.activity)
              : syncErrorText(step.text),
          ),
        h(
          'div',
          { id: `${id}-${index}`, hidden: !open, className: css.detail },
          step.livenessStage &&
            step.status === 'running' &&
            h(
              'p',
              { className: css.hint },
              t(
                step.livenessStage === 'liveness_stale'
                  ? 'SyncPanel.message014'
                  : 'SyncPanel.message015',
              ),
              step.lastActivityDesc ? ` · ${step.lastActivityDesc}` : '',
            ),
          (Number.isFinite(step.sourceTokens) || step.totalTokens || budget) &&
            h(
              Disclosure,
              { title: t('sync.steps.budget'), className: css.budget },
              Number.isFinite(step.sourceTokens) &&
                h(
                  'p',
                  { className: css.hint },
                  t('sync.budget.source', { tokens: tokens(step.sourceTokens) }),
                ),
              !!step.totalTokens &&
                h(
                  'p',
                  { className: css.hint },
                  t('sync.budget.label', { tokens: tokens(step.totalTokens) }),
                ),
              budget && h('p', { className: css.hint }, budgetText(budget)),
              h('p', { className: css.hint }, t('sync.budget.notice')),
            ),
          chunks.length > 0 &&
            h(
              'div',
              { className: css.chunks },
              h(
                'div',
                { className: css.subheading },
                t('SyncPanel.message018', { value0: chunks.length, value1: '' }),
              ),
              chunks.map((chunk, i) => h(SyncChunk, { key: chunk.index ?? i, chunk, index: i })),
            ),
          files.length > 0 &&
            h(
              'div',
              { className: css.files },
              h('div', { className: css.subheading }, t('SyncPanel.message017')),
              files.map((file, i) =>
                h(
                  'a',
                  {
                    key: file.artifactId || i,
                    href: '#',
                    onClick: (event) => {
                      event.preventDefault();
                      if (file.artifactId) {
                        onViewFile?.(file);
                      }
                    },
                  },
                  file.fileName,
                ),
              ),
            ),
          step.log &&
            h(
              Disclosure,
              { title: t('SyncPanel.message028'), className: css.log },
              h('pre', null, step.log),
            ),
        ),
      );
    }),
  );
}

module.exports = { SyncStepList };
