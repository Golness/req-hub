// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROMPT_REGISTRY } from '../../src/server/prompts.js';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { SettingsPanel } = require('../../src/client/components/SettingsPanel.js');
const { DocsViewerContext, SessionSelectionContext } = require('../../src/client/context.js');
const { currentUiLanguage, setUiLanguage } = require('../../src/client/ui-language.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let config;
let failSave;
let failRegistry;
let fetchMock;

beforeEach(() => {
  config = {
    ai: {
      selectedModel: 'model',
      prompts: {},
      skillBindings: {},
      syncV2: { prompts: {}, skillBindings: {} },
    },
  };
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
          config.general = incoming.general;
          config.defaultUsername = incoming.defaultUsername;
          config.ai = {
            ...config.ai,
            ...incoming.ai,
            prompts: { ...config.ai.prompts, ...incoming.ai.prompts },
          };
        }
      }
      data = structuredClone(config);
    } else if (url.endsWith('/workspaces')) {
      data = [{ id: 'ws', title: 'Workspace', path: '/workspace' }];
    } else if (url.endsWith('/lark/target-options')) {
      data = { items: [], hasMore: false, pageToken: '' };
    } else if (url.endsWith('/lark/target-get')) {
      data = { binding: null, revision: null, workspaceTitle: 'Workspace' };
    } else if (url.endsWith('/llm-config')) data = { provider: 'Provider', models: ['model'] };
    else if (url.includes('/knowledge/enhancements/jobs'))
      data = { enabled: false, jobs: [], mcpServers: [], mcpAvailable: false };
    else if (url.includes('/knowledge-v2/rules') && options?.method === 'POST') {
      data = { rules: { purpose: '', schema: '', language: 'auto' }, job: null };
    } else if (url.includes('/knowledge-v2/rules')) {
      data = { purpose: '', schema: '', language: 'auto' };
    } else if (url.includes('/knowledge-v2/settings')) {
      data = {
        values: {
          autoManage: false,
          autoManageDelayMs: 30000,
          dailyUpdateEnabled: false,
          dailyImportConversations: false,
          dailyUpdateTime: '02:00',
          larkPushEnabled: false,
        },
        version: 'settings-v1',
        schedule: { state: 'idle', lastRunAt: null },
      };
    } else if (url.endsWith('/prompt-registry')) {
      data = PROMPT_REGISTRY;
      ok = !failRegistry;
    } else if (url.includes('/skill-content?')) data = { content: '# Skill', description: '' };
    else if (url.includes('/skills?'))
      data = { skills: [{ name: 'review', description: 'Review skill' }] };
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
  setUiLanguage('follow');
});

async function renderSettings(sessionId = null, initialTab = 'prompts', settingsProps = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const header = document.createElement('header');
  document.body.prepend(header);
  await act(async () =>
    root.render(
      React.createElement(
        SessionSelectionContext.Provider,
        { value: () => sessionId },
        React.createElement(
          DocsViewerContext.Provider,
          { value: { headerBackTarget: header } },
          React.createElement(SettingsPanel, {
            workspaceId: 'ws',
            onClose: vi.fn(),
            ...settingsProps,
          }),
        ),
      ),
    ),
  );
  if (initialTab === 'prompts') {
    await act(async () => document.querySelector('#settings-tab-prompts').click());
  }
}

const click = async (element) => act(async () => element.click());
const tab = (name) =>
  [...document.querySelectorAll('.rh-prompt-tabs [role="tab"]')].find((el) =>
    el.textContent.startsWith(name),
  );
const prompt = (name) =>
  [...document.querySelectorAll('.rh-prompt-item')].find((el) => el.textContent === name);
const save = () => document.querySelector('.rh-settings-actions .rh-btn-primary');
it('loads, edits and saves the shared subagent limit from model settings', async () => {
  config.ai.delegation = { maxConcurrency: 5 };
  await renderSettings(null, 'general');
  const advanced = [...document.querySelectorAll('[data-rh-disclosure-trigger]')].find(
    (node) => node.textContent === '高级设置',
  );
  expect(advanced.getAttribute('aria-expanded')).toBe('false');
  await click(advanced);
  const input = document.querySelector('#rh-subagent-concurrency');
  expect(input.value).toBe('5');
  expect(input.min).toBe('1');
  expect(input.max).toBe('16');
  const title = document.getElementById(input.getAttribute('aria-labelledby'));
  const help = title.parentElement.querySelector('button');
  expect(title.textContent).toBe('子代理并发数');
  expect(title.tagName).toBe('SPAN');
  expect(input.closest('label')).toBeNull();
  expect(document.querySelector('label[for="rh-subagent-concurrency"]')).toBeNull();
  const activated = vi.fn();
  input.addEventListener('click', activated);
  await click(title);
  await click(help);
  expect(activated).not.toHaveBeenCalled();
  expect(input.value).toBe('5');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      '4',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(save());
  expect(config.ai.delegation.maxConcurrency).toBe(4);
  expect(fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')[1].body).toContain(
    '"maxConcurrency":4',
  );
});
async function edit(value) {
  const textarea = document.querySelector('.rh-prompt-textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('saves the general clock and applies it only after persistence succeeds', async () => {
  const clock = require('../../src/client/time.js');
  await renderSettings(null, 'general');
  expect(document.querySelector('#settings-tab-general').textContent).toBe('通用');
  const zone = document.querySelector('[aria-labelledby="rh-time-zone-title"]');
  await click(zone);
  await click(document.querySelector('[role="menuitem"][data-value="UTC"]'));
  expect(clock.formatTime('2026-11-06T03:41:54Z')).toBe('11:41:54');
  failSave = true;
  await click(save());
  expect(clock.formatTime('2026-11-06T03:41:54Z')).toBe('11:41:54');
  failSave = false;
  await click(save());
  expect(config.general).toMatchObject({ timeZone: 'UTC' });
  expect(clock.formatTime('2026-11-06T03:41:54Z')).toBe('03:41:54');
});

it('saves the shared username, execution deadline and knowledge budgets from General', async () => {
  await renderSettings(null, 'general');
  await click(
    [...document.querySelectorAll('[data-rh-disclosure-trigger]')].find(
      (node) => node.textContent === '高级设置',
    ),
  );
  const editInput = async (labelId, value) =>
    act(async () => {
      const input = document.querySelector(`input[aria-labelledby="${labelId}"]`);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
        input,
        value,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await editInput('rh-default-username-title', 'alice');
  await editInput('rh-general-taskTimeoutMs-title', '29');
  expect(save().disabled).toBe(true);
  await editInput('rh-general-taskTimeoutMs-title', '90');
  await editInput('rh-general-knowledgeMaxInputBytes-title', '8.001');
  await editInput('rh-general-knowledgeMaxResultBytes-title', '3');
  await click(save());
  expect(config.defaultUsername).toBe('alice');
  expect(config.general).toMatchObject({
    taskTimeoutMs: 90000,
    knowledgeMaxInputBytes: 8001,
    knowledgeMaxResultBytes: 3000,
  });
});

it('groups every registered prompt by rail feature and supports keyboard tabs', async () => {
  await renderSettings();
  expect(
    [...document.querySelectorAll('.rh-prompt-tabs [role="tab"]')].map((el) => el.textContent),
  ).toEqual(['同步10', '知识库5', '写作1']);
  expect(document.querySelectorAll('.rh-prompt-item')).toHaveLength(10);
  expect(document.querySelectorAll('textarea')).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Prompt 结构说明');
  expect(
    document
      .querySelector('.rh-prompt-reference [data-rh-disclosure-trigger]')
      .getAttribute('aria-expanded'),
  ).toBe('false');
  expect(save().disabled).toBe(true);
  await act(async () =>
    tab('同步').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(document.activeElement).toBe(tab('写作'));
  expect(document.querySelectorAll('.rh-prompt-item')).toHaveLength(1);
  expect(document.querySelector('.rh-prompt-workspace').getAttribute('aria-labelledby')).toBe(
    tab('写作').id,
  );
  await click(tab('写作'));
  expect(prompt('文档优化')).toBeTruthy();
});

it('retains drafts and selections across categories, inserts variables, and saves all drafts', async () => {
  await renderSettings();
  await click(tab('同步'));
  await click(prompt('代码差异分析（需求文档）'));
  await edit('分析草稿 {runtimeId} {manifestId}');
  await click(tab('写作'));
  await edit('写作草稿 {runtimeId} {docTypeName} {scopes} {instruction} {content}');
  await click(tab('同步'));
  await click(tab('写作'));
  expect(document.querySelector('textarea').value).toContain('写作草稿');
  await click(tab('同步'));
  await click(prompt('代码差异分析（需求文档）'));
  expect(document.querySelector('textarea').value).toContain('分析草稿');
  await edit('');
  expect(document.querySelector('textarea').value).toBe('');
  await click(document.querySelector('.rh-prompt-reference [data-rh-disclosure-trigger]'));
  await click(document.querySelector('.rh-prompt-variable'));
  expect(document.querySelector('textarea').value).toBe('{runtimeId}');
  await edit('分析草稿 {runtimeId} {manifestId}');
  await click(save());
  expect(config.ai.syncV2.prompts['phased-code-analysis-requirement']).toContain('分析草稿');
  expect(config.ai.prompts.writing).toContain('写作草稿');
  expect(save().disabled).toBe(true);
  expect(document.querySelector('.rh-settings-actions').textContent).toContain('已保存');
});

it('preserves the editor when returning from a skill preview', async () => {
  await renderSettings();
  await click(tab('同步'));
  await click(prompt('代码差异分析（需求文档）'));
  await click(tab('写作'));
  await edit('写作草稿');
  await click(document.querySelector('.rh-prompt-skill .rh-select-trigger'));
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === 'review',
    ),
  );
  await click(
    [...document.querySelectorAll('.rh-prompt-skill button')].find(
      (button) => button.textContent === '预览 Skill',
    ),
  );
  expect(document.querySelector('.rh-settings-panel').hidden).toBe(true);
  expect(document.querySelectorAll('header .rh-header-back')).toHaveLength(0);
  expect(document.querySelector('.rh-preview .rh-header-back')).toBeNull();
  await click(document.querySelector('[aria-label="返回设置"]'));
  expect(document.querySelector('header').childElementCount).toBe(0);
  expect(document.querySelector('.rh-settings-panel').style.display).toBe('');
  expect(tab('写作').getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('textarea').value).toBe('写作草稿');
});

it('persists reset through the merging config API and retains drafts on save failure', async () => {
  config.ai.syncV2.prompts['phased-code-analysis-requirement'] = '旧自定义内容';
  config.ai.syncV2.skillBindings['phased-code-analysis-requirement'] = 'review';
  await renderSettings();
  await click(tab('同步'));
  await click(prompt('代码差异分析（需求文档）'));
  await click(document.querySelector('.rh-prompt-editor-heading button'));
  expect(document.querySelector('textarea').value).toBe(
    PROMPT_REGISTRY['phased-code-analysis-requirement'].default,
  );
  expect(document.querySelector('.rh-prompt-skill .rh-select-trigger').textContent).toBe('不绑定');
  failSave = true;
  await click(save());
  expect(document.querySelector('.rh-settings-actions').textContent).toContain('保存失败');
  expect(save().disabled).toBe(false);
  failSave = false;
  await click(save());
  expect(config.ai.syncV2.prompts['phased-code-analysis-requirement']).toBe('');
  expect(config.ai.syncV2.skillBindings['phased-code-analysis-requirement']).toBeNull();
  await act(async () => root.unmount());
  root = null;
  await renderSettings();
  await click(tab('同步'));
  await click(prompt('代码差异分析（需求文档）'));
  expect(document.querySelector('textarea').value).toBe(
    PROMPT_REGISTRY['phased-code-analysis-requirement'].default,
  );
});

it('retries prompt registry failures without losing loaded settings', async () => {
  failRegistry = true;
  await renderSettings();
  expect(document.querySelector('[role="alert"]').textContent).toContain('Prompt 加载失败');
  failRegistry = false;
  await click([...document.querySelectorAll('button')].find((el) => el.textContent === '重试'));
  expect(document.querySelectorAll('.rh-prompt-tabs [role="tab"]')).toHaveLength(3);
  expect(save().disabled).toBe(true);
});

it('shows the effective native binding and uses one session scope for config and skill discovery', async () => {
  config.ai.syncV2.skillBindings['phased-discussion-analysis-requirement'] = 'asd-ste100';
  const fallback = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (url, options) =>
    String(url).includes('/skills?')
      ? {
          ok: true,
          json: async () => ({
            skills: [{ name: 'asd-ste100', description: 'Native skill', userInvocable: true }],
          }),
        }
      : fallback(url, options),
  );
  await renderSettings('current-parent');
  await click(prompt('讨论差异分析（需求文档）'));
  expect(document.querySelector('.rh-prompt-skill .rh-select-trigger').textContent).toBe(
    'asd-ste100',
  );
  expect(document.body.textContent).toContain('默认加载 asd-ste100');
  const configRead = fetchMock.mock.calls.find(
    ([url, options]) => String(url).endsWith('/config') && !options?.method,
  );
  expect(configRead[1].headers).toMatchObject({
    'x-session-id': 'current-parent',
    'x-workspace-id': 'ws',
  });
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes('/skills?sessionId=current-parent')),
  ).toBe(true);
});

it('separates settings features and retains prompt drafts across top-level tabs', async () => {
  await renderSettings(null, 'general');
  const tabs = [...document.querySelectorAll('[aria-label="设置功能"] [role="tab"]')];
  expect(tabs.map((item) => item.textContent)).toEqual([
    '通用',
    '依赖',
    '同步',
    '知识库',
    'Prompt 管理',
  ]);
  expect(document.querySelector('#settings-tab-general').getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(document.querySelector('#settings-content-prompts').hidden).toBe(true);
  expect(document.querySelector('textarea')).toBeNull();
  expect(document.querySelectorAll('.rh-settings-panel button').length).toBeGreaterThan(0);
  await act(async () =>
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
  );
  expect(document.activeElement).toBe(document.querySelector('#settings-tab-prompts'));
  await click(tab('写作'));
  await edit('保留未保存的正文模板');
  await click(document.querySelector('#settings-tab-general'));
  expect(document.querySelector('#settings-content-prompts').hidden).toBe(true);
  expect(save().disabled).toBe(false);
  await click(document.querySelector('#settings-tab-prompts'));
  expect(document.querySelector('textarea').value).toBe('保留未保存的正文模板');
  expect(tab('写作').getAttribute('aria-selected')).toBe('true');
  await click(document.querySelector('#settings-tab-dependencies'));
  const dependencies = document.querySelector('#settings-content-dependencies');
  const dependencyTabs = [...dependencies.querySelectorAll('[role="tablist"] [role="tab"]')];
  expect(dependencyTabs.map((node) => node.textContent)).toEqual(['GitNexus', '飞书 CLI']);
  const gitnexusPanel = document.getElementById(dependencyTabs[0].getAttribute('aria-controls'));
  const larkPanel = document.getElementById(dependencyTabs[1].getAttribute('aria-controls'));
  expect(gitnexusPanel.hidden).toBe(false);
  expect(larkPanel.hidden).toBe(true);
  expect(larkPanel.querySelector('input')).toBeNull();
  await act(async () =>
    dependencyTabs[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(dependencyTabs[1]);
  expect(gitnexusPanel.hidden).toBe(true);
  expect(larkPanel.hidden).toBe(false);
  expect(larkPanel.textContent).toContain('发布到飞书');
  const advanced = dependencies.querySelector('[data-rh-disclosure-trigger]');
  await click(advanced);
  const profile = dependencies.querySelector('input[id$="-profile"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      profile,
      'draft',
    );
    profile.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(dependencyTabs[0]);
  expect(larkPanel.hidden).toBe(true);
  await click(dependencyTabs[1]);
  expect(larkPanel.querySelector('input[id$="-profile"]').value).toBe('draft');
  await click(document.querySelector('#settings-tab-general'));
  await click(document.querySelector('#settings-tab-dependencies'));
  expect(dependencyTabs[1].getAttribute('aria-selected')).toBe('true');
  expect(dependencies.querySelector('input[id$="-profile"]').value).toBe('draft');
});

it('hosts knowledge settings in its own tab and keeps drafts while switching', async () => {
  await renderSettings(null, 'general');
  const knowledgeTab = document.querySelector('#settings-tab-knowledge');
  expect(knowledgeTab.textContent).toBe('知识库');
  await click(knowledgeTab);
  const panel = document.querySelector('#settings-content-knowledge');
  expect(panel.hidden).toBe(false);
  expect(panel.getAttribute('aria-labelledby')).toBe('settings-tab-knowledge');
  expect(panel.textContent).toContain('自动整理与每日更新');
  expect(panel.textContent).toContain('整理规则');
  expect(panel.textContent).toContain('清空知识库');
  // Each section owns its save; this tab does not contribute a page-level action bar.
  expect(panel.querySelectorAll('[data-settings-actions="section"]')).toHaveLength(3);
  expect(document.querySelector('.rh-settings-actions')).toBeNull();
  const purpose = panel.querySelector('textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(
      purpose,
      '未保存的用途说明',
    );
    purpose.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(document.querySelector('#settings-tab-general'));
  expect(panel.hidden).toBe(true);
  await click(knowledgeTab);
  expect(panel.querySelector('textarea').value).toBe('未保存的用途说明');
});

it('notifies the owning view after knowledge rules are saved', async () => {
  const onKnowledgeChanged = vi.fn();
  await renderSettings(null, 'general', { onKnowledgeChanged });
  await click(document.querySelector('#settings-tab-knowledge'));
  const bars = document.querySelectorAll(
    '#settings-content-knowledge [data-settings-actions="section"]',
  );
  await click(bars[1].querySelector('button'));
  expect(onKnowledgeChanged).toHaveBeenCalledOnce();
});

it('loads the forced UI language into general settings and saves it back', async () => {
  config.general = { timeZone: 'Asia/Shanghai', uiLanguage: 'en' };
  await renderSettings(null, 'general');
  expect(document.getElementById('rh-ui-language-title')?.textContent).toBe('Interface language');
  expect(document.getElementById('rh-time-zone-title')?.textContent).toBe('Time zone');
  expect(currentUiLanguage()).toBe('en');
  const username = document.querySelector('[aria-labelledby="rh-default-username-title"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      username,
      'alice',
    );
    username.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(save());
  const posted = fetchMock.mock.calls.find(
    ([url, options]) => url.endsWith('/config') && options?.method === 'POST',
  );
  expect(JSON.parse(posted[1].body).general.uiLanguage).toBe('en');
});

it('keeps artifact language independent from UI language and saves it back', async () => {
  config.general = {
    timeZone: 'Asia/Shanghai',
    uiLanguage: 'en',
    contentLanguage: 'zh',
  };
  await renderSettings(null, 'general');
  const title = document.getElementById('rh-content-language-title');
  expect(title?.textContent).toBe('Artifact language');
  expect(document.getElementById('rh-ui-language-title')?.textContent).toBe('Interface language');
  const trigger = document.querySelector('[aria-labelledby="rh-content-language-title"]');
  expect(trigger).toBeTruthy();
  await click(trigger);
  await click(document.querySelector('[role="menuitem"][data-value="en"]'));
  await click(save());
  const posted = fetchMock.mock.calls.find(
    ([url, options]) => url.endsWith('/config') && options?.method === 'POST',
  );
  const general = JSON.parse(posted[1].body).general;
  expect(general.contentLanguage).toBe('en');
  expect(general.uiLanguage).toBe('en');
});
