'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useRef, useId } = React;

// Follow the rail order. Features without prompts do not need empty tabs.
const CATEGORIES = [
  { id: 'create', label: '新建' },
  { id: 'sync', label: '同步' },
  { id: 'view', label: '查看' },
  { id: 'trace', label: '追溯' },
  { id: 'workbench', label: '工作台' },
  { id: 'templates', label: '模板' },
  { id: 'other', label: '其他' },
];

function getPromptCategory(key, meta) {
  if (key.startsWith('phased-') || meta.category === 'phased-sync') return 'sync';
  if (key === 'analyze' || key === 'search' || meta.category === 'search') return 'workbench';
  if (key === 'template' || meta.category === 'template') return 'templates';
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

  return h('section', { className: 'rh-prompt-manager', 'aria-label': 'Prompt 管理' },
    h('div', { className: 'rh-prompt-section-title' }, 'Prompt 管理'),
    error ? h('div', { className: 'rh-prompt-empty', role: 'alert' },
      h('span', null, 'Prompt 加载失败'),
      h('button', { className: 'rh-btn rh-btn-sm', onClick: onRetry, type: 'button' }, '重试')
    ) : !registry ? h('div', { className: 'rh-prompt-empty', role: 'status' }, '加载中…')
      : !selected ? h('div', { className: 'rh-prompt-empty' }, '暂无 Prompt')
      : h(React.Fragment, null,
        h('div', { className: 'rh-workbench-tabs rh-prompt-tabs', role: 'tablist', 'aria-label': '功能分类' },
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
          h('select', {
            className: 'rh-form-select rh-prompt-picker', 'aria-label': '选择 Prompt', value: selected[0],
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
              ((prompts[key]?.trim() && prompts[key] !== meta.default) || skillBindings[key]) && h('span', { className: 'rh-prompt-dot', title: '已自定义', 'aria-label': '已自定义' })
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
                h('span', { className: 'rh-prompt-status' }, customized ? '自定义' : '默认'),
                h('button', {
                  type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm',
                  disabled: !custom && !binding && !Object.prototype.hasOwnProperty.call(drafts, key),
                  title: '恢复默认 Prompt 并解除 Skill 绑定',
                  onClick: () => {
                    setDrafts(prev => { const next = { ...prev }; delete next[key]; return next; });
                    onReset(key);
                  },
                }, '恢复默认')
              ),
              meta.description && h('p', { className: 'rh-prompt-description' }, meta.description),
              h('div', { className: 'rh-prompt-skill' },
                h('label', { htmlFor: `${id}-skill` }, 'Skill'),
                h('select', {
                  id: `${id}-skill`, className: 'rh-form-select', value: binding,
                  onChange: event => onBindSkill(key, event.target.value),
                },
                  h('option', { value: '' }, '不绑定'),
                  binding && !skills.some(skill => skill.name === binding) && h('option', { value: binding }, `${binding}（不可用）`),
                  skills.map(skill => h('option', { key: skill.name, value: skill.name, title: skill.description }, skill.name))
                ),
                binding && h('button', { type: 'button', className: 'rh-btn rh-btn-sm', onClick: () => onPreviewSkill(binding) }, '预览 Skill')
              ),
              h('textarea', {
                ref: editorRef, id: `${id}-editor`, className: 'rh-form-textarea rh-prompt-textarea',
                value, onChange: event => updateDraft(key, event.target.value),
                spellCheck: false, placeholder: '留空使用默认 Prompt',
                'aria-describedby': missing.length ? `${id}-warning` : undefined,
              }),
              missing.length > 0 && h('div', { id: `${id}-warning`, className: 'rh-prompt-warning', role: 'status' },
                `缺少变量：${missing.map(variable => `{${variable.name}}`).join('、')}`
              ),
              h('details', { className: 'rh-prompt-reference', key: `${key}-reference` },
                h('summary', null, '变量与输出', meta.outputFormat ? ` · ${meta.outputFormat}` : ''),
                h('div', { className: 'rh-prompt-variables' }, (meta.variables || []).map(variable => h('button', {
                  key: variable.name, type: 'button', className: 'rh-prompt-variable',
                  title: `${variable.description || variable.name}${variable.required ? '（必填）' : ''}，点击插入`,
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
