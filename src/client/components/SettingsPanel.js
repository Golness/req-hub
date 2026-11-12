'use strict';
const { t } = require('../locale.js');
const { setTimeZone } = require('../time.js');
const { GENERAL_DEFAULTS } = require('../../shared/general.cjs');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const { SettingsActionBar, SettingsActionScope } = require('./shared/SettingsActionBar.js');
const { Disclosure } = require('./shared/Disclosure.js');
const { HoverCard } = require('./shared/controls.js');
const { DependencySettings } = require('./DependencySettings.js');
const css = require('./SettingsPanel.module.css').default;
const SETTINGS_TABS = ['general', 'dependencies', 'sync', 'prompts'];
const { SyncScheduleSettings } = require('./SyncScheduleSettings.js');

const React = require('react');
const { Select } = require('./shared/Select.js');
const h = React.createElement;
const { IconInfo } = require('../icons.js').createIconComponents(h);
const form = require('./shared/SettingsForm.module.css').default;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { SessionSelectionContext } = require('../context.js');
const { SkillPreview } = require('./SkillPreview.js');
const { PromptManager } = require('./PromptManager.js');

// ─── SettingsPanel (4.10) ─────────────────────────────────────────
/**
 * @component
 * Settings tabs retain visited content so switching does not discard unsaved edits.
 * Displays the current LLM configuration (provider, available models), allows model selection,
 * and provides a prompt management section where prompts can be customized per category.
 * Supports binding skills as instruction layers and previewing skill content.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The workspace ID for fetching skills and configuration
 * @param {Function} props.onClose - Callback invoked when the panel is closed or cancelled
 * @param {string} [props.initialTab] - Destination selected by a settings shortcut.
 * @returns {JSX.Element}
 */
function SettingsPanel({ workspaceId, onClose, initialTab = 'general' }) {
  const destination = ['associations', 'lark'].includes(initialTab) ? 'dependencies' : initialTab;
  const firstTab = SETTINGS_TABS.includes(destination) ? destination : 'general';
  const [tab, setTab] = useState(firstTab);
  const [actionTarget, setActionTarget] = useState(null);
  const [visited, setVisited] = useState([firstTab]);
  const selectTab = (id) => {
    setTab(id);
    setVisited((previous) => (previous.includes(id) ? previous : [...previous, id]));
  };
  const selectedSession = React.useContext(SessionSelectionContext);
  const [settings, setSettings] = useState({
    general: { timeZone: 'Asia/Shanghai', ...GENERAL_DEFAULTS },
    defaultUsername: '',
    ai: {
      selectedModel: '',
      delegation: { maxConcurrency: 3 },
      prompts: {},
      skillBindings: {},
    },
  });
  const [llmConfig, setLlmConfig] = useState(null);
  const [promptRegistry, setPromptRegistry] = useState(null);
  const [availableSkills, setAvailableSkills] = useState([]);
  const [savedSettings, setSavedSettings] = useState(null);
  const [promptError, setPromptError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [previewingSkill, setPreviewingSkill] = useState(null);

  const loadPromptRegistry = async () => {
    setPromptError(false);
    try {
      const response = await fetch(`${ROUTE}/prompt-registry`);
      if (!response.ok) {
        throw new Error('load failed');
      }
      setPromptRegistry(await response.json());
    } catch {
      setPromptError(true);
    }
  };

  useEffect(() => {
    const fetchAll = async () => {
      const sessionId = selectedSession?.();
      try {
        // Fetch config
        const configRes = await fetch(`${ROUTE}/config`, {
          headers: {
            ...(sessionId ? { 'x-session-id': sessionId } : {}),
            ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
          },
          cache: 'no-store',
        });
        if (configRes.ok) {
          const data = await configRes.json();
          const nextSettings = {
            general: { timeZone: 'Asia/Shanghai', ...GENERAL_DEFAULTS, ...data.general },
            defaultUsername: data.defaultUsername || '',
            ai: {
              selectedModel: data.ai?.selectedModel || '',
              delegation: { maxConcurrency: data.ai?.delegation?.maxConcurrency ?? 3 },
              prompts: {
                ...Object.fromEntries(
                  Object.entries(data.ai?.prompts || {}).filter(
                    ([key]) => !key.startsWith('phased-'),
                  ),
                ),
                ...data.ai?.syncV2?.prompts,
              },
              skillBindings: {
                ...Object.fromEntries(
                  Object.entries(data.ai?.skillBindings || {}).filter(
                    ([key]) => !key.startsWith('phased-'),
                  ),
                ),
                ...data.ai?.syncV2?.skillBindings,
              },
            },
          };
          setSettings(nextSettings);
          setTimeZone(nextSettings.general.timeZone);
          setSavedSettings(JSON.stringify(nextSettings));
        } else {
          setMessage({ type: 'error', text: t('SettingsPanel.message002') });
        }
      } catch (err) {
        setMessage({ type: 'error', text: t('SettingsPanel.message002') });
      }

      try {
        const llmRes = await fetch(`${ROUTE}/llm-config`);
        if (llmRes.ok) {
          setLlmConfig(await llmRes.json());
        } else {
          setLlmConfig({ error: `HTTP ${llmRes.status}` });
        }
      } catch (err) {
        setLlmConfig({ error: err.message });
      }

      await loadPromptRegistry();

      // Fetch available skills
      try {
        let skillsUrl;
        if (sessionId) {
          skillsUrl = `${ROUTE}/skills?sessionId=${encodeURIComponent(sessionId)}`;
          if (workspaceId) {
            skillsUrl += `&workspaceId=${encodeURIComponent(workspaceId)}`;
          }
        } else if (workspaceId) {
          skillsUrl = `${ROUTE}/skills?workspaceId=${encodeURIComponent(workspaceId)}`;
        } else {
          skillsUrl = `${ROUTE}/skills`;
        }

        console.log('Fetching skills from:', skillsUrl);
        const skillsRes = await fetch(skillsUrl);
        if (skillsRes.ok) {
          const data = await skillsRes.json();
          console.log('Skills API response:', data);
          setAvailableSkills(data.skills || []);
        } else {
          console.error('Skills API error:', skillsRes.status);
        }
      } catch (err) {
        console.error('Failed to fetch skills:', err);
      }
    };
    fetchAll();
  }, [workspaceId]);

  // Auto-select first model if none selected
  useEffect(() => {
    if (
      llmConfig &&
      !llmConfig.error &&
      llmConfig.models?.length > 0 &&
      !settings.ai.selectedModel
    ) {
      setSettings((prev) => ({ ...prev, ai: { ...prev.ai, selectedModel: llmConfig.models[0] } }));
    }
  }, [llmConfig, settings.ai.selectedModel]);

  const handleSave = async () => {
    if (saving || savedSettings === null || !generalValid) {
      return;
    }
    const snapshot = JSON.stringify(settings);
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          general: settings.general,
          defaultUsername: settings.defaultUsername,
          ai: {
            selectedModel: settings.ai.selectedModel,
            delegation: { maxConcurrency: settings.ai.delegation.maxConcurrency },
            prompts: Object.fromEntries(
              Object.entries(settings.ai.prompts).filter(([key]) => !key.startsWith('phased-')),
            ),
            skillBindings: Object.fromEntries(
              Object.entries(settings.ai.skillBindings).filter(
                ([key]) => !key.startsWith('phased-'),
              ),
            ),
            syncV2: {
              contractVersion: 2,
              prompts: Object.fromEntries(
                Object.entries(settings.ai.prompts).filter(([key]) => key.startsWith('phased-')),
              ),
              skillBindings: Object.fromEntries(
                Object.entries(settings.ai.skillBindings).filter(([key]) =>
                  key.startsWith('phased-'),
                ),
              ),
            },
          },
        }),
      });
      if (res.ok) {
        setTimeZone(settings.general.timeZone);
        setSavedSettings(snapshot);
        setMessage({ type: 'success', text: t('SettingsPanel.message003') });
      } else {
        setMessage({ type: 'error', text: t('FilePreview.message002') });
      }
    } catch (err) {
      setMessage({ type: 'error', text: t('SettingsPanel.message004') + err.message });
    } finally {
      setSaving(false);
    }
  };

  const handlePromptChange = (key, value) => {
    setSettings((prev) => ({
      ...prev,
      ai: {
        ...prev.ai,
        prompts: { ...prev.ai.prompts, [key]: value },
      },
    }));
  };

  const handleSkillBindingChange = (promptKey, skillName) => {
    setSettings((prev) => ({
      ...prev,
      ai: {
        ...prev.ai,
        skillBindings: {
          ...prev.ai.skillBindings,
          [promptKey]: skillName || null,
        },
      },
    }));
  };

  const handleResetPrompt = (key) => {
    setSettings((prev) => {
      const newPrompts = { ...prev.ai.prompts };
      // The config API merges prompt keys, so send an explicit empty override.
      newPrompts[key] = '';
      const newSkillBindings = { ...prev.ai.skillBindings };
      newSkillBindings[key] = null;
      return {
        ...prev,
        ai: {
          ...prev.ai,
          prompts: newPrompts,
          skillBindings: newSkillBindings,
        },
      };
    });
  };

  const handlePreviewSkill = (skillName) => {
    setPreviewingSkill(skillName);
  };

  const handleBackFromPreview = () => {
    setPreviewingSkill(null);
  };

  const dirty = savedSettings !== null && JSON.stringify(settings) !== savedSettings;
  const generalValid =
    /^(?!\.)(?!.*\.\.)[^\s\\/~^:?*\[\]\x00-\x20\x7f]{0,64}$/.test(settings.defaultUsername) &&
    [
      ['taskTimeoutMs', 30000, 3600000],
      ['knowledgeMaxInputBytes', 1000, 20000000],
      ['knowledgeMaxResultBytes', 1000, 1000000],
    ].every(
      ([key, min, max]) =>
        Number.isInteger(settings.general[key]) &&
        settings.general[key] >= min &&
        settings.general[key] <= max,
    );

  const renderModelStatus = () => {
    if (llmConfig?.error) {
      return h('span', { className: 'rh-error', role: 'alert' }, t('SettingsPanel.message006'));
    } else if (!llmConfig) {
      return h('span', { className: 'rh-prompt-description' }, t('common.loadingEllipsis'));
    } else {
      return h(
        React.Fragment,
        null,
        h(
          Select,
          {
            id: 'rh-settings-model',
            className: `rh-form-select ${css.modelSelect}`,
            'aria-labelledby': 'rh-settings-model-title',
            value: settings.ai.selectedModel,
            disabled: savedSettings === null,
            onChange: (event) =>
              setSettings((prev) => ({
                ...prev,
                ai: { ...prev.ai, selectedModel: event.target.value },
              })),
          },
          !llmConfig.models?.length && h('option', { value: '' }, t('SettingsPanel.message007')),
          settings.ai.selectedModel &&
            !llmConfig.models?.includes(settings.ai.selectedModel) &&
            h('option', { value: settings.ai.selectedModel }, settings.ai.selectedModel),
          (llmConfig.models || []).map((model) => h('option', { key: model, value: model }, model)),
        ),
        h(
          'span',
          { className: 'rh-settings-provider', title: t('common.provider') },
          llmConfig.provider,
        ),
      );
    }
  };
  let saveStatusMessage;
  if (saving) {
    saveStatusMessage = t('SettingsPanel.message008');
  } else if (message?.type === 'error') {
    saveStatusMessage = message.text;
  } else if (dirty) {
    saveStatusMessage = t('SettingsPanel.message009');
  } else {
    saveStatusMessage = message?.text || '';
  }
  const settingTitle = (id, title, help) =>
    h(
      'div',
      { className: css.settingTitle },
      h('span', { id }, title),
      help &&
        h(HoverCard, {
          surfaceClassName: form.helpBubble,
          anchor: h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              className: form.helpButton,
              'aria-label': title,
            },
            h(IconInfo, { size: 14 }),
          ),
          content: help,
        }),
    );
  const renderGeneralSettings = () =>
    h(
      'div',
      { className: css.modelSettings },
      h(
        'div',
        { className: css.settingField },
        settingTitle('rh-time-zone-title', t('general.timeZone'), t('general.timeZoneHelp')),
        h(Select, {
          className: css.timeZoneSelect,
          'aria-labelledby': 'rh-time-zone-title',
          value: settings.general.timeZone,
          disabled: saving || savedSettings === null,
          searchable: true,
          options: [
            ...new Set([
              'Asia/Shanghai',
              'UTC',
              settings.general.timeZone,
              ...(Intl.supportedValuesOf?.('timeZone') || []),
            ]),
          ].map((zone) => ({
            id: zone,
            label: zone === 'Asia/Shanghai' ? t('schedule.zoneShanghai') : zone,
          })),
          onChange: (event) =>
            setSettings((previous) => ({
              ...previous,
              general: { ...previous.general, timeZone: event.target.value },
            })),
        }),
      ),
      h(
        'div',
        { className: css.settingField },
        settingTitle(
          'rh-default-username-title',
          t('schedule.username'),
          t('general.usernameHelp'),
        ),
        h(Input, {
          'aria-labelledby': 'rh-default-username-title',
          value: settings.defaultUsername,
          maxLength: 64,
          disabled: saving || savedSettings === null,
          onChange: (event) =>
            setSettings((previous) => ({
              ...previous,
              defaultUsername: event.target.value,
            })),
        }),
      ),
      h(
        'div',
        { className: css.settingField },
        settingTitle('rh-settings-model-title', t('SettingsPanel.message005')),
        h('div', { className: css.modelControls }, renderModelStatus()),
      ),
      h(
        Disclosure,
        { title: t('general.advanced'), compact: true },
        h(
          'div',
          { className: css.advancedFields },
          h(
            'div',
            { className: css.settingField },
            settingTitle(
              'rh-subagent-concurrency-title',
              t('settings.subagentConcurrency'),
              t('settings.subagentConcurrencyHint'),
            ),
            h(Input, {
              id: 'rh-subagent-concurrency',
              className: css.concurrencyInput,
              'aria-labelledby': 'rh-subagent-concurrency-title',
              type: 'number',
              min: 1,
              max: 16,
              step: 1,
              disabled: saving || savedSettings === null,
              value: settings.ai.delegation.maxConcurrency,
              onChange: (event) =>
                setSettings((previous) => ({
                  ...previous,
                  ai: {
                    ...previous.ai,
                    delegation: { maxConcurrency: Number(event.target.value) },
                  },
                })),
            }),
          ),
          ...[
            ['taskTimeoutMs', 30, 3600, 1000],
            ['knowledgeMaxInputBytes', 1, 20000, 1000],
            ['knowledgeMaxResultBytes', 1, 1000, 1000],
          ].map(([key, min, max, factor]) =>
            h(
              'div',
              { key, className: css.settingField },
              settingTitle(`rh-general-${key}-title`, t(`general.${key}`), t(`general.${key}Help`)),
              h(Input, {
                className: css.policyInput,
                'aria-labelledby': `rh-general-${key}-title`,
                type: 'number',
                min,
                max,
                step: key === 'taskTimeoutMs' ? 1 : 0.001,
                value: settings.general[key] / factor,
                disabled: saving || savedSettings === null,
                onChange: (event) =>
                  setSettings((previous) => ({
                    ...previous,
                    general: {
                      ...previous.general,
                      [key]: Math.round(Number(event.target.value) * factor),
                    },
                  })),
              }),
            ),
          ),
        ),
      ),
    );
  const renderFeatureSettings = (id) => {
    if (id === 'dependencies') {
      return h(DependencySettings, {
        workspaceId,
        initialTab: initialTab === 'lark' ? 'lark' : 'gitnexus',
      });
    }
    if (id === 'sync') {
      return h(SyncScheduleSettings, {
        key: 'sync-' + workspaceId,
        defaultUsername: savedSettings ? JSON.parse(savedSettings).defaultUsername : undefined,
      });
    }
    return h(PromptManager, {
      key: workspaceId,
      workspaceId,
      registry: promptRegistry,
      error: promptError,
      onRetry: loadPromptRegistry,
      prompts: settings.ai.prompts,
      skillBindings: settings.ai.skillBindings,
      skills: availableSkills,
      disabled: savedSettings === null,
      onChange: handlePromptChange,
      onBindSkill: handleSkillBindingChange,
      onReset: handleResetPrompt,
      onPreviewSkill: handlePreviewSkill,
    });
  };
  return h(
    React.Fragment,
    null,
    previewingSkill &&
      h(SkillPreview, {
        skillName: previewingSkill,
        workspaceId,
        onBack: handleBackFromPreview,
        inlineBack: true,
      }),
    h(
      'div',
      { className: `rh-settings-panel ${css.panel}`, hidden: !!previewingSkill },
      h(
        'div',
        { className: css.tabs },
        h(
          'div',
          { className: 'rh-workbench-tabs', role: 'tablist', 'aria-label': t('settings.tabs') },
          SETTINGS_TABS.map((id, index) =>
            h(
              'button',
              {
                key: id,
                id: `settings-tab-${id}`,
                type: 'button',
                role: 'tab',
                className: 'rh-workbench-tab',
                'aria-selected': tab === id,
                'aria-controls': `settings-content-${id}`,
                tabIndex: tab === id ? 0 : -1,
                onClick: () => selectTab(id),
                onKeyDown: (event) => {
                  let next;
                  if (event.key === 'ArrowRight') {
                    next = (index + 1) % SETTINGS_TABS.length;
                  } else if (event.key === 'ArrowLeft') {
                    next = (index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length;
                  } else if (event.key === 'Home') {
                    next = 0;
                  } else if (event.key === 'End') {
                    next = SETTINGS_TABS.length - 1;
                  }
                  if (next !== undefined) {
                    event.preventDefault();
                    selectTab(SETTINGS_TABS[next]);
                    event.currentTarget.parentElement
                      .querySelectorAll('[role="tab"]')
                      [next].focus();
                  }
                },
              },
              t(`settings.tab.${id}`),
            ),
          ),
        ),
        h(Button, { size: 'sm', variant: 'ghost', onClick: onClose }, t('common.close')),
      ),
      h(
        'div',
        { className: css.body },
        SETTINGS_TABS.map((id) =>
          h(
            'div',
            {
              key: id,
              id: `settings-content-${id}`,
              role: 'tabpanel',
              'aria-labelledby': `settings-tab-${id}`,
              hidden: tab !== id,
              className: css.content,
              tabIndex: 0,
            },
            visited.includes(id) &&
              h(
                SettingsActionScope.Provider,
                { value: { active: tab === id, target: actionTarget } },
                id === 'general' ? renderGeneralSettings() : renderFeatureSettings(id),
              ),
          ),
        ),
      ),
      h(
        'div',
        { ref: setActionTarget, className: css.actionDock },
        (tab === 'general' || tab === 'prompts') &&
          h(
            SettingsActionBar,
            { placement: 'page', className: `rh-op-actions rh-settings-actions ${css.actions}` },
            h(
              'span',
              {
                className: message?.type === 'error' ? 'rh-error' : 'rh-prompt-description',
                role: 'status',
              },
              saveStatusMessage,
            ),
            h(
              Button,
              {
                type: 'button',
                variant: 'primary',
                className: 'rh-btn rh-btn-primary',
                onClick: handleSave,
                disabled: saving || !dirty || !generalValid,
              },
              saving ? t('SettingsPanel.message008') : t('common.save'),
            ),
          ),
      ),
    ),
  );
}

module.exports = { SettingsPanel };
