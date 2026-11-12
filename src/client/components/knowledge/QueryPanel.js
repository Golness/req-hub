'use strict';
const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { Select } = require('../shared/Select.js');
const { EmptyState } = require('../shared/EmptyState.js');
const { Skeleton } = require('../shared/Skeleton.js');
const { MilkdownEditor } = require('../MilkdownEditor.js');
const { knowledgeV2Request, knowledgeV2ErrorText } = require('../../hooks/useKnowledgeV2.js');
const css = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;

/**
 * Ask one question over frozen evidence and browse validated citations.
 * History lives only for this mounted session; answers stay pinned to a generation.
 * @param props - Workspace identity and page/source navigation callbacks.
 * @returns The rendered component content.
 */
function QueryPanel({ workspaceId, onOpenPage, onOpenSource }) {
  const [mode, setMode] = React.useState('wiki');
  const [question, setQuestion] = React.useState('');
  const [asking, setAsking] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [history, setHistory] = React.useState([]);
  const controller = React.useRef(null);
  React.useEffect(() => {
    return () => controller.current?.abort();
  }, []);
  const ask = async () => {
    const text = question.trim();
    if (!text || asking) {
      return;
    }
    controller.current?.abort();
    const request = (controller.current = new AbortController());
    setAsking(true);
    setError(null);
    setResult(null);
    try {
      const data = await knowledgeV2Request(
        '/query',
        workspaceId,
        { question: text, mode },
        request.signal,
      );
      if (!request.signal.aborted) {
        setResult(data);
        setHistory((previous) => [text, ...previous.filter((item) => item !== text)].slice(0, 20));
      }
    } catch (failure) {
      if (!request.signal.aborted) {
        setError(failure);
      }
    } finally {
      if (!request.signal.aborted) {
        setAsking(false);
      }
    }
  };
  const openCitation = (citation) => {
    const [kind, ...rest] = citation.documentId.split(':');
    const id = rest.join(':');
    if (kind === 'wiki') {
      onOpenPage?.(id);
    } else if (kind === 'source') {
      onOpenSource?.(id);
    }
  };
  return h(
    React.Fragment,
    null,
    h(
      'form',
      {
        className: css.queryForm,
        onSubmit: (event) => {
          event.preventDefault();
          ask();
        },
      },
      h('textarea', {
        className: css.editor,
        rows: 3,
        value: question,
        disabled: asking,
        placeholder: t('kb.query.placeholder'),
        'aria-label': t('kb.query.placeholder'),
        onChange: (event) => setQuestion(event.target.value),
      }),
      h(
        'div',
        { className: css.queryControls },
        h(Select, {
          value: mode,
          disabled: asking,
          'aria-label': t('kb.query.mode'),
          options: [
            { id: 'wiki', label: t('kb.query.mode.wiki') },
            { id: 'raw', label: t('kb.query.mode.raw') },
          ],
          onChange: (event) => setMode(event.target.value),
        }),
        h(
          Button,
          { type: 'submit', variant: 'primary', size: 'sm', disabled: asking || !question.trim() },
          asking ? t('kb.query.asking') : t('kb.query.ask'),
        ),
        asking &&
          h(
            Button,
            {
              type: 'button',
              variant: 'outline',
              size: 'sm',
              onClick: () => controller.current?.abort(),
              tone: 'warning',
            },
            t('common.cancel'),
          ),
        result &&
          h(
            Button,
            {
              type: 'button',
              variant: 'ghost',
              size: 'sm',
              onClick: () => {
                setResult(null);
                setError(null);
                setQuestion('');
              },
            },
            t('kb.query.new'),
          ),
      ),
    ),
    history.length > 0 &&
      h(
        'section',
        { className: css.history, 'aria-label': t('kb.query.history') },
        h('h3', { className: css.catalogTitle }, t('kb.query.history')),
        history.map((item) =>
          h(
            'button',
            {
              key: item,
              type: 'button',
              className: css.pageButton,
              title: item,
              onClick: () => setQuestion(item),
            },
            item,
          ),
        ),
      ),
    h(
      'div',
      { className: css.scroll },
      error && h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(error)),
      asking && h(Skeleton, { lines: 4 }),
      !asking &&
        !error &&
        !result &&
        h(EmptyState, { title: t('kb.query.empty'), description: t('kb.query.emptyHint') }),
      result &&
        h(
          'article',
          { className: css.answer },
          h(
            'div',
            { className: css.pageMeta },
            h('h3', null, t('kb.query.answer')),
            result.generationId &&
              h('span', null, t('kb.query.generation', { id: result.generationId.slice(0, 8) })),
          ),
          h(MilkdownEditor, { content: result.answer, readOnly: true }),
          result.citations.length > 0 &&
            h(
              'section',
              { 'aria-label': t('kb.query.citations') },
              h('h3', { className: css.catalogTitle }, t('kb.query.citations')),
              h(
                'ul',
                { className: css.citations },
                result.citations.map((citation, index) =>
                  h(
                    'li',
                    { key: `${citation.documentId}:${citation.startLine}:${index}` },
                    h(
                      Button,
                      {
                        variant: 'ghost',
                        size: 'sm',
                        onClick: () => openCitation(citation),
                      },
                      t('kb.query.citation', {
                        document: citation.documentId,
                        start: citation.startLine,
                        end: citation.endLine,
                      }),
                    ),
                  ),
                ),
              ),
            ),
        ),
    ),
  );
}
module.exports = { QueryPanel };
