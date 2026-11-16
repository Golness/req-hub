'use strict';
const { useTimeZone } = require('../time.js');
const React = require('react');
const { Input } = require('./shared/Input.js');
const { Button } = require('./shared/Button.js');
const { SettingsActionBar } = require('./shared/SettingsActionBar.js');
const { Select } = require('./shared/Select.js');
const { HoverCard } = require('./shared/controls.js');
const { ROUTE } = require('../constants.js');
const { t } = require('../locale.js');
const css = require('./shared/SettingsForm.module.css').default;
const h = React.createElement;
const { IconInfo } = require('../icons.js').createIconComponents(h);

/** Configure the default author and the Host-owned daily quick-sync clock. */
function SyncScheduleSettings({ defaultUsername } = {}) {
  const timeZone = useTimeZone();
  const [values, setValues] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [saveNotice, setSaveNotice] = React.useState(null);
  const owner = React.useRef(null);
  const lastValidDays = React.useRef(1);
  const formId = React.useId();
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    setError(null);
    fetch(`${ROUTE}/config`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('CONFIG_LOAD_FAILED');
        }
        const config = await response.json();
        if (!controller.signal.aborted) {
          lastValidDays.current = config.sync?.dailyOffsetDays ?? 1;
          setValues({
            defaultUsername: config.defaultUsername || '',
            sync: {
              dailyUpdateEnabled: config.sync?.dailyUpdateEnabled ?? false,
              dailyUpdateTime: config.sync?.dailyUpdateTime || '03:00',
              dailyOffsetDays: config.sync?.dailyOffsetDays ?? 1,
              larkPushEnabled: config.sync?.larkPushEnabled ?? false,
            },
          });
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      });
    return () => controller.abort();
  }, [revision]);
  React.useEffect(() => {
    if (!saveNotice) {
      return;
    }
    const timer = setTimeout(() => setSaveNotice(null), 2000);
    return () => clearTimeout(timer);
  }, [saveNotice]);
  const label = (key) => t(`schedule.${key}`);
  if (!values) {
    return h(
      'div',
      null,
      h('p', { role: error ? 'alert' : 'status' }, error || label('loading')),
      error && h(Button, { onClick: () => setRevision((value) => value + 1) }, t('common.retry')),
    );
  }
  const update = (key, value) => {
    setSaveNotice(null);
    if (key === 'dailyOffsetDays' && Number.isInteger(value) && value >= 0 && value <= 365) {
      lastValidDays.current = value;
    }
    setValues((old) => {
      const sync = { ...old.sync, [key]: value };
      if (key === 'dailyUpdateEnabled' && !value) {
        sync.dailyOffsetDays = lastValidDays.current;
      }
      return { ...old, sync };
    });
  };
  const enabled = values.sync.dailyUpdateEnabled;
  const disabled = busy || !enabled;
  const days = values.sync.dailyOffsetDays;
  const validDays = Number.isInteger(days) && days >= 0 && days <= 365;
  const time = values.sync.dailyUpdateTime.split(':');

  const username = defaultUsername ?? values.defaultUsername;
  const branchPrefix = `feature/${username ? username + '/' : ''}`;
  let exampleDay = '';
  if (validDays) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const date = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    exampleDay = new Date(
      Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day) - days),
    )
      .toISOString()
      .slice(0, 10);
  }
  const helpContent = (key) => {
    if (key === 'offset') {
      return h(
        'div',
        { className: css.helpContent },
        h('p', null, label('offsetHelp')),
        h('code', null, `${branchPrefix}yyyy-MM-dd-*`),
        validDays && h('p', null, t('schedule.patternHelp', { days })),
        exampleDay &&
          h(
            'p',
            null,
            t('schedule.exampleHelp', { day: exampleDay }),
            h('code', null, `${branchPrefix}${exampleDay}-${label('exampleName')}`),
          ),
      );
    }
    if (key === 'dailyTitle') {
      return h(
        'div',
        { className: css.helpContent },
        h('p', null, label(enabled ? 'enabledHelp' : 'disabledHelp')),
        h('p', null, label('workflowHelp')),
      );
    }
    return label(key + 'Help');
  };
  const title = (key, id, heading = false) =>
    h(
      'div',
      { className: css.fieldTitle },
      h(heading ? 'h3' : 'span', { id }, label(key)),
      h(HoverCard, {
        surfaceClassName: css.helpBubble,
        anchor: h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            className: css.helpButton,
            'aria-label': t('schedule.help', { title: label(key) }),
          },
          h(IconInfo, { size: 14 }),
        ),
        content: helpContent(key),
      }),
    );
  const field = (key, input) => h('div', { className: css.field }, title(key), input);
  const switchControl = (key, checked) =>
    h(
      'button',
      {
        type: 'button',
        role: 'switch',
        className: css.toggle,
        'aria-label': label(key),
        'aria-checked': checked,
        disabled: busy,
        onClick: () => update(key, !checked),
      },
      h(
        'span',
        { className: css.toggleTrack, 'aria-hidden': true },
        h('span', { className: css.toggleThumb }),
      ),
      label(checked ? 'on' : 'off'),
    );
  const clockSelect = (part, count) =>
    h(Select, {
      className: css.clockSelect,
      'aria-label': label(part === 0 ? 'hour' : 'minute'),
      value: time[part],
      disabled,
      searchable: false,
      options: Array.from({ length: count }, (_, value) => ({
        id: String(value).padStart(2, '0'),
        label: String(value).padStart(2, '0'),
      })),
      onChange: (event) => {
        const next = [...time];
        next[part] = event.target.value;
        update('dailyUpdateTime', next.join(':'));
      },
    });
  return h(
    'section',
    { className: css.panel, 'aria-label': label('title') },
    h(
      'p',
      { className: css.muted },
      t('general.usernameReference', {
        username: username || t('general.usernameUnset'),
      }),
    ),
    h(
      'section',
      { className: css.section, 'aria-labelledby': `${formId}-daily` },
      h(
        'div',
        { className: css.sectionHeader },
        title('dailyTitle', `${formId}-daily`, true),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: css.toggle,
            'aria-label': label('enabled'),
            'aria-checked': enabled,
            'aria-controls': `${formId}-rules`,
            disabled: busy,
            onClick: () => update('dailyUpdateEnabled', !enabled),
          },
          h(
            'span',
            { className: css.toggleTrack, 'aria-hidden': true },
            h('span', { className: css.toggleThumb }),
          ),
          label(enabled ? 'on' : 'off'),
        ),
      ),
      h(
        'div',
        { className: css.rules, id: `${formId}-rules` },
        field(
          'time',
          h(
            'div',
            { className: css.clock },
            clockSelect(0, 24),
            h('span', null, label('hourUnit')),
            clockSelect(1, 60),
            h('span', null, label('minuteUnit')),
          ),
        ),
        h('p', { className: css.muted }, t('general.scheduleZone', { zone: timeZone })),
        field(
          'offset',
          h(
            'div',
            { className: css.offsetRow },
            h(Input, {
              className: css.offsetInput,
              'aria-label': label('offset'),
              'aria-describedby': !validDays ? `${formId}-offset-error` : undefined,
              'aria-invalid': !validDays,
              type: 'number',
              min: 0,
              max: 365,
              step: 1,
              value: days,
              disabled,
              onChange: (event) =>
                update(
                  'dailyOffsetDays',
                  event.target.value === '' ? '' : Number(event.target.value),
                ),
            }),
            h('span', null, label('daysBefore')),
          ),
        ),
        !validDays &&
          h('p', { id: `${formId}-offset-error`, role: 'alert' }, label('offsetInvalid')),
        field(
          'larkPushEnabled',
          switchControl('larkPushEnabled', values.sync.larkPushEnabled === true),
        ),
      ),
    ),
    error && h('p', { role: 'alert' }, error),
    h(
      SettingsActionBar,
      { placement: 'page' },
      h(
        Button,
        {
          variant: 'primary',
          disabled: busy || !validDays,
          onClick: async () => {
            setBusy(true);
            setError(null);
            setSaveNotice(null);
            const signal = owner.current.signal;
            try {
              const response = await fetch(`${ROUTE}/config`, {
                method: 'POST',
                signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sync: values.sync }),
              });
              const result = await response.json();
              if (!response.ok) {
                throw new Error(result.error || 'CONFIG_SAVE_FAILED');
              }
              if (!signal.aborted) {
                setSaveNotice({});
              }
            } catch (reason) {
              if (!signal.aborted) {
                setError(reason.message);
              }
            } finally {
              if (!signal.aborted) {
                setBusy(false);
              }
            }
          },
        },
        t('common.save'),
      ),
      h('span', { role: 'status', className: css.saveNotice }, saveNotice ? label('saved') : ''),
    ),
  );
}
module.exports = { SyncScheduleSettings };
