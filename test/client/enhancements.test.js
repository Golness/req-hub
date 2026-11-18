// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url),
  React = require('react'),
  { act } = React;
const { createRoot } = require('react-dom/client');
const {
  DocumentAssist,
  EnhancementSettings,
} = require('../../src/client/components/ContextAssist.js');
const {
  DocumentAssociationSettings,
} = require('../../src/client/components/DocumentAssociationSettings.js');
const { SessionSelectionContext } = require('../../src/client/context.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container, calls, context, kind, live;
const doc = { id: 'doc', scopeId: 'scope', version: 2 };
beforeEach(() => {
  calls = [];
  live = false;
  context = {
    enabled: true,
    indexed: true,
    documentRefs: [doc],
    related: [
      {
        id: 'related',
        scopeId: 'scope',
        version: 3,
        path: 'bob/req/design.md',
        title: 'Design',
        reasons: ['explicit_dependency'],
        confirmed: false,
      },
    ],
    graph: {
      id: 'revision',
      reviewSeq: 2,
      entities: [
        { id: 'a', key: 'alice/req', documents: [{ id: 'doc' }] },
        { id: 'b', key: 'bob/req', documents: [{ id: 'related' }] },
      ],
      relations: [
        {
          id: 'relation',
          sourceId: 'a',
          targetId: 'b',
          type: 'explicit_dependency',
          reviewState: 'candidate',
          validity: 'valid',
          basisHash: 'basis',
          evidence: [],
        },
      ],
      code: { status: 'stale' },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      const parsed = new URL(url, 'http://local'),
        body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path: parsed.pathname, body, params: parsed.searchParams });
      let value;
      if (parsed.pathname.endsWith('/context')) value = context;
      else if (parsed.pathname.endsWith('/config')) {
        if (body) context.enabled = body.enhancements.enabled;
        value = { enhancements: { enabled: context.enabled, gitnexusServer: 'gitnexus' } };
      } else if (parsed.pathname.endsWith('/jobs') && body) {
        kind = body.kind;
        value = { id: 'job', kind, status: 'queued' };
      } else if (parsed.pathname.endsWith('/jobs'))
        value = {
          enabled: context.enabled,
          jobs: [],
          graph: context.graph,
          mcpServer: 'gitnexus',
          mcpServers: ['gitnexus'],
          mcpAvailable: true,
        };
      else if (parsed.pathname.endsWith('/jobs/job'))
        value = {
          id: 'job',
          kind,
          status: live ? 'running' : 'completed',
          activity: { stage: 'index_running', percent: 42 },
          indexLogs: kind === 'code-index' ? ['Parsing files'] : undefined,
          result:
            kind === 'code-index'
              ? { code: { status: 'ready' }, indexUpdated: true }
              : kind === 'code-refresh'
                ? { code: { status: 'stale' } }
                : { findings: [] },
        };
      else if (parsed.pathname.endsWith('/reviews')) {
        context.graph.relations[0].reviewState = body.decision;
        value = context.graph;
      } else throw new Error('Unexpected request: ' + url);
      return { ok: true, json: async () => value };
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const click = (node) => act(async () => node.click());
const button = (text) =>
  [...document.querySelectorAll('button')].find((node) => node.textContent === text);
const render = (props) =>
  act(async () =>
    root.render(
      React.createElement(DocumentAssist, {
        workspaceId: 'w',
        path: 'alice/req/requirement.md',
        ...props,
      }),
    ),
  );
it('uses the current document without a picker or manual graph build, and navigates related sources', async () => {
  const onOpenSource = vi.fn();
  await render({ onOpenSource });
  expect(calls[0].params.get('path')).toBe('alice/req/requirement.md');
  expect(calls.every((call) => !call.body)).toBe(true);
  expect(button('构建文档关联')).toBeUndefined();
  await click(button('bob/req/design.md'));
  expect(onOpenSource).toHaveBeenCalledWith({
    relativePath: 'bob/req/design.md',
    workspaceId: 'w',
    title: 'Design',
  });
  await click(button('结构检查'));
  expect(calls.find((call) => call.body?.kind === 'quality-check').body.context).toEqual({
    path: 'alice/req/requirement.md',
  });
});
it('takes the current calling session through the scoped selection context', async () => {
  await act(async () =>
    root.render(
      React.createElement(
        SessionSelectionContext.Provider,
        { value: () => 'active-parent' },
        React.createElement(DocumentAssist, { workspaceId: 'w', path: 'alice/req/requirement.md' }),
      ),
    ),
  );
  await click(button('结构检查'));
  expect(calls.find((call) => call.body?.kind === 'quality-check').body.sessionId).toBe(
    'active-parent',
  );
});
it('passes the actual unsaved writing draft to checking and warns when it changes', async () => {
  await render({ mode: 'writing', draft: '# Current unsaved draft' });
  await click(button('结构检查'));
  expect(calls.find((call) => call.body?.kind).body.draft).toBe('# Current unsaved draft');
  await render({ mode: 'writing', draft: '# Edited again' });
  expect(container.textContent).toContain('正文已修改');
});
it('selects exact reference versions for sync without changing write targets or confirming candidates implicitly', async () => {
  const onReferencesChange = vi.fn();
  await render({ mode: 'sync', references: [], onReferencesChange });
  await click(container.querySelector('input[type=checkbox]'));
  expect(onReferencesChange).toHaveBeenCalledWith([
    { id: 'related', scopeId: 'scope', version: 3 },
  ]);
  expect(calls.some((call) => call.body)).toBe(false);
  expect(container.textContent).toContain('不会扩大写入范围');
  await click(button('已确认'));
  expect(calls.find((call) => call.path.endsWith('/reviews')).body).toMatchObject({
    expectedRevision: 'revision',
    expectedReviewSeq: 2,
    basisHash: 'basis',
    decision: 'confirmed',
  });
});
it('keeps the global switch out of GitNexus settings and displays actual index progress', async () => {
  await act(async () =>
    root.render(React.createElement(EnhancementSettings, { workspaceId: 'w' })),
  );
  expect(container.querySelector('section[aria-label="知识关联与代码索引"]')).not.toBeNull();
  expect(button('结构检查')).toBeUndefined();
  expect(container.querySelector('[role="switch"]')).toBeNull();
  live = true;
  await click(button('更新索引'));
  expect(calls.find((call) => call.body?.kind === 'code-index').body.context).toBeUndefined();
  expect(document.querySelector('[role="dialog"] progress').value).toBe(42);
  expect(document.querySelector('[role="dialog"]').textContent).toContain('Parsing files');
  live = false;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  expect(document.querySelector('[role="dialog"]').textContent).toContain('本机索引更新已完成');
  expect(container.querySelector('progress')).toBeNull();
});
it('keeps checks unavailable when the source is not imported, dirty or enhancement is disabled', async () => {
  context.enabled = false;
  context.indexed = false;
  context.documentRefs = [];
  await render();
  expect(button('结构检查').disabled).toBe(true);
  expect(container.textContent).toContain('设置中启用');
  context.enabled = true;
  context.documentRefs = [doc];
  await render({ dirty: true });
  expect(button('结构检查').disabled).toBe(true);
});

it('keeps status checks and local indexing independent of document associations', async () => {
  context.enabled = false;
  context.graph.code = { status: 'disabled' };
  await act(async () =>
    root.render(React.createElement(EnhancementSettings, { workspaceId: 'w' })),
  );
  expect(container.textContent).toContain('尚未检查');
  expect(container.textContent).not.toContain('未启用');
  expect(button('检查索引状态（MCP）').disabled).toBe(false);
  expect(button('更新索引').disabled).toBe(false);
  await click(button('检查索引状态（MCP）'));
  const operations = calls.filter((call) => call.body?.kind);
  expect(operations.map((call) => call.body.kind)).toEqual(['code-refresh']);
  expect(operations[0].body.context).toBeUndefined();
  expect(container.textContent).not.toContain('刷新代码关联');
});

it('places index execution in its own task section rather than under the index controls', async () => {
  live = true;
  await act(async () =>
    root.render(React.createElement(EnhancementSettings, { workspaceId: 'w' })),
  );
  await click(button('更新索引'));
  const sections = [...container.querySelectorAll('h3')];
  expect(sections.map((node) => node.textContent)).toEqual(['MCP 连接', '代码索引']);
  const controls = sections[1].closest('section');
  const task = document.querySelector('[role="dialog"]');
  expect(task).not.toBeNull();
  expect(container.contains(task)).toBe(false);
  expect(controls.contains(button('取消任务'))).toBe(false);
  expect(task.contains(button('取消任务'))).toBe(true);
  expect(task.querySelector('[role="status"]').textContent).toBe('执行中');
  const trigger = button('执行日志（最近 50 条）');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(task.querySelector('progress').value).toBe(42);
});

it('keeps index logs stable across updates and avoids an animated bar without a percentage', async () => {
  vi.useFakeTimers();
  const original = fetch.getMockImplementation();
  let logs = ['Parsing files'];
  fetch.mockImplementation(async (url, options = {}) => {
    if (new URL(url, 'http://local').pathname.endsWith('/jobs/job')) {
      return {
        ok: true,
        json: async () => ({
          id: 'job',
          kind: 'code-index',
          status: 'running',
          activity: { stage: 'index_running' },
          indexLogs: logs,
        }),
      };
    }
    return original(url, options);
  });
  try {
    await act(async () =>
      root.render(React.createElement(EnhancementSettings, { workspaceId: 'w' })),
    );
    await click(button('更新索引'));
    expect(container.querySelector('progress')).toBeNull();
    expect(document.querySelector('[role="dialog"]').textContent).toContain('正在更新索引');
    const trigger = button('执行日志（最近 50 条）');
    expect(trigger.querySelector('[data-icon="chevronRight"]')).not.toBeNull();
    const body = document.getElementById(trigger.getAttribute('aria-controls'));
    expect(body.hidden).toBe(true);
    await click(trigger);
    const log = body.querySelector('pre');
    log.scrollTop = 24;
    await click(trigger);
    expect(body.hidden).toBe(true);
    logs = ['Parsing files', 'Resolving symbols'];
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(body.hidden).toBe(true);
    await click(trigger);
    expect(body.querySelector('pre')).toBe(log);
    expect(log.scrollTop).toBe(24);
    expect(log.textContent).toContain('Resolving symbols');
    expect(trigger.querySelector('[data-icon="chevronDown"]')).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps related sources and checks in the document assistant without graph administration', async () => {
  const onOpenSource = vi.fn();
  await render({ assistant: true, onOpenSource });
  expect(container.textContent).toContain('相关资料');
  expect(container.textContent).toContain('检查文档');
  expect(container.textContent).not.toContain('高级关联操作');
  expect(container.textContent).not.toContain('影响查询深度');
  expect(container.textContent).not.toContain('GitNexus');
  expect(container.querySelector('input, select')).toBeNull();
  expect(calls.every((call) => !call.body)).toBe(true);
  expect(button('结构检查').closest('[role="region"]').getAttribute('aria-label')).toBe('检查文档');
  await click(button('Design'));
  expect(onOpenSource).toHaveBeenCalledWith({
    relativePath: 'bob/req/design.md',
    workspaceId: 'w',
    title: 'Design',
  });
  await click(button('结构检查'));
  expect(calls.find((call) => call.body?.kind === 'quality-check').body.context).toEqual({
    path: 'alice/req/requirement.md',
  });
  expect(
    document.querySelector('[role="dialog"][aria-label="检查文档"] [aria-label="增强任务"]'),
  ).not.toBeNull();
  expect(container.querySelector('[aria-label="增强任务"]')).toBeNull();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"][aria-label="检查文档"]')).toBeNull();
  await click(button('查看结果'));
  expect(
    document.querySelector('[role="dialog"][aria-label="检查文档"] [aria-label="增强任务"]'),
  ).not.toBeNull();
});

it('loads long related source lists incrementally and marks the same requirement at the item tail', async () => {
  const onOpenSource = vi.fn();
  context.related = Array.from({ length: 14 }, (_, index) => ({
    id: `related-${index}`,
    scopeId: 'scope',
    version: index + 1,
    path: `bob/req/very/long/directory/document-${index}.md`,
    title: `用于验证知识助手长名称换行与省略展示的需求文档 ${index}`,
    reasons: [index === 0 ? 'same_requirement' : 'text_match'],
    confirmed: false,
  }));
  await render({ assistant: true, onOpenSource });
  const list = container.querySelector('[role="list"][aria-label="相关资料"]');
  expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(6);
  expect(container.textContent).toContain('已显示 6 / 14 篇');
  const longTitle = context.related[0].title;
  const nameButton = button(longTitle);
  expect(nameButton.getAttribute('title')).toBe(`${longTitle}\n${context.related[0].path}`);
  expect(
    list.querySelector('[role="listitem"]').lastElementChild.lastElementChild.textContent,
  ).toBe('同一需求');
  await click(nameButton);
  expect(onOpenSource).toHaveBeenCalledWith({
    relativePath: context.related[0].path,
    workspaceId: 'w',
    title: longTitle,
  });
  Object.defineProperties(list, {
    scrollTop: { configurable: true, value: 200, writable: true },
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 420 },
  });
  await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
  expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(12);
  expect(container.textContent).toContain('已显示 12 / 14 篇');
  await click(button('加载更多'));
  expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(14);
  expect(container.textContent).toContain('已显示 14 / 14 篇');
  expect(button('加载更多')).toBeUndefined();
});

it('keeps unrelated enhancement history and running checks out of settings', async () => {
  const original = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options = {}) => {
    const result = await original(url, options);
    if (new URL(url, 'http://local').pathname.endsWith('/jobs') && !options.body) {
      const value = await result.json();
      return {
        ok: true,
        json: async () => ({
          ...value,
          jobs: [
            { id: 'check', kind: 'quality-check', status: 'running' },
            { id: 'old-index', kind: 'code-index', status: 'completed' },
          ],
        }),
      };
    }
    return result;
  });
  await act(async () =>
    root.render(React.createElement(EnhancementSettings, { workspaceId: 'w' })),
  );
  expect(container.textContent).not.toContain('任务历史');
  expect(container.querySelector('[aria-label="增强任务"]')).toBeNull();
  expect([...container.querySelectorAll('h3')].map((node) => node.textContent)).toEqual([
    'MCP 连接',
    '代码索引',
  ]);
  const groups = [...container.querySelectorAll('h3')].map((node) => node.closest('section'));
  expect(groups[0].querySelector('.rh-select')).not.toBeNull();
  expect(groups[0].textContent).toContain('注册状态');
  expect(groups[0].textContent).not.toContain('索引状态');
  expect(groups[1].textContent).toContain('索引状态');
  expect(groups[1].textContent).not.toContain('注册状态');
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(calls.some((call) => /\/jobs\//.test(call.path))).toBe(false);

  const help = container.querySelector('[aria-label="注册状态说明"]');
  await act(async () => help.focus());
  expect(document.querySelector('[role="tooltip"]').textContent).toContain('已注册不代表调用成功');
});

it('preserves saved settings and shows no success notice when automatic saving fails', async () => {
  const original = fetch.getMockImplementation();
  let finishSave;
  fetch.mockImplementation(async (url, options = {}) => {
    if (String(url).endsWith('/config') && options.method === 'POST') {
      return new Promise((resolve) => {
        finishSave = resolve;
      });
    }
    return original(url, options);
  });
  await act(async () => root.render(React.createElement(DocumentAssociationSettings)));
  const toggle = container.querySelector('[role="switch"]');
  await click(toggle);
  expect(toggle.disabled).toBe(true);
  expect(container.textContent).not.toContain('已自动保存');
  await act(async () => finishSave({ ok: false }));
  expect(toggle.disabled).toBe(false);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain('已自动保存');
});
