'use strict';
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const { Select } = require('./shared/Select.js');
const h = React.createElement;
const { useState, useRef, useId } = React;

// Follow the rail order. Features without prompts do not need empty tabs.
const CATEGORIES = [
  { id: 'create', label: t("DocsViewerBody.message051") },
  { id: 'sync', label: t("DocsViewerBody.message052") },
  { id: 'view', label: t("DocsViewerBody.message053") },
  { id: 'trace', label: t("PromptManager.message001") },
  { id: 'writing', label: t("DocsViewerBody.message056") },
  { id: 'other', label: t("FileTreeSidebar.message021") },
];

function getPromptCategory(key, meta) {
  if (key.startsWith('phased-') || meta.category === 'phased-sync') return 'sync';
  return CATEGORIES.some(category => category.id === meta.category) ? meta.category : 'other';
}

function PromptManager({ registry, error, onRetry, prompts, skillBindings, skills, disabled, onChange, onBindSkill, onReset, onPreviewSkill }) {
  const [categoryId, setCategoryId] = useState('sync');
  const [selectedKeys, setSelectedKeys] = useState({});
  const [drafts, setDrafts] = useState({});
  const editorRef = useRef(null);
  const id = useId();
  const categories = CATEGORIES.map(category => ({
    ...category,
    entries: Object.entries(registry || {}).filter(([key, meta]) => getPromptCategory(key, meta) === category.id),
  })).filter(category => category.entries.length);
  const category = categories.find(item => item.id === categoryId) || categories[0];
  const selected = category?.entries.find(([key]) => key === selectedKeys[category.id]) || category?.entries[0];

  const selectCategory = nextId => setCategoryId(nextId);
  const updateDraft = (key, value) => {
    setDrafts(prev => ({ ...prev, [key]: value }));
    onChange(key, value);
  };

  return h('section', { className: 'rh-prompt-manager', 'aria-label': t("PromptManager.message002") },
    h('div', { className: 'rh-prompt-section-title' }, t("PromptManager.message002")),
    error ? h('div', { className: 'rh-prompt-empty', role: 'alert' },
      h('span', null, t("PromptManager.message003")),
      h(Button, { className: 'rh-btn rh-btn-sm', onClick: onRetry, type: 'button' }, t("common.retry"))
    ) : !registry ? h('div', { className: 'rh-prompt-empty', role: 'status' }, t("common.loadingEllipsis"))
      : !selected ? h('div', { className: 'rh-prompt-empty' }, t("PromptManager.message006"))
      : h(React.Fragment, null,
        h('div', { className: 'rh-workbench-tabs rh-prompt-tabs', role: 'tablist', 'aria-label': t("PromptManager.message007") },
          categories.map(item => h('button', {
            key: item.id,
            id: `${id}-tab-${item.id}`,
            type: 'button',
            role: 'tab',
            className: 'rh-workbench-tab',
            'aria-selected': category.id === item.id,
            'aria-controls': `${id}-panel`,
            tabIndex: category.id === item.id ? 0 : -1,
            onClick: () => selectCategory(item.id),
            onKeyDown: event => {
              const index = categories.indexOf(item);
              const next = event.key === 'ArrowRight' ? (index + 1) % categories.length
                : event.key === 'ArrowLeft' ? (index + categories.length - 1) % categories.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              selectCategory(categories[next].id);
              event.currentTarget.parentElement.children[next].focus();
            },
          }, item.label, h('span', { className: 'rh-prompt-count' }, item.entries.length)))
        ),
        h('div', { className: 'rh-prompt-workspace', role: 'tabpanel', id: `${id}-panel`, 'aria-labelledby': `${id}-tab-${category.id}` },
          h(Select, {
            className: 'rh-form-select rh-prompt-picker', 'aria-label': t("PromptManager.message008"), value: selected[0],
            onChange: event => setSelectedKeys(prev => ({ ...prev, [category.id]: event.target.value })),
          }, category.entries.map(([key, meta]) => h('option', { key, value: key }, meta.label))),
          h('nav', { className: 'rh-prompt-list', 'aria-label': `${category.label} Prompt` },
            category.entries.map(([key, meta]) => h('button', {
              key,
              className: `rh-prompt-item${selected[0] === key ? ' active' : ''}`,
              type: 'button',
              'aria-current': selected[0] === key ? 'true' : undefined,
              onClick: () => setSelectedKeys(prev => ({ ...prev, [category.id]: key })),
            },
              h('span', null, meta.label),
              ((prompts[key]?.trim() && prompts[key] !== meta.default) || skillBindings[key]) && h('span', { className: 'rh-prompt-dot', title: t("PromptManager.message009"), 'aria-label': t("PromptManager.message009") })
            ))
          ),
          (() => {
            const [key, meta] = selected;
            const custom = prompts[key] || '';
            const value = Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : custom || meta.default || '';
            const binding = skillBindings[key] || '';
            const customized = !!custom.trim() && custom !== meta.default;
            const missing = customized ? (meta.variables || []).filter(variable => variable.required && !value.includes(`{${variable.name}}`)) : [];
            return h('fieldset', { className: 'rh-prompt-editor', disabled, key },
              h('div', { className: 'rh-prompt-editor-heading' },
                h('label', { htmlFor: `${id}-editor`, className: 'rh-prompt-name' }, meta.label),
                h('span', { className: 'rh-prompt-status' }, customized ? t("PromptManager.message010") : t("FileTreeSidebar.message024")),
                h(Button, {
                  type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm',
                  disabled: !custom && !binding && !Object.prototype.hasOwnProperty.call(drafts, key),
                  title: t("PromptManager.message011"),
                  onClick: () => {
                    setDrafts(prev => { const next = { ...prev }; delete next[key]; return next; });
                    onReset(key);
                  },
                }, t("PromptManager.message012"))
              ),
              meta.description && h('p', { className: 'rh-prompt-description' }, meta.description),
              h('div', { className: 'rh-prompt-skill' },
                h('label', { htmlFor: `${id}-skill` }, t("common.skillLabel")),
                h(Select, {
                  id: `${id}-skill`, className: 'rh-form-select', value: binding,
                  'aria-label': t("common.skillLabel"), searchable: true, searchPlaceholder: t("PromptManager.message013"),
                  onChange: event => onBindSkill(key, event.target.value),
                },
                  h('option', { value: '' }, t("PromptManager.message014")),
                  binding && !skills.some(skill => skill.name === binding) && h('option', { value: binding }, t("PromptManager.message015", { value0: binding })),
                  skills.map(skill => h('option', { key: skill.name, value: skill.name, title: skill.description }, skill.name))
                ),
                binding && h(Button, { type: 'button', className: 'rh-btn rh-btn-sm', onClick: () => onPreviewSkill(binding) }, t("PromptManager.message016"))
              ),
              h('textarea', {
                ref: editorRef, id: `${id}-editor`, className: 'rh-form-textarea rh-prompt-textarea',
                value, onChange: event => updateDraft(key, event.target.value),
                spellCheck: false, placeholder: t("PromptManager.message017"),
                'aria-describedby': missing.length ? `${id}-warning` : undefined,
              }),
              missing.length > 0 && h('div', { id: `${id}-warning`, className: 'rh-prompt-warning', role: 'status' },
                t("PromptManager.message018", { value0: missing.map(variable => `{${variable.name}}`).join('、') })
              ),
              h('details', { className: 'rh-prompt-reference', key: `${key}-reference` },
                h('summary', null, t("PromptManager.message019"), meta.outputFormat ? ` · ${meta.outputFormat}` : ''),
                h('div', { className: 'rh-prompt-variables' }, (meta.variables || []).map(variable => h(Button, {
                  key: variable.name, type: 'button', className: 'rh-btn rh-btn-sm rh-prompt-variable',
                  title: t("PromptManager.message021", { value0: variable.description || variable.name, value1: variable.required ? t("PromptManager.message020") : '' }),
                  onClick: () => {
                    const editor = editorRef.current;
                    const start = editor.selectionStart;
                    const end = editor.selectionEnd;
                    const token = `{${variable.name}}`;
                    updateDraft(key, value.slice(0, start) + token + value.slice(end));
                    requestAnimationFrame(() => {
                      if (editorRef.current !== editor) return;
                      editor.focus();
                      editor.setSelectionRange(start + token.length, start + token.length);
                    });
                  },
                }, `{${variable.name}}`))),
                meta.requirements?.length > 0 && h('ul', null, meta.requirements.map((requirement, index) => h('li', { key: index }, requirement)))
              )
            );
          })()
        )
      )
  );
}

module.exports = { PromptManager, getPromptCategory };
