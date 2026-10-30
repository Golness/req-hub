'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { Checkbox } = require('./shared/controls.js');
const css = require('./WikiPanel.module.css').default;
const h = React.createElement;
const flags = ['autoManage', 'autoCrossRef', 'useGitNexusForCrossRef', 'lintOnIngest'];
const numbers = {
  maxConcurrentJobs: [1, 8],
  maxWikiPagesPerScope: [1, 10000],
  maxInputBytes: [1000, 20000000],
  maxResultBytes: [1000, 1000000],
  maxSourceDocuments: [1, 200],
  maxAffectedPages: [1, 200],
  timeoutMs: [1000, 3600000],
  smallFileThresholdBytes: [0, Number.MAX_SAFE_INTEGER],
};
/**
 * Edit Wiki limits with version-conflict handling.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function WikiSettings({ workspaceId }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const owner = React.useRef(null);
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    owner.current = controller;
    fetch(`${ROUTE}/knowledge/wiki/settings?workspaceId=${encodeURIComponent(workspaceId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('WIKI_FAILED');
        }
        return response.json();
      })
      .then((value) => {
        if (!controller.signal.aborted) {
          setData(value);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error.message);
        }
      });
    return () => controller.abort();
  }, [workspaceId, open]);
  const update = (key, value) =>
    setData((old) => ({ ...old, values: { ...old.values, [key]: value } }));
  const save = async () => {
    const signal = owner.current.signal;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${ROUTE}/knowledge/wiki/settings`, {
        method: 'PUT',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, expectedVersion: data.version, values: data.values }),
      });
      const value = await response.json();
      if (!response.ok) {
        throw new Error(value.error || 'WIKI_FAILED');
      }
      if (!signal.aborted) {
        setData(value);
      }
    } catch (error) {
      if (!signal.aborted) {
        setError(error.message);
      }
    } finally {
      if (!signal.aborted) {
        setBusy(false);
      }
    }
  };
  return h(
    'details',
    { className: css.card, onToggle: (event) => setOpen(event.currentTarget.open) },
    h('summary', null, t('wiki.settings')),
    error && h('p', { role: 'alert' }, t('wiki.error', { code: error })),
    data &&
      h(
        'div',
        { className: css.list },
        flags.map((key) =>
          h(Checkbox, {
            key,
            checked: data.values[key],
            disabled: busy,
            label: t(`wiki.config.${key}`),
            onChange: (value) => update(key, value),
          }),
        ),
        Object.entries(numbers).map(([key, [min, max]]) =>
          h(
            'label',
            { key, className: css.field },
            t(`wiki.config.${key}`),
            h(Input, {
              type: 'number',
              min,
              max,
              step: 1,
              disabled: busy,
              value: data.values[key],
              onChange: (event) => update(key, Number(event.target.value)),
            }),
          ),
        ),
        h(Button, { type: 'button', disabled: busy, onClick: save }, t('common.save')),
      ),
  );
}
module.exports = { WikiSettings };
