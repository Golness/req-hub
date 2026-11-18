'use strict';
const clientApi = require('../api/index.js');
const { clientError } = require('../utils/serverMessage.js');
const React = require('react');
const { Input } = require('./shared/Input.js');
const { Select } = require('./shared/Select.js');
const { Button } = require('./shared/Button.js');
const { SettingsActionBar } = require('./shared/SettingsActionBar.js');
const { Disclosure } = require('./shared/Disclosure.js');
const { HoverCard } = require('./shared/controls.js');
const { LarkTargetSettings } = require('./LarkTargetSettings.js');
const { DocumentReplicaSettings } = require('./DocumentReplicaSettings.js');
const { LarkErrorDetails } = require('./LarkErrorDetails.js');
const { t, hasLocaleKey } = require('../locale.js');
const css = require('./shared/SettingsForm.module.css').default;
const layout = require('./LarkSettings.module.css').default;
const h = React.createElement;
const { IconInfo } = require('../icons.js').createIconComponents(h);

/**
 * Configure the CLI connection; credentials remain owned by lark-cli.
 * @param props - Current workspace for publication target bindings.
 * @returns A form that preserves drafts and verifies drafts before saving configuration.
 */
function LarkCliSettings({ workspaceId } = {}) {
  const [values, setValues] = React.useState(null);
  const [saved, setSaved] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [lastAction, setLastAction] = React.useState(null);
  const [verifiedSettings, setVerifiedSettings] = React.useState(null);
  const [verifiedApplication, setVerifiedApplication] = React.useState(null);
  const [revision, setRevision] = React.useState(0);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [application, setApplication] = React.useState({
    appId: '',
    appSecret: '',
    brand: 'feishu',
  });
  const owner = React.useRef(null);
  const inFlight = React.useRef(false);
  const id = React.useId();
  const text = (key) => {
    const full = `lark.${key}`;
    return hasLocaleKey(full) ? t(full) : key;
  };

  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    setError(null);
    clientApi
      .request(clientApi.endpoint('config'), { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('LARK_LOAD_FAILED');
        }
        const config = await response.json();
        if (!controller.signal.aborted) {
          const next = {
            executable: config.lark?.executable ?? 'lark-cli',
            profile: config.lark?.profile ?? '',
            identity: config.lark?.identity ?? 'user',
            timeoutMs: config.lark?.timeoutMs ?? 30000,
          };
          setValues(next);
          setSaved(JSON.stringify(next));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('LARK_LOAD_FAILED');
        }
      });
    return () => controller.abort();
  }, [revision]);

  React.useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(false), 2000);
    return () => clearTimeout(timer);
  }, [notice]);

  const errorText = (code) => {
    const supported = [
      'LARK_APP_SCOPE_REQUIRED',
      'LARK_USER_SCOPE_REQUIRED',
      'LARK_NETWORK_FAILED',
      'LARK_TARGET_ACCESS_FAILED',
      'LARK_LOAD_FAILED',
      'LARK_SAVE_FAILED',
      'LARK_CONFIG_INVALID',
      'LARK_CLI_NOT_FOUND',
      'LARK_CHECK_TIMEOUT',
      'LARK_OUTPUT_LIMIT',
      'LARK_CHECK_FAILED',
      'LARK_CHECK_CANCELLED',
      'LARK_CHECK_BUSY',
      'LARK_QUEUE_FULL',
      'LARK_QUEUE_TIMEOUT',
      'LARK_RESPONSE_INVALID',
      'LARK_APP_MISSING',
      'LARK_LOGIN_REQUIRED',
      'LARK_AUTH_UNVERIFIED',
      'LARK_CHECK_OK',
      'LARK_APP_INVALID',
      'LARK_APP_SAVED',
      'LARK_CONFIGURE_FAILED',
      'LARK_APP_CHECK_OK',
      'LARK_APP_CHECK_FAILED',
    ];
    return text(supported.includes(code) ? code : 'LARK_CHECK_FAILED');
  };
  if (!values) {
    return h(
      'div',
      { className: css.panel },
      h('p', { role: error ? 'alert' : 'status' }, error ? errorText(error) : text('loading')),
      error && h(Button, { onClick: () => setRevision((value) => value + 1) }, t('common.retry')),
    );
  }
  const snapshot = JSON.stringify(values);
  const dirty = snapshot !== saved;
  const settingsChecked = verifiedSettings === snapshot;
  const appChecked =
    verifiedApplication?.application === application && verifiedApplication?.values === values;
  const valid =
    values.executable.trim() &&
    /^[A-Za-z0-9_-]{0,64}$/.test(values.profile) &&
    Number.isInteger(values.timeoutMs) &&
    values.timeoutMs >= 1000 &&
    values.timeoutMs <= 120000;
  const update = (key, value) => {
    setVerifiedSettings(null);
    setVerifiedApplication(null);
    setValues((previous) => ({ ...previous, [key]: value }));
    setResult(null);
    setNotice(false);
    setError(null);
  };
  const perform = async (action) => {
    if (
      inFlight.current ||
      busy ||
      !valid ||
      (action === 'save' && (!dirty || !settingsChecked)) ||
      (action === 'configure' && !appChecked) ||
      (['configure', 'app-check'].includes(action) && !appValid)
    ) {
      return;
    }
    if (action === 'check' || action === 'save') {
      setVerifiedSettings(null);
    }
    if (action === 'app-check' || action === 'configure') {
      setVerifiedApplication(null);
    }
    inFlight.current = true;
    setBusy(action);
    setLastAction(action);
    setError(null);
    setNotice(false);
    setResult(null);
    const signal = owner.current.signal;
    try {
      const path = `lark/${action}`;
      const body = ['configure', 'app-check'].includes(action)
        ? { ...application, lark: values }
        : { lark: values };
      const response = await clientApi.request(clientApi.endpoint('lark', undefined, action), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        throw clientError(data.error || data.code, 'LARK_CHECK_FAILED');
      }
      if (!signal.aborted) {
        setResult(data);
        if (action === 'save') {
          if (data.saved) {
            setSaved(snapshot);
            setVerifiedSettings(snapshot);
            setNotice(true);
          } else {
            setVerifiedSettings(null);
          }
        } else if (action === 'check') {
          setVerifiedSettings(data.ready ? snapshot : null);
        } else if (action === 'app-check') {
          setVerifiedApplication(data.credentialsValid ? { application, values } : null);
        } else if (data.configured) {
          setConnectionEpoch((previous) => previous + 1);
          setApplication((previous) => ({ ...previous, appSecret: '' }));
          setVerifiedApplication(null);
          setVerifiedSettings(null);
        }
      }
    } catch (reason) {
      if (!signal.aborted) {
        setError(
          action === 'save' && reason.message !== 'LARK_CONFIG_INVALID'
            ? 'LARK_SAVE_FAILED'
            : reason.message,
        );
      }
    } finally {
      inFlight.current = false;
      if (!signal.aborted) {
        setBusy(null);
      }
    }
  };
  const field = (key, control) =>
    h(
      'div',
      { className: css.field, key },
      h(
        'div',
        { className: css.fieldTitle },
        h('label', { htmlFor: `${id}-${key}` }, text(key)),
        h(HoverCard, {
          surfaceClassName: css.helpBubble,
          anchor: h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: css.helpButton,
              'aria-label': t('lark.help', { title: text(key) }),
            },
            h(IconInfo, { size: 14 }),
          ),
          content: text(key + 'Help'),
        }),
      ),
      control,
    );
  const input = (key, props = {}) =>
    h(Input, {
      id: `${id}-${key}`,
      className: css.usernameInput,
      value: values[key],
      disabled: !!busy,
      onChange: (event) => update(key, event.target.value),
      ...props,
    });
  const profileArg =
    values.profile && /^[A-Za-z0-9_-]{1,64}$/.test(values.profile)
      ? ` --profile ${values.profile}`
      : '';
  const updateApplication = (key, value) => {
    setVerifiedApplication(null);
    setApplication((previous) => ({ ...previous, [key]: value }));
    setResult(null);
    setError(null);
  };
  const appValid =
    /^cli_[A-Za-z0-9]{1,128}$/.test(application.appId) &&
    /^[^\s\x00-\x1f\x7f]{1,512}$/.test(application.appSecret);
  const isApplicationResult = ['app-check', 'configure'].includes(lastAction);
  const feedback =
    result &&
    h(
      'div',
      {
        role: result.ready || result.configured || result.credentialsValid ? 'status' : 'alert',
        className: layout.status,
      },
      h(
        'p',
        {
          className:
            result.ready || result.configured || result.credentialsValid ? css.muted : css.error,
        },
        errorText(result.code),
      ),
      h(LarkErrorDetails, { code: result.code, details: result.details }),
      result.version &&
        h(
          'p',
          { className: css.muted },
          t('lark.result', {
            version: result.version,
            identity: result.identity,
            appId: result.appId || '—',
          }),
        ),
    );
  return h(
    'section',
    { className: `${css.panel} ${layout.page}`, 'aria-label': t('settings.tab.lark') },
    h(
      'section',
      { className: `${layout.group} ${layout.connection}`, 'aria-labelledby': `${id}-connection` },
      h(
        'div',
        { className: layout.header },
        h('h3', { id: `${id}-connection` }, text('connectionTitle')),
        h(HoverCard, {
          surfaceClassName: css.helpBubble,
          anchor: h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: css.helpButton,
              'aria-label': text('connectionHelp'),
            },
            h(IconInfo, { size: 14 }),
          ),
          content: text('checkScope'),
        }),
      ),
      field('executable', input('executable', { maxLength: 1024 })),
      field(
        'identity',
        h(Select, {
          id: `${id}-identity`,
          'aria-label': text('identity'),
          className: css.zoneSelect,
          value: values.identity,
          disabled: !!busy,
          searchable: false,
          options: ['user', 'bot'].map((key) => ({ id: key, label: text(key) })),
          onChange: (event) => update('identity', event.target.value),
        }),
      ),
      h(
        Disclosure,
        { title: text('advanced'), compact: true },
        h(
          'div',
          { className: css.section },
          field('profile', input('profile', { maxLength: 64 })),
          field(
            'timeout',
            h(Input, {
              id: `${id}-timeout`,
              className: css.numberInput,
              type: 'number',
              min: 1,
              max: 120,
              step: 1,
              disabled: !!busy,
              value: values.timeoutMs === '' ? '' : values.timeoutMs / 1000,
              onChange: (event) =>
                update(
                  'timeoutMs',
                  event.target.value === '' ? '' : Number(event.target.value) * 1000,
                ),
            }),
          ),
        ),
      ),
      !valid && h('p', { className: css.error, role: 'alert' }, errorText('LARK_CONFIG_INVALID')),
      error &&
        !isApplicationResult &&
        h('p', { className: css.error, role: 'alert' }, errorText(error)),
      h(
        SettingsActionBar,
        null,
        h(
          Button,
          { disabled: !!busy || !valid, onClick: () => perform('check') },
          text(busy === 'check' ? 'checking' : 'check'),
        ),
        h(
          Button,
          {
            variant: 'primary',
            disabled: !!busy || !valid || !dirty || !settingsChecked,
            onClick: () => perform('save'),
          },
          text('saveConnection'),
        ),
        h('span', { className: css.saveNotice, role: 'status' }, notice ? text('saved') : ''),
      ),
      dirty && !settingsChecked && h('p', { className: css.muted }, text('checkFirst')),
      !isApplicationResult && feedback,
      h(
        Disclosure,
        { title: text('setup'), compact: true },
        h(
          'div',
          { className: css.section },
          h('p', { className: css.muted }, text('setupOptional')),
          h('p', { className: css.muted }, text('credentials')),
          field(
            'appId',
            h(Input, {
              id: `${id}-appId`,
              className: css.usernameInput,
              autoComplete: 'off',
              maxLength: 132,
              value: application.appId,
              disabled: !!busy,
              onChange: (event) => updateApplication('appId', event.target.value),
            }),
          ),
          field(
            'appSecret',
            h(Input, {
              id: `${id}-appSecret`,
              className: css.usernameInput,
              type: 'password',
              autoComplete: 'new-password',
              maxLength: 512,
              value: application.appSecret,
              disabled: !!busy,
              onChange: (event) => updateApplication('appSecret', event.target.value),
            }),
          ),
          field(
            'brand',
            h(Select, {
              id: `${id}-brand`,
              'aria-label': text('brand'),
              className: css.zoneSelect,
              value: application.brand,
              searchable: false,
              disabled: !!busy,
              options: ['feishu', 'lark'].map((key) => ({ id: key, label: text(key) })),
              onChange: (event) => updateApplication('brand', event.target.value),
            }),
          ),
          h(
            SettingsActionBar,
            null,
            h(
              Button,
              { disabled: !!busy || !valid || !appValid, onClick: () => perform('app-check') },
              text(busy === 'app-check' ? 'appChecking' : 'appCheck'),
            ),
            h(
              Button,
              {
                variant: 'primary',
                disabled: !!busy || !valid || !appValid || !appChecked,
                onClick: () => perform('configure'),
              },
              text(busy === 'configure' ? 'configuring' : 'configure'),
            ),
          ),
          isApplicationResult && feedback,
          isApplicationResult &&
            error &&
            h('p', { className: css.error, role: 'alert' }, errorText(error)),
          h(
            'div',
            { className: css.helpContent },
            values.identity === 'user' &&
              h('code', null, `lark-cli${profileArg} auth login --domain docs --domain drive`),
          ),
        ),
      ),
    ),
    h(LarkTargetSettings, {
      workspaceId,
      connectionKey: saved + ':' + connectionEpoch,
      disabled: !!busy || dirty,
      connectionBusy: !!busy,
    }),
    h(DocumentReplicaSettings, { workspaceId, disabled: !!busy || dirty }),
  );
}
module.exports = { LarkCliSettings };
