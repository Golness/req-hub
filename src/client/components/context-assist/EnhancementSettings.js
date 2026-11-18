'use strict';
const { useAssist } = require('./useAssist.js');
const clientApi = require('../../api/index.js');
const { formatDateTime, useTimeZone } = require('../../time.js');
const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { SettingsActionBar } = require('../shared/SettingsActionBar.js');
const { ActionBar } = require('../shared/ActionBar.js');
const { Checkbox, HoverCard, Modal } = require('../shared/controls.js');
const { Select } = require('../shared/Select.js');
const { GitNexusTaskStatus } = require('../GitNexusTaskStatus.js');
const formCss = require('../shared/SettingsForm.module.css').default;
const settingsCss = require('../EnhancementSettings.module.css').default;
const h = React.createElement;
const { IconInfo } = require('../../icons.js').createIconComponents(h);
const codeJobKinds = ['code-refresh', 'code-index'];
const active = (job) => ['queued', 'preparing', 'running', 'cancelling'].includes(job?.status);
const state = (value) => t(`enhancement.state.${value || 'unavailable'}`);
const indexState = (code) =>
  code?.status && code.status !== 'disabled' ? state(code.status) : t('assist.settings.unchecked');
/**
 * Configure the code provider and show only current code-index operations.
 * Completed workspace-wide history remains in the document assistant.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function EnhancementSettings({ workspaceId }) {
  useTimeZone();
  const api = useAssist(workspaceId, undefined, undefined, codeJobKinds);
  const data = api.data;
  const formId = React.useId();
  const [taskOpen, setTaskOpen] = React.useState(false);
  const [saveNotice, setSaveNotice] = React.useState(null);
  React.useEffect(() => {
    if (!saveNotice) {
      return;
    }
    const timer = setTimeout(() => setSaveNotice(null), 2000);
    return () => clearTimeout(timer);
  }, [saveNotice]);
  const configure = (values) =>
    api.perform(async (signal) => {
      setSaveNotice(null);
      const current = await clientApi.request(clientApi.endpoint('config'), { signal });
      if (!current.ok) {
        throw new Error('ENHANCEMENT_FAILED');
      }
      const config = await current.json();
      const result = await clientApi.request(clientApi.endpoint('config'), {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enhancements: { ...config.enhancements, ...values } }),
      });
      if (!result.ok) {
        throw new Error('ENHANCEMENT_FAILED');
      }
      if (signal.aborted) {
        return;
      }
      api.setJob(null);
      setSaveNotice({});
      api.refresh();
    });
  const field = (key, control) => {
    const text = t(`assist.settings.${key}`);
    return h(
      'div',
      { className: formCss.field },
      h(
        'div',
        { className: formCss.fieldTitle },
        h('span', { id: `${formId}-${key}` }, text),
        h(HoverCard, {
          surfaceClassName: formCss.helpBubble,
          anchor: h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: formCss.helpButton,
              'aria-label': t('schedule.help', { title: text }),
            },
            h(IconInfo, { size: 14 }),
          ),
          content: t(`assist.settings.${key}Help`),
        }),
      ),
      control,
    );
  };
  const code = api.job?.result?.code || data?.graph?.code;
  let indexStatus = indexState(code);
  if (active(api.job)) {
    indexStatus = t(
      api.job.kind === 'code-index'
        ? 'assist.settings.updatingIndex'
        : 'assist.settings.checkingIndex',
    );
  }
  return h(
    'section',
    { className: `${formCss.panel} ${settingsCss.panel}`, 'aria-label': t('assist.settings') },
    api.error && h('p', { role: 'alert' }, t('enhancement.error', { code: api.error })),
    !data
      ? h(
          'div',
          null,
          !api.error && h('p', { role: 'status' }, t('common.loading')),
          api.error && h(Button, { onClick: api.refresh }, t('common.retry')),
        )
      : h(
          React.Fragment,
          null,
          h(
            'div',
            { className: settingsCss.layout },
            h(
              'section',
              { className: settingsCss.group, 'aria-labelledby': `${formId}-connection` },
              h(
                'div',
                { className: settingsCss.header },
                h('h3', { id: `${formId}-connection` }, t('assist.settings.connection')),
                h(
                  'span',
                  { className: formCss.saveNotice, role: 'status' },
                  saveNotice ? t('assist.settings.saved') : '',
                ),
              ),
              field(
                'server',
                h(Select, {
                  className: settingsCss.serverSelect,
                  'aria-labelledby': `${formId}-server`,
                  disabled: api.locked,
                  value: data.mcpServer || 'gitnexus',
                  onChange: (event) => configure({ gitnexusServer: event.target.value }),
                  options: [
                    ...new Set([data.mcpServer || 'gitnexus', ...(data.mcpServers || [])]),
                  ].map((server) => ({ id: server, label: server })),
                }),
              ),
              field(
                'registration',
                h(
                  'span',
                  null,
                  t(data.mcpAvailable ? 'assist.settings.registered' : 'assist.settings.absent'),
                ),
              ),
            ),
            h(
              'section',
              { className: settingsCss.group, 'aria-labelledby': `${formId}-code-index` },
              h('h3', { id: `${formId}-code-index` }, t('assist.settings.codeIndex')),
              field(
                'index',
                h('span', { role: active(api.job) ? 'status' : undefined }, indexStatus),
              ),
              code?.indexedAt &&
                h(
                  'p',
                  { className: `${formCss.muted} ${settingsCss.version}` },
                  t('enhancement.indexVersion', {
                    date: formatDateTime(code.indexedAt),
                    commit: code.lastCommit || '',
                  }),
                ),
              h(
                SettingsActionBar,
                {
                  placement: 'page',
                  status:
                    api.job &&
                    h(
                      Button,
                      { size: 'sm', variant: 'ghost', onClick: () => setTaskOpen(true) },
                      t('assist.settings.currentTask'),
                    ),
                },
                h(
                  Button,
                  {
                    disabled: api.locked,
                    onClick: () => {
                      setTaskOpen(true);
                      api.start('code-refresh');
                    },
                  },
                  t('enhancement.refreshCode'),
                ),
                h(
                  Button,
                  {
                    variant: 'primary',
                    disabled: api.locked,
                    onClick: () => {
                      setTaskOpen(true);
                      api.start('code-index');
                    },
                  },
                  t('enhancement.updateIndex'),
                ),
              ),
              h('p', { className: formCss.muted }, t('assist.settings.operationsHelp')),
            ),
            h(
              Modal,
              {
                open: taskOpen,
                title: t('assist.settings.currentTask'),
                onClose: () => setTaskOpen(false),
                footer:
                  active(api.job) &&
                  h(
                    ActionBar,
                    { placement: 'page' },
                    h(
                      Button,
                      {
                        tone: 'warning',
                        disabled: api.busy || api.job.status === 'cancelling',
                        onClick: api.cancel,
                      },
                      t('enhancement.cancel'),
                    ),
                  ),
              },
              !api.job && h('p', { role: 'status' }, t('common.loading')),
              api.error && h('p', { role: 'alert' }, t('enhancement.error', { code: api.error })),
              api.job &&
                h(GitNexusTaskStatus, {
                  key: api.job.id,
                  job: api.job,
                  busy: api.busy,
                }),
            ),
          ),
        ),
  );
}

module.exports = { EnhancementSettings };
