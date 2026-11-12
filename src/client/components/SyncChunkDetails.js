'use strict';
const React = require('react');
const { Modal } = require('./shared/controls.js');
const { Disclosure } = require('./shared/Disclosure.js');
const { ScrollList } = require('./shared/ScrollList.js');
const { t } = require('../locale.js');
const css = require('./SyncSteps.module.css').default;
const h = React.createElement;

/**
 * Show complete supplied evidence metadata; task internals remain in technical details.
 * @param props - The current chunk, a localized title and modal dismissal callback.
 * @returns A viewport-constrained dialog with scrollable file and conversation sections.
 */
function SyncChunkDetails({ chunk, title, onClose }) {
  const turns = chunk.turns || chunk.messages || [];
  const files = chunk.files || [];
  return h(
    Modal,
    { open: true, title, onClose, className: css.chunkDialog },
    h(
      'div',
      { className: css.evidenceSections },
      files.length > 0 &&
        h(
          'section',
          { className: css.evidenceSection },
          h('h3', null, t('sync.details.files', { count: files.length })),
          h(
            ScrollList,
            { label: t('sync.details.fileList') },
            files.map((entry, index) => {
              const path = entry.file || entry;
              const name = String(path).split(/[\\/]/).at(-1);
              return h(
                'div',
                { key: index, className: css.evidenceItem },
                h('span', { className: css.fileName }, name),
                h('code', { className: css.path }, path),
              );
            }),
          ),
        ),
      turns.length > 0 &&
        h(
          'section',
          { className: css.evidenceSection },
          h('h3', null, t('sync.details.turns', { count: turns.length })),
          h(
            ScrollList,
            { label: t('sync.details.turnList') },
            turns.map((turn, index) =>
              h(
                'div',
                { key: index, className: css.evidenceItem },
                h(
                  'span',
                  { className: css.fileName },
                  t('sync.details.turn', {
                    number: turn.turnNumber ?? index + 1,
                  }),
                ),
                h('p', { className: css.excerpt }, turn.userInputPreview || turn.preview || ''),
              ),
            ),
          ),
        ),
      (chunk.sessionId || chunk.inputBudget || Number.isFinite(chunk.tokens)) &&
        h(
          Disclosure,
          { title: t('sync.details.technical') },
          h(
            'dl',
            { className: css.facts },
            chunk.sessionId &&
              h(
                React.Fragment,
                null,
                h('dt', null, t('sync.details.session')),
                h('dd', null, h('code', null, chunk.sessionId)),
              ),
            Number.isFinite(chunk.tokens) &&
              h(
                React.Fragment,
                null,
                h('dt', null, t('sync.details.tokens')),
                h('dd', null, chunk.tokens.toLocaleString()),
              ),
            chunk.inputBudget &&
              ['evidenceTokens', 'commonTokens', 'promptTokens', 'reservedTokens'].map((key) =>
                h(
                  React.Fragment,
                  { key },
                  h('dt', null, t(`sync.details.${key}`)),
                  h('dd', null, (chunk.inputBudget[key] || 0).toLocaleString()),
                ),
              ),
          ),
          h('p', { className: css.hint }, t('sync.budget.notice')),
        ),
    ),
  );
}
module.exports = { SyncChunkDetails };
