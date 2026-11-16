'use strict';
const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { Input } = require('../shared/Input.js');
const { Select } = require('../shared/Select.js');
const { Checkbox, HoverCard } = require('../shared/controls.js');
const { SettingsActionBar } = require('../shared/SettingsActionBar.js');
const { showToast } = require('../shared/ToastContainer.js');
const { showConfirm } = require('../shared/ConfirmDialog.js');
const { knowledgeV2Request, knowledgeV2ErrorText } = require('../../hooks/useKnowledgeV2.js');
const css = require('../shared/SettingsForm.module.css').default;
const kCss = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;
const { IconInfo } = require('../../icons.js').createIconComponents(h);

/**
 * Settings tab for V2 synchronization, compile rules and scoped reset.
 * Each section owns its save action; the owning panel keeps this tab mounted so
 * unsaved edits survive tab switches.
 * @param props - Workspace identity and notification for changed knowledge data.
 * @param {string} props.workspaceId - Workspace whose settings are edited.
 * @param {Function} [props.onChanged] - Called after rules are saved or the base is cleared.
 * @returns The rendered component content.
 */
function KnowledgeSettings({ workspaceId, onChanged }) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [syncBusy, setSyncBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [syncNotice, setSyncNotice] = React.useState(null);
  const [reload, setReload] = React.useState(0);
  const formId = React.useId();
  React.useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setData(null);
    setNotice(null);
    setSyncNotice(null);
    Promise.all([
      knowledgeV2Request('/rules', workspaceId, null, controller.signal),
      knowledgeV2Request('/settings', workspaceId, null, controller.signal),
    ])
      .then(([rules, settings]) => {
        if (!controller.signal.aborted) {
          setData({
            purpose: rules.purpose,
            schema: rules.schema,
            language: rules.language,
            sync: settings.values,
            syncVersion: settings.version,
            schedule: settings.schedule,
          });
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setError(failure);
        }
      });
    return () => controller.abort();
  }, [workspaceId, reload]);
  const update = (key, value) => {
    setNotice(null);
    setData((previous) => ({ ...previous, [key]: value }));
  };
  const updateSync = (key, value) => {
    setSyncNotice(null);
    setData((previous) => ({
      ...previous,
      sync: { ...previous.sync, [key]: value },
    }));
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await knowledgeV2Request('/rules', workspaceId, {
        purpose: data.purpose,
        schema: data.schema,
        language: data.language,
      });
      setData((previous) => ({
        ...previous,
        purpose: result.rules.purpose,
        schema: result.rules.schema,
        language: result.rules.language,
      }));
      setNotice(result.job ? t('kb.settings.saved') : t('kb.settings.savedNoJob'));
      onChanged?.();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const saveSync = async () => {
    setSyncBusy(true);
    setError(null);
    setSyncNotice(null);
    try {
      const result = await knowledgeV2Request('/settings', workspaceId, {
        expectedVersion: data.syncVersion,
        values: data.sync,
      });
      setData((previous) => ({
        ...previous,
        sync: result.values,
        syncVersion: result.version,
        schedule: result.schedule,
      }));
      setSyncNotice(t('kb.settings.syncSaved'));
    } catch (failure) {
      setError(failure);
    } finally {
      setSyncBusy(false);
    }
  };
  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      let scope;
      try {
        await knowledgeV2Request('/reset', workspaceId, {});
      } catch (failure) {
        if (failure.code !== 'KB_RESET_CONFIRM_REQUIRED' || !failure.details?.scopeId) {
          throw failure;
        }
        scope = failure.details;
      }
      if (!scope) {
        return;
      }
      const confirmed = await showConfirm({
        title: t('kb.settings.resetTitle'),
        message: t('kb.settings.resetMessage'),
        confirmText: t('kb.settings.resetConfirm'),
        variant: 'danger',
      });
      if (!confirmed) {
        return;
      }
      await knowledgeV2Request('/reset', workspaceId, {
        confirm: scope.scopeId,
        expectedEpoch: scope.epoch,
      });
      showToast({ tone: 'success', text: t('kb.settings.resetDone') });
      setReload((value) => value + 1);
      onChanged?.();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const title = (key, text) =>
    h(
      'div',
      { className: css.fieldTitle },
      h('span', { id: `${formId}-${key}` }, text),
      h(HoverCard, {
        surfaceClassName: css.helpBubble,
        anchor: h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            className: css.helpButton,
            'aria-label': t('schedule.help', { title: text }),
          },
          h(IconInfo, { size: 14 }),
        ),
        content: t(`kb.settings.${key}Help`),
      }),
    );
  const sectionTitle = (id, text) => h('h3', { id }, text);
  const field = (key, control) =>
    h('div', { className: css.field }, title(key, t(`kb.settings.${key}`)), control);
  const toggle = (key, disabled = false) =>
    h(
      'div',
      { className: css.field },
      h(Checkbox, {
        checked: data.sync[key],
        disabled: busy || syncBusy || disabled,
        onChange: (checked) => updateSync(key, checked),
        label: t(`kb.settings.${key}`),
      }),
      h('p', { className: css.muted }, t(`kb.settings.${key}Help`)),
    );
  const status = (text) => h('span', { role: 'status', className: css.saveNotice }, text || '');
  return h(
    'section',
    { className: css.panel, 'aria-label': t('kb.settings.title') },
    !data && !error && h('p', { role: 'status' }, t('common.loading')),
    error && h('p', { role: 'alert', className: css.error }, knowledgeV2ErrorText(error)),
    error &&
      !data &&
      h(
        Button,
        {
          variant: 'outline',
          tone: 'business',
          onClick: () => setReload((value) => value + 1),
        },
        t('common.retry'),
      ),
    data &&
      h(
        React.Fragment,
        null,
        h(
          'section',
          { className: css.section, 'aria-labelledby': `${formId}-sync` },
          sectionTitle(`${formId}-sync`, t('kb.settings.syncTitle')),
          toggle('autoManage'),
          field(
            'autoManageDelayMs',
            h(Input, {
              type: 'number',
              min: 0,
              max: 3600000,
              step: 1000,
              value: data.sync.autoManageDelayMs,
              disabled: busy || syncBusy || !data.sync.autoManage,
              'aria-labelledby': `${formId}-autoManageDelayMs`,
              onChange: (event) => updateSync('autoManageDelayMs', Number(event.target.value)),
            }),
          ),
          toggle('dailyUpdateEnabled'),
          field(
            'dailyUpdateTime',
            h(Input, {
              type: 'time',
              step: 60,
              value: data.sync.dailyUpdateTime,
              disabled: busy || syncBusy || !data.sync.dailyUpdateEnabled,
              'aria-labelledby': `${formId}-dailyUpdateTime`,
              onChange: (event) => updateSync('dailyUpdateTime', event.target.value),
            }),
          ),
          toggle('dailyImportConversations', !data.sync.dailyUpdateEnabled),
          toggle('larkPushEnabled'),
          h(
            'p',
            { className: css.muted, role: 'status' },
            t(`kb.settings.schedule.${data.schedule?.state || 'idle'}`) +
              (data.schedule?.lastRunAt ? ` · ${data.schedule.lastRunAt}` : ''),
          ),
          h(
            SettingsActionBar,
            { placement: 'section', status: status(syncNotice) },
            h(
              Button,
              {
                type: 'button',
                variant: 'primary',
                disabled: busy || syncBusy,
                onClick: saveSync,
              },
              syncBusy ? t('kb.settings.saving') : t('common.save'),
            ),
          ),
        ),
        h(
          'section',
          { className: css.section, 'aria-labelledby': `${formId}-rules` },
          sectionTitle(`${formId}-rules`, t('kb.settings.rulesTitle')),
          field(
            'purpose',
            h('textarea', {
              className: kCss.editor,
              rows: 5,
              value: data.purpose,
              disabled: busy || syncBusy,
              'aria-labelledby': `${formId}-purpose`,
              onChange: (event) => update('purpose', event.target.value),
            }),
          ),
          field(
            'schema',
            h('textarea', {
              className: kCss.editor,
              rows: 8,
              value: data.schema,
              disabled: busy || syncBusy,
              'aria-labelledby': `${formId}-schema`,
              onChange: (event) => update('schema', event.target.value),
            }),
          ),
          field(
            'language',
            h(Select, {
              value: data.language,
              disabled: busy || syncBusy,
              'aria-labelledby': `${formId}-language`,
              options: ['auto', 'zh', 'en'].map((id) => ({
                id,
                label: t(`kb.settings.language.${id}`),
              })),
              onChange: (event) => update('language', event.target.value),
            }),
          ),
          h('p', { className: css.muted }, t('kb.settings.rebuildHint')),
          h(
            SettingsActionBar,
            { placement: 'section', status: status(notice) },
            h(
              Button,
              { type: 'button', variant: 'primary', disabled: busy || syncBusy, onClick: save },
              busy ? t('kb.settings.saving') : t('common.save'),
            ),
          ),
        ),
        h(
          'section',
          { className: css.section, 'aria-labelledby': `${formId}-reset` },
          sectionTitle(`${formId}-reset`, t('kb.settings.resetTitle')),
          h(SettingsActionBar, {
            placement: 'section',
            leading: h(
              Button,
              {
                type: 'button',
                variant: 'outline',
                tone: 'danger',
                disabled: busy || syncBusy,
                onClick: reset,
              },
              t('kb.settings.reset'),
            ),
            status: h('span', { className: css.muted }, t('kb.settings.resetHint')),
          }),
        ),
      ),
  );
}
module.exports = { KnowledgeSettings };
