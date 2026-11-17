'use strict';
const clientApi = require('../api/index.js');
const { localizeMessage } = require('../utils/serverMessage.js');
const React = require('react');
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const { HoverCard } = require('./shared/controls.js');
const css = require('./shared/SettingsForm.module.css').default;
const h = React.createElement;
const { IconInfo } = require('../icons.js').createIconComponents(h);

/**
 * Edit the global association flag independently of the Wiki settings draft.
 * Requests belong to this mounted control and are aborted on unmount.
 * @returns An automatically saved switch with loading and failure feedback.
 */
function DocumentAssociationSettings() {
  const [enabled, setEnabled] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [saved, setSaved] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const owner = React.useRef(null);
  const id = React.useId();
  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    setError(null);
    clientApi
      .request(clientApi.endpoint('config'), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('ENHANCEMENT_FAILED');
        }
        const config = await response.json();
        if (!controller.signal.aborted) {
          setEnabled(Boolean(config.enhancements?.enabled));
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(localizeMessage(error.message));
        }
      });
    return () => controller.abort();
  }, [revision]);
  React.useEffect(() => {
    if (!saved) {
      return;
    }
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);
  const toggle = async () => {
    if (busy) {
      return;
    }
    const signal = owner.current.signal;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const current = await clientApi.request(clientApi.endpoint('config'), { signal });
      if (!current.ok) {
        throw new Error('ENHANCEMENT_FAILED');
      }
      const config = await current.json();
      const next = !enabled;
      const response = await clientApi.request(clientApi.endpoint('config'), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enhancements: { ...config.enhancements, enabled: next } }),
      });
      if (!response.ok) {
        throw new Error('ENHANCEMENT_FAILED');
      }
      if (!signal.aborted) {
        setEnabled(next);
        setSaved(true);
      }
    } catch (error) {
      if (!signal.aborted) {
        setError(localizeMessage(error.message));
      }
    } finally {
      if (!signal.aborted) {
        setBusy(false);
      }
    }
  };
  return h(
    'section',
    { className: css.section, 'aria-label': t('assist.settings.enabled') },
    h(
      'div',
      { className: css.field },
      h(
        'div',
        { className: css.fieldTitle },
        h('span', { id }, t('assist.settings.enabled')),
        h(HoverCard, {
          surfaceClassName: css.helpBubble,
          anchor: h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: css.helpButton,
              'aria-label': t('schedule.help', { title: t('assist.settings.enabled') }),
            },
            h(IconInfo, { size: 14 }),
          ),
          content: t('assist.settings.enabledHelp'),
        }),
      ),
      h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: css.toggle,
          'aria-labelledby': id,
          'aria-checked': Boolean(enabled),
          disabled: enabled === null || busy,
          onClick: toggle,
        },
        h(
          'span',
          { className: css.toggleTrack, 'aria-hidden': true },
          h('span', { className: css.toggleThumb }),
        ),
        t(enabled ? 'schedule.on' : 'schedule.off'),
      ),
    ),
    enabled === null && !error && h('p', { role: 'status' }, t('common.loading')),
    error && h('p', { role: 'alert' }, t('enhancement.error', { code: error })),
    error &&
      enabled === null &&
      h(Button, { onClick: () => setRevision((value) => value + 1) }, t('common.retry')),
    h(
      'span',
      { role: 'status', className: css.saveNotice },
      saved ? t('assist.settings.saved') : '',
    ),
  );
}
module.exports = { DocumentAssociationSettings };
