'use strict';
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const { Select } = require('./shared/Select.js');
const h = React.createElement;
const { useState, useEffect } = React;
const { ROUTE } = require('../constants.js');
const { SkillPreview } = require('./SkillPreview.js');
const { PromptManager } = require('./PromptManager.js');

// ─── SettingsPanel (4.10) ─────────────────────────────────────────
/**
 * @component
 * Settings panel for configuring AI/LLM models, prompt templates, and skill bindings.
 * Displays the current LLM configuration (provider, available models), allows model selection,
 * and provides a prompt management section where prompts can be customized per category.
 * Supports binding skills as instruction layers and previewing skill content.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The workspace ID for fetching skills and configuration
 * @param {Function} props.onClose - Callback invoked when the panel is closed or cancelled
 * @returns {JSX.Element}
 */
function SettingsPanel({ workspaceId, onClose }) {
  const [settings, setSettings] = useState({
    ai: {
      selectedModel: '',
      prompts: {},
      skillBindings: {}
    }
  });
  const [llmConfig, setLlmConfig] = useState(null);
  const [promptRegistry, setPromptRegistry] = useState(null);
  const [availableSkills, setAvailableSkills] = useState([]);
  const [savedSettings, setSavedSettings] = useState(null);
  const [promptError, setPromptError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [previewingSkill, setPreviewingSkill] = useState(null); // 预览中的 skill 名称

  const loadPromptRegistry = async () => {
    setPromptError(false);
    try {
      const response = await fetch(`${ROUTE}/prompt-registry`);
      if (!response.ok) throw new Error('load failed');
      setPromptRegistry(await response.json());
    } catch {
      setPromptError(true);
    }
  };

  useEffect(() => {
    const fetchAll = async () => {
      try {
        // Fetch config
        const configRes = await fetch(`${ROUTE}/config`);
        if (configRes.ok) {
          const data = await configRes.json();
          const nextSettings = {
            ai: {
              selectedModel: data.ai?.selectedModel || '',
              prompts: { ...Object.fromEntries(Object.entries(data.ai?.prompts || {}).filter(([key]) => !key.startsWith('phased-'))), ...data.ai?.syncV2?.prompts },
              skillBindings: { ...Object.fromEntries(Object.entries(data.ai?.skillBindings || {}).filter(([key]) => !key.startsWith('phased-'))), ...data.ai?.syncV2?.skillBindings }
            }
          };
          setSettings(nextSettings);
          setSavedSettings(JSON.stringify(nextSettings));
        } else {
          setMessage({ type: 'error', text: t("SettingsPanel.message002") });
        }
      } catch (err) { setMessage({ type: 'error', text: t("SettingsPanel.message002") }); }

      try {
        const llmRes = await fetch(`${ROUTE}/llm-config`);
        if (llmRes.ok) {
          setLlmConfig(await llmRes.json());
        } else {
          setLlmConfig({ error: `HTTP ${llmRes.status}` });
        }
      } catch (err) { setLlmConfig({ error: err.message }); }

      await loadPromptRegistry();

      // Fetch available skills
      try {
        // 尝试从 DSH 上下文获取当前会话 ID
        let sessionId = null;
        try {
          const ctx = window.__DSH_CTX__;
          if (ctx) {
            const uiWorkspace = ctx.get?.('uiWorkspace');
            if (uiWorkspace?.selection && typeof uiWorkspace.selection.getSnapshot === 'function') {
              const selection = uiWorkspace.selection.getSnapshot();
              if (selection?.sessionId) {
                sessionId = selection.sessionId;
              }
            }
          }
        } catch (e) {
          // 忽略错误
        }

        // 构建 URL：优先使用 sessionId，如果没有则使用 workspaceId
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
      } catch (err) { console.error('Failed to fetch skills:', err); }
    };
    fetchAll();
  }, [workspaceId]);

  // Auto-select first model if none selected
  useEffect(() => {
    if (llmConfig && !llmConfig.error && llmConfig.models?.length > 0 && !settings.ai.selectedModel) {
      setSettings(prev => ({ ...prev, ai: { ...prev.ai, selectedModel: llmConfig.models[0] } }));
    }
  }, [llmConfig, settings.ai.selectedModel]);

  const handleSave = async () => {
    if (saving || savedSettings === null) return;
    const snapshot = JSON.stringify(settings);
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai: { selectedModel: settings.ai.selectedModel,
          prompts: Object.fromEntries(Object.entries(settings.ai.prompts).filter(([key]) => !key.startsWith('phased-'))),
          skillBindings: Object.fromEntries(Object.entries(settings.ai.skillBindings).filter(([key]) => !key.startsWith('phased-'))),
          syncV2: { contractVersion: 2,
            prompts: Object.fromEntries(Object.entries(settings.ai.prompts).filter(([key]) => key.startsWith('phased-'))),
            skillBindings: Object.fromEntries(Object.entries(settings.ai.skillBindings).filter(([key]) => key.startsWith('phased-'))) }
        } })
      });
      if (res.ok) {
        setSavedSettings(snapshot);
        setMessage({ type: 'success', text: t("SettingsPanel.message003") });
      } else {
        setMessage({ type: 'error', text: t("FilePreview.message002") });
      }
    } catch (err) {
      setMessage({ type: 'error', text: t("SettingsPanel.message004") + err.message });
    } finally {
      setSaving(false);
    }
  };

  const handlePromptChange = (key, value) => {
    setSettings(prev => ({
      ...prev,
      ai: {
        ...prev.ai,
        prompts: { ...prev.ai.prompts, [key]: value }
      }
    }));
  };

  const handleSkillBindingChange = (promptKey, skillName) => {
    setSettings(prev => ({
      ...prev,
      ai: {
        ...prev.ai,
        skillBindings: {
          ...prev.ai.skillBindings,
          [promptKey]: skillName || null
        }
      }
    }));
  };

  const handleResetPrompt = (key) => {
    setSettings(prev => {
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
          skillBindings: newSkillBindings
        }
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

  return h(React.Fragment, null,
    previewingSkill && h(SkillPreview, {
      skillName: previewingSkill, workspaceId, onBack: handleBackFromPreview,
    }),
    h('div', { className: 'rh-op-panel rh-settings-panel', hidden: !!previewingSkill },
      h('div', { className: 'rh-settings-model' },
        h('label', { htmlFor: 'rh-settings-model', className: 'rh-form-label' }, t("SettingsPanel.message005")),
        llmConfig?.error
          ? h('span', { className: 'rh-error', role: 'alert' }, t("SettingsPanel.message006"))
          : !llmConfig
            ? h('span', { className: 'rh-prompt-description' }, t("common.loadingEllipsis"))
            : h(React.Fragment, null,
                h(Select, {
                  id: 'rh-settings-model', className: 'rh-form-select',
                  value: settings.ai.selectedModel, disabled: savedSettings === null,
                  onChange: event => setSettings(prev => ({ ...prev, ai: { ...prev.ai, selectedModel: event.target.value } })),
                },
                  !llmConfig.models?.length && h('option', { value: '' }, t("SettingsPanel.message007")),
                  settings.ai.selectedModel && !llmConfig.models?.includes(settings.ai.selectedModel) && h('option', { value: settings.ai.selectedModel }, settings.ai.selectedModel),
                  (llmConfig.models || []).map(model => h('option', { key: model, value: model }, model))
                ),
                h('span', { className: 'rh-settings-provider', title: t("common.provider") }, llmConfig.provider)
              )
      ),
      h(PromptManager, {
        key: workspaceId,
        registry: promptRegistry, error: promptError, onRetry: loadPromptRegistry,
        prompts: settings.ai.prompts, skillBindings: settings.ai.skillBindings,
        skills: availableSkills, disabled: savedSettings === null,
        onChange: handlePromptChange, onBindSkill: handleSkillBindingChange,
        onReset: handleResetPrompt, onPreviewSkill: handlePreviewSkill,
      }),
      h('div', { className: 'rh-op-actions rh-settings-actions' },
        h('span', { className: message?.type === 'error' ? 'rh-error' : 'rh-prompt-description', role: 'status' },
          saving ? t("SettingsPanel.message008") : message?.type === 'error' ? message.text : dirty ? t("SettingsPanel.message009") : message?.text || ''
        ),
        h(Button, { type: 'button', className: 'rh-btn rh-btn-secondary', onClick: onClose }, t("common.close")),
        h(Button, { type: 'button', className: 'rh-btn rh-btn-primary', onClick: handleSave, disabled: saving || !dirty }, saving ? t("SettingsPanel.message008") : t("common.save"))
      )
    )
  );
}

module.exports = { SettingsPanel };
