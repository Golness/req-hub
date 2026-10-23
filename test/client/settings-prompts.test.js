// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROMPT_REGISTRY } from '../../src/server/prompts.js';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { SettingsPanel } = require('../../src/client/components/SettingsPanel.js');
const { DocsViewerContext } = require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let config;
let failSave;
let failRegistry;
let fetchMock;

beforeEach(() => {
  config = { ai: { selectedModel: 'model', prompts: {}, skillBindings: {} } };
  failSave = false;
  failRegistry = false;
  fetchMock = vi.fn(async (url, options) => {
    let data;
    let ok = true;
    if (url.endsWith('/config')) {
      if (options?.method === 'POST') {
        ok = !failSave;
        if (ok) {
          const incoming = JSON.parse(options.body);
          config.ai = { ...config.ai, ...incoming.ai, prompts: { ...config.ai.prompts, ...incoming.ai.prompts } };
        }
      }
      data = structuredClone(config);
    } else if (url.endsWith('/llm-config')) data = { provider: 'Provider', models: ['model'] };
    else if (url.endsWith('/prompt-registry')) { data = PROMPT_REGISTRY; ok = !failRegistry; }
    else if (url.includes('/skill-content?')) data = { content: '# Skill', description: '' };
    else if (url.includes('/skills?')) data = { skills: [{ name: 'review', description: 'Review skill' }] };
    else throw new Error(`Unexpected request: ${url}`);
    return { ok, status: ok ? 200 : 500, json: async () => data };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderSettings() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const header = document.createElement('header');
  document.body.prepend(header);
  await act(async () => root.render(React.createElement(DocsViewerContext.Provider, { value: { headerBackTarget: header } },
    React.createElement(SettingsPanel, { workspaceId: 'ws', onClose: vi.fn() }))));
}

const click = async element => act(async () => element.click());
const tab = name => [...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.startsWith(name));
const prompt = name => [...document.querySelectorAll('.rh-prompt-item')].find(el => el.textContent === name);
const save = () => document.querySelector('.rh-settings-actions .rh-btn-primary');
async function edit(value) {
  const textarea = document.querySelector('.rh-prompt-textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('groups every registered prompt by rail feature and supports keyboard tabs', async () => {
  await renderSettings();
  expect([...document.querySelectorAll('[role="tab"]')].map(el => el.textContent)).toEqual(['同步10', '工作台2', '模板1']);
  expect(document.querySelectorAll('.rh-prompt-item')).toHaveLength(10);
  expect(document.querySelectorAll('textarea')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Prompt 结构说明');
  expect(document.querySelector('.rh-prompt-reference').open).toBe(false);
  expect(save().disabled).toBe(true);
  await act(async () => tab('同步').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(document.activeElement).toBe(tab('工作台'));
  expect(document.querySelectorAll('.rh-prompt-item')).toHaveLength(2);
  expect(document.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby')).toBe(tab('工作台').id);
  await click(tab('模板'));
  expect(prompt('模板生成')).toBeTruthy();
});

it('retains drafts and selections across categories, inserts variables, and saves all drafts', async () => {
  await renderSettings();
  await click(tab('工作台'));
  await edit('分析草稿 {requirementId} {docsContent}');
  await click(prompt('AI 语义搜索'));
  await edit('搜索草稿 {query} {requirementsSummary}');
  await click(tab('同步'));
  await click(tab('工作台'));
  expect(document.querySelector('textarea').value).toContain('搜索草稿');
  await click(prompt('需求分析'));
  expect(document.querySelector('textarea').value).toContain('分析草稿');
  await edit('');
  expect(document.querySelector('textarea').value).toBe('');
  await click(document.querySelector('.rh-prompt-reference summary'));
  await click(document.querySelector('.rh-prompt-variable'));
  expect(document.querySelector('textarea').value).toBe('{requirementId}');
  await edit('分析草稿 {requirementId} {docsContent}');
  await click(save());
  expect(config.ai.prompts.analyze).toContain('分析草稿');
  expect(config.ai.prompts.search).toContain('搜索草稿');
  expect(save().disabled).toBe(true);
  expect(document.querySelector('.rh-settings-actions').textContent).toContain('已保存');
});

it('preserves the editor when returning from a skill preview', async () => {
  await renderSettings();
  await click(tab('工作台'));
  await click(prompt('AI 语义搜索'));
  await edit('搜索草稿');
  const select = document.querySelector('.rh-prompt-skill select');
  await act(async () => { select.value = 'review'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click([...document.querySelectorAll('.rh-prompt-skill button')][0]);
  expect(document.querySelector('.rh-settings-panel').style.display).toBe('none');
  expect(document.querySelectorAll('header .rh-header-back')).toHaveLength(1);
  expect(document.querySelector('.rh-preview .rh-header-back')).toBeNull();
  await click(document.querySelector('header [aria-label="返回设置"]'));
  expect(document.querySelector('header').childElementCount).toBe(0);
  expect(document.querySelector('.rh-settings-panel').style.display).toBe('');
  expect(tab('工作台').getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('textarea').value).toBe('搜索草稿');
});

it('persists reset through the merging config API and retains drafts on save failure', async () => {
  config.ai.prompts.analyze = '旧自定义内容';
  config.ai.skillBindings.analyze = 'review';
  await renderSettings();
  await click(tab('工作台'));
  await click(document.querySelector('.rh-prompt-editor-heading button'));
  expect(document.querySelector('textarea').value).toBe(PROMPT_REGISTRY.analyze.default);
  expect(document.querySelector('.rh-prompt-skill select').value).toBe('');
  failSave = true;
  await click(save());
  expect(document.querySelector('.rh-settings-actions').textContent).toContain('保存失败');
  expect(save().disabled).toBe(false);
  failSave = false;
  await click(save());
  expect(config.ai.prompts.analyze).toBe('');
  expect(config.ai.skillBindings.analyze).toBeNull();
  await act(async () => root.unmount());
  root = null;
  await renderSettings();
  await click(tab('工作台'));
  expect(document.querySelector('textarea').value).toBe(PROMPT_REGISTRY.analyze.default);
});

it('retries prompt registry failures without losing loaded settings', async () => {
  failRegistry = true;
  await renderSettings();
  expect(document.querySelector('[role="alert"]').textContent).toContain('Prompt 加载失败');
  failRegistry = false;
  await click([...document.querySelectorAll('button')].find(el => el.textContent === '重试'));
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(3);
  expect(save().disabled).toBe(true);
});
