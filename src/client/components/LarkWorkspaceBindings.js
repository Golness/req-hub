'use strict';
const clientApi = require('../api/index.js');
const { clientError } = require('../utils/serverMessage.js');
const React = require('react');
const { t, hasLocaleKey } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const { PagedList } = require('./shared/PagedList.js');
const { LarkErrorDetails } = require('./LarkErrorDetails.js');
const css = require('./LarkWorkspaceBindings.module.css').default;
const h = React.createElement;

/**
 * Show registered workspace bindings and remove only the selected local binding.
 * @param props - Saved revision, operation lock and callbacks for the owning target form.
 * @returns A paged table retaining its rows and failed operation until a verified save succeeds.
 */
function LarkWorkspaceBindings({ revision, disabled, onRemoved, onBusyChange }) {
  const [items, setItems] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState('');
  const [reload, setReload] = React.useState(0);
  const owner = React.useRef(null);
  const inFlight = React.useRef(false);
  const text = (key) => {
    const full = `lark.${key}`;
    return hasLocaleKey(full) ? t(full) : key;
  };
  const request = async (action, body, signal) => {
    const response = await clientApi.request(clientApi.endpoint('larkTarget', undefined, action), {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.error || (data.code && !data.saved)) {
      throw Object.assign(clientError(data.error || data.code, 'LARK_TARGET_FAILED'), {
        details: data.details,
      });
    }
    return data;
  };
  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    setBusy('load');
    setError(null);
    request('list', {}, controller.signal)
      .then((data) => {
        if (!Array.isArray(data.items)) {
          throw new Error('LARK_RESPONSE_INVALID');
        }
        if (!controller.signal.aborted) {
          setItems(data.items);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError({ reason });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setBusy(null);
        }
      });
    return () => controller.abort();
  }, [revision, reload]);
  React.useEffect(() => {
    onBusyChange?.(!!busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const remove = async (item) => {
    if (disabled || busy || inFlight.current) {
      return;
    }
    inFlight.current = true;
    const signal = owner.current.signal;
    setBusy(item.id);
    setError(null);
    setNotice('');
    try {
      const data = await request(
        'remove',
        {
          workspaceId: item.id,
          expectedRevision: item.revision,
        },
        signal,
      );
      if (!data.saved) {
        throw new Error('LARK_TARGET_FAILED');
      }
      if (!signal.aborted) {
        setItems((previous) =>
          previous.map((row) =>
            row.id === item.id
              ? { ...row, binding: null, bindingCurrent: false, revision: null }
              : row,
          ),
        );
        setNotice(t('lark.workspaceUnbound', { name: item.title }));
        onRemoved?.(item.id, data);
      }
    } catch (reason) {
      if (!signal.aborted) {
        setError({ reason, item });
      }
    } finally {
      inFlight.current = false;
      if (!signal.aborted) {
        setBusy(null);
      }
    }
  };
  const columns = ['bindingWorkspace', 'bindingLocalPath', 'bindingRemotePath', 'bindingActions'];
  return h(
    'div',
    { className: css.panel },
    h(
      'div',
      { className: css.toolbar },
      h('p', { className: css.hint }, text('bindingsLocalOnly')),
      h(
        Button,
        {
          size: 'sm',
          disabled: disabled || !!busy,
          onClick: () => setReload((value) => value + 1),
        },
        text('bindingsRefresh'),
      ),
    ),
    busy === 'load' && h('p', { role: 'status' }, t('common.loadingEllipsis')),
    items &&
      h(
        'div',
        { className: css.scroll },
        h(
          'div',
          { className: css.table, role: 'table', 'aria-label': text('workspaceBindings') },
          h(
            'div',
            { className: css.row, role: 'row' },
            columns.map((key) => h('div', { role: 'columnheader', key }, text(key))),
          ),
          h(
            PagedList,
            {
              inspect: false,
              plainRows: true,
              fitContent: true,
              rowHeight: 52,
              busy: !!busy,
              rowGroupRole: 'rowgroup',
              rowRole: 'presentation',
            },
            items.map((item) =>
              h(
                'div',
                { className: css.row, role: 'row', key: item.id },
                h('div', { role: 'cell', className: css.truncate, title: item.title }, item.title),
                h('div', { role: 'cell', className: css.truncate, title: item.path }, item.path),
                h(
                  'div',
                  { role: 'cell' },
                  item.binding
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          'span',
                          { className: css.truncate, title: item.binding.url },
                          `${text(item.binding.kind === 'wiki' ? 'bindingWiki' : 'bindingFolder')} / ${item.binding.title}`,
                        ),
                        !item.bindingCurrent &&
                          h('span', { className: css.hint }, text('bindingStale')),
                      )
                    : text('bindingNone'),
                ),
                h(
                  'div',
                  { role: 'cell' },
                  item.binding &&
                    h(
                      Button,
                      {
                        size: 'sm',
                        disabled: disabled || !!busy,
                        'aria-label': t('lark.removeWorkspaceBinding', { name: item.title }),
                        tone: 'danger',
                        onClick: () => remove(item),
                      },
                      busy === item.id ? text('targetSaving') : text('targetRemove'),
                    ),
                ),
              ),
            ),
          ),
        ),
      ),
    items?.length === 0 && h('p', null, text('targetNoWorkspace')),
    error &&
      h(
        'div',
        { role: 'alert' },
        h(
          'p',
          { className: css.error },
          error.reason.message === 'LARK_TARGET_CONFLICT'
            ? text('LARK_TARGET_CONFLICT')
            : text('bindingsFailed'),
        ),
        h(LarkErrorDetails, { code: error.reason.message, details: error.reason.details }),
        h(
          Button,
          {
            disabled: disabled || !!busy,
            onClick: () => {
              if (error.item && error.reason.message !== 'LARK_TARGET_CONFLICT') {
                void remove(error.item);
              } else {
                setReload((value) => value + 1);
              }
            },
          },
          t('common.retry'),
        ),
      ),
    notice && h('p', { role: 'status' }, notice),
  );
}
module.exports = { LarkWorkspaceBindings };
