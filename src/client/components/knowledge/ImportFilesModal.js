'use strict';
const React = require('react');
const { t, hasLocaleKey } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { Checkbox, Modal } = require('../shared/controls.js');
const {
  knowledgeV2Request,
  knowledgeV2ErrorText,
} = require('../../hooks/useKnowledgeV2.js');
const css = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;

/** Resolve an enum-derived key without letting an unknown status break the list. */
const localized = (key, fallback) => (hasLocaleKey(key) ? t(key) : fallback);

/**
 * Import whitelisted files by docs-root-relative paths, one per line.
 * @param props - Open state, workspace identity and result callbacks.
 * @returns The rendered modal, or nothing while closed.
 */
function ImportFilesModal({ open, workspaceId, docsDir, onClose, onImported, onOpenTasks }) {
  const [paths, setPaths] = React.useState('');
  const [ingest, setIngest] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [result, setResult] = React.useState(null);
  React.useEffect(() => {
    if (open) {
      setPaths('');
      setIngest(true);
      setBusy(false);
      setError(null);
      setResult(null);
    }
  }, [open]);
  const submit = async () => {
    const files = paths
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((relativePath) => ({ relativePath }));
    if (!files.length) {
      setError(new Error(t('kb.import.required')));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await knowledgeV2Request('/sources/files', workspaceId, {
        files,
        requestKey: crypto.randomUUID(),
        ingest,
      });
      setResult(data);
      onImported?.(data);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return null;
  }
  return h(
    Modal,
    { open: true, title: t('kb.import.title'), onClose },
    h('p', { className: css.muted }, t('kb.import.hint', { root: docsDir || 'docs' })),
    h('p', { className: css.muted }, t('kb.import.whitelist')),
    h('textarea', {
      className: css.editor,
      rows: 6,
      value: paths,
      disabled: busy,
      placeholder: t('kb.import.pathsPlaceholder'),
      'aria-label': t('kb.import.paths'),
      onChange: (event) => setPaths(event.target.value),
    }),
    h(Checkbox, {
      checked: ingest,
      disabled: busy,
      onChange: (checked) => setIngest(checked),
      label: t('kb.import.ingest'),
    }),
    error &&
      h(
        'p',
        { role: 'alert', className: css.error },
        error.code ? knowledgeV2ErrorText(error) : error.message,
      ),
    result &&
      h(
        React.Fragment,
        null,
        h(
          'p',
          { role: 'status' },
          t('kb.import.result', {
            saved: result.saved,
            skipped: result.skipped,
            failed: result.failed,
          }) + (result.job ? ` ${t('kb.import.jobQueued')}` : ''),
        ),
        h('h4', { className: css.catalogTitle }, t('kb.import.results')),
        h(
          'ul',
          { className: css.importResults },
          result.results.map((item) =>
            h(
              'li',
              { key: item.relativePath },
              h(
                'span',
                {
                  className: css.badge,
                  'data-tone':
                    item.status === 'saved'
                      ? 'success'
                      : item.status === 'failed'
                        ? 'error'
                        : undefined,
                },
                localized(`kb.import.item.${item.status}`, item.status),
              ),
              h('span', null, item.relativePath),
              item.code && h('span', { className: css.muted }, knowledgeV2ErrorText(item)),
            ),
          ),
        ),
      ),
    h(
      'div',
      { className: 'rh-modal-actions' },
      result?.job &&
        h(
          Button,
          {
            variant: 'outline',
            onClick: () => {
              onClose();
              onOpenTasks?.();
            },
          },
          t('kb.import.viewTasks'),
        ),
      h(Button, { onClick: onClose }, t('common.close')),
      !result &&
        h(
          Button,
          { variant: 'primary', disabled: busy, onClick: submit },
          busy ? t('common.loading') : t('kb.import.submit'),
        ),
    ),
  );
}
module.exports = { ImportFilesModal };