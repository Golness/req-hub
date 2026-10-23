'use strict';

const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('./shared/HeaderBack.js');
const { useState, useEffect, useRef, useLayoutEffect } = React;
const { ROUTE, MARKED_SCRIPT_ID, MERMAID_SCRIPT_ID, HIGHLIGHT_SCRIPT_ID } = require('../constants.js');
const { createIconComponents } = require('../icons.js');
const { useScript } = require('../hooks/useScript.js');
const { getMermaidTheme } = require('../utils/getMermaidTheme.js');
const { sanitizeHtml } = require('../utils/sanitizeHtml.js');
const { Spinner } = require('./Spinner.js');
const { PromptManager } = require('./PromptManager.js');

const { IconLink } = createIconComponents(h);

// ─── SkillPreview (Markdown + Mermaid) ───────────────
/**
 * @component
 * Renders a skill's Markdown content with Mermaid diagram and syntax highlighting support.
 * Fetches skill content from the server, parses Markdown using the marked library,
 * renders Mermaid diagrams, and applies code highlighting via highlight.js.
 * Includes a header with a back button and skill name/description.
 * @param {Object} props - Component props
 * @param {string} props.skillName - The name of the skill to load and display
 * @param {string} props.workspaceId - The workspace ID for fetching skill content
 * @param {Function} props.onBack - Callback invoked when the back button is clicked
 * @returns {JSX.Element}
 */
function SkillPreview({ skillName, workspaceId, onBack }) {
  const [text, setText] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState(null);
  const [rendered, setRendered] = useState('');
  const markdownRef = useRef(null);
  const mermaidInitRef = useRef(false);
  const mermaidRenderIdRef = useRef(0);

  const { loaded: markedLoaded } = useScript(
    'https://cdn.jsdelivr.net/npm/marked/marked.min.js', MARKED_SCRIPT_ID, 'marked',
  );
  const { loaded: mermaidLoaded } = useScript(
    'https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js', MERMAID_SCRIPT_ID, 'mermaid',
  );
  const { loaded: hljsLoaded } = useScript(
    'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js', HIGHLIGHT_SCRIPT_ID, 'hljs',
  );

  useEffect(() => {
    if (!document.getElementById('req-hub-hljs-css')) {
      const link = document.createElement('link');
      link.id = 'req-hub-hljs-css';
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-dark.min.css';
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 获取 sessionId
        let sessionId = '';
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

        const url = sessionId
          ? `${ROUTE}/skill-content?name=${encodeURIComponent(skillName)}&workspaceId=${encodeURIComponent(workspaceId || '')}&sessionId=${encodeURIComponent(sessionId)}`
          : `${ROUTE}/skill-content?name=${encodeURIComponent(skillName)}&workspaceId=${encodeURIComponent(workspaceId || '')}`;

        const res = await fetch(url);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || 'load failed');
        else {
          setText(data.content || '');
          setDescription(data.description || '');
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [skillName, workspaceId]);

  useEffect(() => {
    if (mermaidLoaded && window.mermaid && !mermaidInitRef.current) {
      mermaidInitRef.current = true;
      window.mermaid.initialize({ startOnLoad: false, theme: getMermaidTheme(), securityLevel: 'strict' });
    }
  }, [mermaidLoaded]);

  useEffect(() => {
    if (!mermaidInitRef.current || !window.mermaid || !rendered) return;
    const observer = new MutationObserver(() => {
      const newTheme = getMermaidTheme();
      window.mermaid.initialize({ startOnLoad: false, theme: newTheme, securityLevel: 'strict' });
      if (markdownRef.current) {
        markdownRef.current.querySelectorAll('.mermaid-diagram').forEach(div => {
          const code = div.getAttribute('data-mermaid-code');
          if (code) {
            const id = `mermaid-rerender-${Date.now()}-${Math.random()}`;
            window.mermaid.render(id, code).then(({ svg }) => { div.innerHTML = svg; }).catch(() => {});
          }
        });
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, [rendered]);

  useEffect(() => {
    if (!text) { setRendered(''); return; }
    if (markedLoaded && window.marked) {
      setRendered(sanitizeHtml(window.marked.parse(text)));
    }
  }, [text, markedLoaded]);

  useLayoutEffect(() => {
    if (!mermaidInitRef.current || !rendered || !markdownRef.current) return;
    const mermaidBlocks = markdownRef.current.querySelectorAll('code.language-mermaid');
    if (mermaidBlocks.length === 0) return;
    mermaidRenderIdRef.current++;
    const prefix = `mermaid-skill-${mermaidRenderIdRef.current}`;
    mermaidBlocks.forEach(async (block, index) => {
      const pre = block.parentElement;
      const code = block.textContent;
      const id = `${prefix}-${index}`;
      try {
        const { svg } = await window.mermaid.render(id, code);
        const div = document.createElement('div');
        div.className = 'mermaid-diagram';
        div.setAttribute('data-mermaid-code', code);
        div.innerHTML = svg;
        pre.replaceWith(div);
      } catch (e) { /* keep original */ }
    });
  }, [rendered]);

  useLayoutEffect(() => {
    if (!hljsLoaded || !window.hljs || !rendered || !markdownRef.current) return;
    const codeBlocks = markdownRef.current.querySelectorAll('pre code:not(.language-mermaid)');
    if (codeBlocks.length === 0) return;
    codeBlocks.forEach(block => {
      window.hljs.highlightElement(block);
    });
  }, [rendered, hljsLoaded]);

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--dsw-alias-bg-base)' } },
    // Header with back button
    h('div', { style: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)'
    }},
      h(HeaderBack, { onBack: onBack, label: '返回设置' }),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontWeight: 600, fontSize: 'var(--rh-font-size)', display: 'flex', alignItems: 'center', gap: 4 } }, h(IconLink, { size: 14 }), ` ${skillName}`),
        description && h('div', { style: { fontSize: 'var(--rh-font-size-sm)', color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, description)
      )
    ),
    // Content
    h('div', { className: 'rh-preview-body', style: { flex: 1, overflow: 'auto' } },
      error ? h('span', { className: 'rh-error' }, 'Error: ', error)
        : text
          ? (markedLoaded && rendered)
            ? h('div', { ref: markdownRef, className: 'rh-markdown', dangerouslySetInnerHTML: { __html: rendered } })
            : h(Spinner)
          : h(Spinner)
    )
  );
}

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
          setMessage({ type: 'error', text: '设置加载失败，请重新打开' });
        }
      } catch (err) { setMessage({ type: 'error', text: '设置加载失败，请重新打开' }); }

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
        setMessage({ type: 'success', text: '已保存' });
      } else {
        setMessage({ type: 'error', text: '保存失败' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: '保存失败: ' + err.message });
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
    h('div', { className: 'rh-op-panel rh-settings-panel', style: previewingSkill ? { display: 'none' } : undefined },
      h('div', { className: 'rh-settings-model' },
        h('label', { htmlFor: 'rh-settings-model', className: 'rh-form-label' }, '模型'),
        llmConfig?.error
          ? h('span', { className: 'rh-error', role: 'alert' }, '模型加载失败')
          : !llmConfig
            ? h('span', { className: 'rh-prompt-description' }, '加载中…')
            : h(React.Fragment, null,
                h('select', {
                  id: 'rh-settings-model', className: 'rh-form-select',
                  value: settings.ai.selectedModel, disabled: savedSettings === null,
                  onChange: event => setSettings(prev => ({ ...prev, ai: { ...prev.ai, selectedModel: event.target.value } })),
                },
                  !llmConfig.models?.length && h('option', { value: '' }, '暂无模型'),
                  settings.ai.selectedModel && !llmConfig.models?.includes(settings.ai.selectedModel) && h('option', { value: settings.ai.selectedModel }, settings.ai.selectedModel),
                  (llmConfig.models || []).map(model => h('option', { key: model, value: model }, model))
                ),
                h('span', { className: 'rh-settings-provider', title: 'Provider' }, llmConfig.provider)
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
          saving ? '保存中…' : message?.type === 'error' ? message.text : dirty ? '未保存' : message?.text || ''
        ),
        h('button', { type: 'button', className: 'rh-btn rh-btn-secondary', onClick: onClose }, '关闭'),
        h('button', { type: 'button', className: 'rh-btn rh-btn-primary', onClick: handleSave, disabled: saving || !dirty }, saving ? '保存中…' : '保存')
      )
    )
  );
}

module.exports = { SettingsPanel };
