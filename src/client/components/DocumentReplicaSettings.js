'use strict';
const { ActionBar } = require('./shared/ActionBar.js');
const React = require('react');
const clientApi = require('../api/index.js');
const { t, hasLocaleKey } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const { SettingsActionBar } = require('./shared/SettingsActionBar.js');
const { Checkbox, Modal } = require('./shared/controls.js');
const css = require('./shared/SettingsForm.module.css').default;
const h = React.createElement;

/**
 * Review the explicit docs-to-Lark consent and workspace-local replica status.
 * @param props - Current workspace and connection form lock.
 * @returns A section with preserved drafts, paged records and failed-target retries.
 */
function DocumentReplicaSettings({ workspaceId, disabled = false }) {
  const [recordsOpen, setRecordsOpen] = React.useState(false);
  const [config, setConfig] = React.useState(null);
  const [enabled, setEnabled] = React.useState(false);
  const [data, setData] = React.useState(null);
  const [offset, setOffset] = React.useState(0);
  const [revision, setRevision] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const owner = React.useRef(null);
  const lock = React.useRef(false);
  const id = React.useId();
  const text = (key) => t(`documents.${key}`);
  const request = async (url, options = {}) => {
    const response = await clientApi.request(url, options);
    const value = await response.json();
    if (!response.ok || value.error) {
      throw new Error(value.error || 'DOCUMENT_REQUEST_FAILED');
    }
    return value;
  };

  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    setData(null);
    setError(null);
    setOffset(0);
    setNotice(null);
    setBusy(false);
    Promise.all([
      request(clientApi.endpoint('config'), { signal: controller.signal, cache: 'no-store' }),
      workspaceId
        ? request(clientApi.endpoint('documents', { workspaceId }, 'status'), {
            signal: controller.signal,
            cache: 'no-store',
          })
        : Promise.resolve(null),
    ])
      .then(([saved, result]) => {
        if (!controller.signal.aborted) {
          setConfig(saved);
          setEnabled(saved.documents?.larkSyncEnabled === true);
          setData(result);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      });
    return () => controller.abort();
  }, [workspaceId, revision]);

  const perform = async (action, path, page = offset) => {
    if (lock.current || disabled || !owner.current || owner.current.signal.aborted) {
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const signal = owner.current.signal;
    try {
      if (action === 'save') {
        const saved = await request(clientApi.endpoint('config'), {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            _revision: config._revision,
            documents: { larkSyncEnabled: enabled },
          }),
        });
        if (!signal.aborted) {
          setConfig(saved);
          setNotice('saved');
        }
      } else if (action === 'retry') {
        await request(clientApi.endpoint('documents', undefined, 'retry'), {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, path }),
        });
        if (!signal.aborted) {
          setNotice('queued');
        }
      } else {
        const latest = await request(clientApi.endpoint('config'), { signal, cache: 'no-store' });
        if (!signal.aborted) {
          setConfig(latest);
        }
      }
      if (workspaceId) {
        const result = await request(
          clientApi.endpoint('documents', { workspaceId, offset: page }, 'status'),
          { signal, cache: 'no-store' },
        );
        if (!signal.aborted) {
          setData(result);
          setOffset(page);
        }
      }
    } catch (reason) {
      if (!signal.aborted) {
        setError(reason.message);
      }
    } finally {
      lock.current = false;
      if (!signal.aborted) {
        setBusy(false);
      }
    }
  };
  const errorText = (code) => {
    const key = `lark.${code}`;
    return hasLocaleKey(key) ? t(key) : text('failed');
  };

  return h(
    'section',
    { className: css.section, 'aria-labelledby': `${id}-title` },
    h('h3', { id: `${id}-title` }, text('title')),
    h('p', { className: css.muted }, text('scope')),
    h(
      'div',
      { className: css.field },
      h('span', { className: css.fieldTitle }, text('enabled')),
      h(Checkbox, {
        'aria-label': text('enabled'),
        checked: enabled,
        disabled: disabled || busy || !config,
        onChange: (checked) => {
          setEnabled(checked);
          setNotice(null);
        },
      }),
    ),
    h('p', { className: css.muted }, text('versions')),
    h(
      SettingsActionBar,
      {
        placement: 'page',
        leading: h(
          Button,
          { variant: 'ghost', disabled: !data, onClick: () => setRecordsOpen(true) },
          text('records'),
        ),
        status: notice ? text(notice) : '',
      },
      h(
        Button,
        {
          disabled: busy || disabled,
          onClick: () => (config ? perform('refresh') : setRevision((value) => value + 1)),
        },
        text('refresh'),
      ),
      h(
        Button,
        {
          variant: 'primary',
          disabled:
            busy || disabled || !config || enabled === (config.documents?.larkSyncEnabled === true),
          onClick: () => perform('save'),
        },
        text('save'),
      ),
    ),
    error &&
      h(
        'p',
        { role: 'alert', className: css.error },
        errorText(error),
        ' ',
        h('code', null, error),
      ),
    data?.scanError &&
      h(
        'p',
        { role: 'alert', className: css.error },
        text('scanFailed'),
        ' ',
        h('code', null, data.scanError),
      ),
    !config && !error && h('p', { role: 'status' }, text('loading')),
    h(
      Modal,
      {
        open: recordsOpen,
        title: text('records'),
        onClose: () => setRecordsOpen(false),
        footer:
          data &&
          (offset > 0 || data.nextOffset !== null) &&
          h(
            ActionBar,
            { placement: 'page' },
            h(
              Button,
              {
                size: 'sm',
                disabled: busy || offset === 0,
                onClick: () => perform('refresh', null, Math.max(0, offset - 100)),
              },
              text('previous'),
            ),
            h(
              Button,
              {
                size: 'sm',
                disabled: busy || data.nextOffset === null,
                onClick: () => perform('refresh', null, data.nextOffset),
              },
              text('next'),
            ),
          ),
      },
      error &&
        h(
          'p',
          { role: 'alert', className: css.error },
          errorText(error),
          ' ',
          h('code', null, error),
        ),
      data &&
        h(
          'div',
          null,
          !data.items.length && h('p', { role: 'status', className: css.muted }, text('empty')),
          ...data.items.map((item) =>
            h(
              'div',
              { key: item.path, className: css.section },
              h('p', { className: css.path }, item.path),
              h('p', null, text(`state.${item.status}`)),
              item.error &&
                h(
                  'p',
                  { className: css.error },
                  errorText(item.error),
                  ' ',
                  h('code', null, item.error),
                ),
              item.result?.url &&
                h(
                  'a',
                  { href: item.result.url, target: '_blank', rel: 'noopener noreferrer' },
                  text('open'),
                ),
              item.status === 'failed' &&
                h(
                  Button,
                  {
                    size: 'sm',
                    tone: 'business',
                    disabled: busy || disabled,
                    onClick: () => perform('retry', item.path),
                  },
                  text('retry'),
                ),
            ),
          ),
        ),
    ),
  );
}

module.exports = { DocumentReplicaSettings };
