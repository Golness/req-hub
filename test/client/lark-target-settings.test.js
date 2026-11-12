// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { LarkTargetSettings } = require('../../src/client/components/LarkTargetSettings.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
afterEach(async () => {
  if (root) {
    await act(async () => root.unmount());
  }
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
const response = (data) => ({ ok: true, json: async () => data });
const button = (label) =>
  [...document.querySelectorAll('button')].find((node) => node.textContent === label);
const click = async (node) => act(async () => node.click());
async function select(label, value) {
  await click(document.querySelector(`button[aria-label="${label}"]`));
  await click(document.querySelector(`[role="menuitem"][data-value="${value}"]`));
}
async function render(fetcher, props = {}) {
  vi.stubGlobal('fetch', fetcher);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(LarkTargetSettings, {
        workspaceId: 'alpha',
        connectionKey: 'connection',
        disabled: false,
        ...props,
      }),
    ),
  );
}
const spaces = [
  { id: 'alpha', title: 'Alpha', path: '/projects/alpha' },
  { id: 'beta', title: 'Beta', path: '/projects/beta' },
];
const parent = { kind: 'folder', token: 'Parent', title: 'Parent folder', spaceId: '' };
const child = { kind: 'folder', token: 'Child', title: 'Child folder', spaceId: '' };
const wikiSpace = { kind: 'space', token: '123', title: 'Engineering', spaceId: '123' };
const wikiNode = { kind: 'wiki', token: 'Node', title: 'Guides', spaceId: '123' };
const wikiChild = { kind: 'wiki', token: 'Leaf', title: 'API guide', spaceId: '123' };
const page = (items) => ({ items, hasMore: false, pageToken: '' });

it('waits for an active connection operation before requesting target data', async () => {
  const fetcher = api();
  await render(fetcher, { disabled: true, connectionBusy: true });
  expect(fetcher.mock.calls.every(([url]) => url.endsWith('/workspaces'))).toBe(true);
  expect(document.body.textContent).toContain('连接操作进行中');
  await act(async () =>
    root.render(
      React.createElement(LarkTargetSettings, {
        workspaceId: 'alpha',
        connectionKey: 'connection',
        disabled: false,
      }),
    ),
  );
  expect(document.querySelector('[aria-label="进入 Parent folder"]')).not.toBeNull();
});

function api() {
  return vi.fn(async (url, options) => {
    if (url.endsWith('/workspaces')) {
      return response(spaces);
    }
    const body = JSON.parse(options.body);
    if (url.endsWith('target-get')) {
      return response({
        binding: null,
        revision: null,
        defaultRevision: 'all-r0',
        workspaceTitle: body.workspaceId,
      });
    }
    if (url.endsWith('target-options')) {
      if (body.type === 'folder') {
        return response(
          page(body.parentToken === 'Parent' ? [child] : body.parentToken ? [] : [parent]),
        );
      }
      let items = [];
      if (!body.spaceId) {
        items = [wikiSpace];
      } else if (body.parentToken === 'Node') {
        items = [wikiChild];
      } else if (!body.parentToken) {
        items = [wikiNode];
      }
      return response(page(items));
    }
    if (url.endsWith('target-remove')) {
      return response({ saved: true, binding: null, revision: null, code: 'LARK_TARGET_REMOVED' });
    }
    return response({
      saved: true,
      binding: { ...body.selection, url: 'https://team.feishu.cn/wiki/Node' },
      revision: 'r1',
      code: 'LARK_TARGET_SAVED',
    });
  });
}

it('loads all DSH workspaces and browses folders one level at a time before binding', async () => {
  const fetcher = api();
  await render(fetcher);
  await click(document.querySelector('[aria-label="进入 Parent folder"]'));
  expect(document.querySelector('[aria-label="进入 Child folder"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="进入 Parent folder"]')).toBeNull();
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body).parentToken).toBe('Parent');
  await click(document.querySelector('[aria-label="进入 Child folder"]'));
  expect(document.body.textContent).toContain('当前层级没有可选项');
  await click(button('选择当前文件夹'));
  expect(document.body.textContent).toContain('已选择：Parent folder / Child folder');
  await click(button('保存绑定'));
  expect(document.querySelector('button[aria-label="目标类型"]')).toBeNull();
  expect(document.querySelector('[aria-label="进入 Child folder"]')).toBeNull();
  expect(button('保存绑定')).toBeUndefined();
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body)).toMatchObject({
    workspaceId: 'alpha',
    selection: { kind: 'folder', token: 'Child' },
    expectedRevision: null,
  });
  await click(button('解除绑定'));
  expect(document.querySelector('button[aria-label="目标类型"]')).not.toBeNull();
  expect(button('保存绑定').disabled).toBe(true);
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body).expectedRevision).toBe('r1');
  await select('工作区', 'beta');
  expect(
    fetcher.mock.calls.some(
      ([url, options]) =>
        url.endsWith('target-get') && JSON.parse(options.body).workspaceId === 'beta',
    ),
  ).toBe(true);
  expect(button('保存绑定').disabled).toBe(true);
});

it('selects a knowledge space and navigates nested nodes without flattening them', async () => {
  const fetcher = api();
  await render(fetcher);
  await select('目标类型', 'wiki');
  expect(document.querySelector('input[name$="-destination"]')).toBeNull();
  await click(document.querySelector('[aria-label="进入 Engineering"]'));
  expect(document.querySelector('[aria-label="进入 API guide"]')).toBeNull();
  await click(document.querySelector('[aria-label="进入 Guides"]'));
  expect(button('选择当前节点')).toBeDefined();
  expect(button('选择当前文件夹')).toBeUndefined();
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body)).toMatchObject({
    spaceId: '123',
    parentToken: 'Node',
  });
  await click(document.querySelector('[aria-label="选择 API guide"]'));
  expect(document.body.textContent).toContain('Engineering / Guides / API guide');
  await click(button('返回上一级'));
  expect(button('保存绑定').disabled).toBe(true);
  expect(document.querySelector('[aria-label="进入 Guides"]')).not.toBeNull();
});

it('selects only a Wiki space in default mode and asks the Host to prepare the workspace page', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-default-save')) {
      return response({
        saved: true,
        total: 2,
        created: 2,
        reused: 0,
        defaultRevision: 'all-r1',
        code: 'LARK_TARGET_SAVED',
        binding: { kind: 'wiki', title: 'Alpha', token: 'Root', spaceId: '123', useDefault: true },
        revision: 'r1',
      });
    }
    return original(url, options);
  });
  await render(fetcher);
  await select('目标类型', 'wiki');
  await click(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]'));
  expect(button('保存全部工作区').disabled).toBe(true);
  await select('知识库', '123');
  expect(document.body.textContent).toContain('目标知识库：Engineering');
  expect(document.body.textContent).toContain('影响范围：全部 2 个工作区');
  expect(document.querySelector('button[aria-label="工作区"]')).toBeNull();
  expect(document.querySelector('button[aria-label="目标类型"]')).toBeNull();
  expect(document.querySelector('[aria-label="进入 Engineering"]')).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('target-default-save'))).toHaveLength(0);
  await click(button('保存全部工作区'));
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body)).toEqual({
    workspaceId: 'alpha',
    expectedDefaultRevision: 'all-r0',
    spaceId: '123',
  });
  expect(document.body.textContent).toContain('全部 2 个工作区绑定已保存');
  expect(button('保存全部工作区').disabled).toBe(false);
  expect(document.querySelector('button[aria-label="知识库"]').textContent).toBe('Engineering');
  await click(button('保存全部工作区'));
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body).expectedDefaultRevision).toBe('all-r1');
  await click(document.querySelector('input[aria-label="单工作区绑定"]'));
  expect(document.querySelector('[aria-label="进入 Engineering"]')).not.toBeNull();
  expect(button('保存绑定').disabled).toBe(true);
});

it('restores default mode from a saved binding without loading child nodes', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-get')) {
      return response({
        binding: { kind: 'wiki', title: 'Alpha', token: 'Root', spaceId: '123', useDefault: true },
        revision: 'r1',
      });
    }
    return original(url, options);
  });
  await render(fetcher);
  expect(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]').checked).toBe(true);
  expect(document.querySelector('button[aria-label="知识库"]')).not.toBeNull();
  expect(document.querySelector('button[aria-label="知识库"]').textContent).toBe('Engineering');
  expect(button('保存全部工作区').disabled).toBe(false);
  const options = fetcher.mock.calls.filter(([url]) => url.endsWith('target-options'));
  expect(options.every(([, request]) => JSON.parse(request.body).spaceId === '')).toBe(true);
});

it('pages through knowledge spaces without losing the selection and reuses cached pages', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-options')) {
      const body = JSON.parse(options.body);
      if (body.type === 'wiki' && !body.spaceId) {
        if (body.pageToken === 'next') {
          return response(
            page([{ kind: 'space', token: '456', spaceId: '456', title: 'Product' }]),
          );
        }
        return response({ items: [wikiSpace], hasMore: true, pageToken: 'next' });
      }
    }
    return original(url, options);
  });
  await render(fetcher);
  await click(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]'));
  await select('知识库', '123');
  await click(button('下一页'));
  expect(document.querySelector('button[aria-label="知识库"]').textContent).toBe('Engineering');
  expect(document.body.textContent).toContain('知识库第 2 页');
  await select('知识库', '456');
  expect(document.querySelector('button[aria-label="知识库"]').textContent).toBe('Product');
  const calls = fetcher.mock.calls.length;
  await click(button('上一页'));
  await click(button('下一页'));
  expect(fetcher.mock.calls).toHaveLength(calls);
  expect(button('保存全部工作区').disabled).toBe(false);
});

it('uses an existing manual Wiki binding for batch saves and retains the space across workspaces', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  let extraWorkspace = false;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('/workspaces') && extraWorkspace) {
      return response([...spaces, { id: 'gamma', title: 'Gamma', path: '/projects/gamma' }]);
    }
    if (url.endsWith('target-get') && JSON.parse(options.body).workspaceId === 'alpha') {
      return response({
        binding: { kind: 'wiki', title: 'Alpha', token: 'Root', spaceId: '123' },
        revision: 'r1',
        defaultRevision: 'all-r1',
      });
    }
    return original(url, options);
  });
  await render(fetcher);
  expect(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]').checked).toBe(false);
  await click(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]'));
  expect(document.querySelector('button[aria-label="知识库"]').textContent).toBe('Engineering');
  expect(button('保存全部工作区').disabled).toBe(false);
  await click(document.querySelector('input[aria-label="单工作区绑定"]'));
  await select('工作区', 'beta');
  await click(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]'));
  expect(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]').checked).toBe(true);
  expect(document.querySelector('button[aria-label="知识库"]').textContent).toBe('Engineering');
  expect(button('保存全部工作区').disabled).toBe(false);
  extraWorkspace = true;
  await click(button('刷新工作区'));
  expect(document.body.textContent).toContain('影响范围：全部 3 个工作区');
  expect(document.body.textContent).toContain('查看工作区列表（3）');
  expect(button('保存全部工作区').disabled).toBe(false);
});

it('retains the selected space and explains a possible remote creation on save failure', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-default-save')) {
      return response({
        ready: false,
        code: 'LARK_CHECK_TIMEOUT',
        details: {
          remoteChangePossible: true,
          stage: 'create-node',
          exitCode: 3,
          batch: { total: 2, completed: 1, created: 1, failedWorkspace: 'Beta' },
        },
      });
    }
    return original(url, options);
  });
  await render(fetcher);
  await select('目标类型', 'wiki');
  await click(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]'));
  await select('知识库', '123');
  await click(button('保存全部工作区'));
  expect(document.querySelector('[role="alert"]').textContent).toContain('本地绑定尚未保存');
  expect(document.querySelector('button[aria-label="知识库"]').textContent).toBe('Engineering');
  expect(document.querySelector('[role="alert"]').textContent).toContain('已准备 1 / 2');
  expect(document.querySelector('[role="alert"]').textContent).toContain('Beta');
  expect(document.querySelector('[role="alert"]').textContent).toContain(
    '失败阶段：创建工作区一级节点',
  );
  expect(document.querySelector('[role="alert"]').textContent).toContain('CLI 退出码：3');
  expect(document.body.textContent).not.toContain('全部 2 个工作区绑定已保存');
  expect(button('保存全部工作区').disabled).toBe(false);
});

it('lists actual bindings and updates the batch revision after removing another workspace row', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  let removed = false;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-list')) {
      return response({
        items: spaces.map((item) => ({
          ...item,
          revision: item.id === 'beta' && !removed ? 'beta-r1' : null,
          bindingCurrent: true,
          binding:
            item.id === 'beta' && !removed
              ? {
                  kind: 'folder',
                  title: 'Beta folder',
                  url: 'https://team.feishu.cn/drive/folder/Beta',
                }
              : null,
        })),
      });
    }
    if (url.endsWith('target-remove')) {
      expect(JSON.parse(options.body)).toEqual({
        workspaceId: 'beta',
        expectedRevision: 'beta-r1',
      });
      removed = true;
      return response({ saved: true, binding: null, revision: null, defaultRevision: 'all-r2' });
    }
    if (url.endsWith('target-default-save')) {
      return response({
        saved: true,
        total: 2,
        created: 1,
        reused: 1,
        binding: { kind: 'wiki', title: 'Alpha', token: 'Root', spaceId: '123', useDefault: true },
        revision: 'alpha-r2',
        defaultRevision: 'all-r3',
      });
    }
    return original(url, options);
  });
  await render(fetcher);
  await click(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]'));
  await select('知识库', '123');
  await click(button('查看工作区列表（2）'));
  expect(document.querySelector('[role="table"]').textContent).toContain('/projects/beta');
  await click(document.querySelector('[aria-label="解除 Beta 的绑定"]'));
  expect(document.querySelector('[aria-label="解除 Beta 的绑定"]')).toBeNull();
  expect(button('保存全部工作区').disabled).toBe(false);
  await click(button('保存全部工作区'));
  const call = fetcher.mock.calls.find(([url]) => url.endsWith('target-default-save'));
  expect(JSON.parse(call[1].body).expectedDefaultRevision).toBe('all-r2');
});

it('retries the failed batch save instead of clearing its error with a catalog reload', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  let attempts = 0;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-default-save')) {
      attempts++;
      if (attempts < 3) {
        return response({
          code: 'LARK_WORKSPACE_INVALID',
          details: {
            stage: 'workspace-path',
            batch: { total: 2, completed: 0, created: 0, failedWorkspace: 'Alpha' },
          },
        });
      }
      return response({
        saved: true,
        total: 2,
        created: 2,
        reused: 0,
        binding: { kind: 'wiki', token: 'Root', spaceId: '123', title: 'Alpha', useDefault: true },
        revision: 'r1',
        defaultRevision: 'all-r1',
      });
    }
    return original(url, options);
  });
  await render(fetcher);
  await click(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]'));
  await select('知识库', '123');
  await click(button('保存全部工作区'));
  const readCount = fetcher.mock.calls.filter(([url]) => url.endsWith('target-get')).length;
  await click(button('重试保存全部工作区'));
  expect(attempts).toBe(2);
  expect(document.querySelector('[role="alert"]').textContent).toContain('检查工作区目录');
  expect(document.body.textContent).not.toContain('全部 2 个工作区绑定已保存');
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('target-get'))).toHaveLength(readCount);
  await click(button('重试保存全部工作区'));
  expect(attempts).toBe(3);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).toContain('全部 2 个工作区绑定已保存');
  const writes = fetcher.mock.calls.filter(([url]) => url.endsWith('target-default-save'));
  expect(writes.map(([, init]) => JSON.parse(init.body))).toEqual(
    Array(3).fill({
      workspaceId: 'alpha',
      spaceId: '123',
      expectedDefaultRevision: 'all-r0',
    }),
  );
});

it('shows missing login at the authentication stage instead of a generic batch failure', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-default-save')) {
      return response({
        code: 'LARK_LOGIN_REQUIRED',
        details: {
          stage: 'authentication',
          identity: 'user',
          exitCode: 3,
          batch: { total: 2, completed: 0, created: 0, failedWorkspace: 'Alpha' },
        },
      });
    }
    return original(url, options);
  });
  await render(fetcher);
  await select('目标类型', 'wiki');
  await click(document.querySelector('input[aria-label="默认知识库 · 全部工作区"]'));
  await select('知识库', '123');
  await click(button('保存全部工作区'));
  const alert = document.querySelector('[role="alert"]').textContent;
  expect(alert).toContain('所选用户身份尚未登录');
  expect(alert).toContain('失败阶段：验证飞书登录身份');
  expect(alert).toContain('已准备 0 / 2');
  expect(document.querySelector('button[aria-label="知识库"]').textContent).toBe('Engineering');
});

it('keeps the current level when a child request fails', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-options') && JSON.parse(options.body).parentToken === 'Parent') {
      return response({ code: 'LARK_TARGET_ACCESS_FAILED' });
    }
    return original(url, options);
  });
  await render(fetcher);
  await click(document.querySelector('[aria-label="进入 Parent folder"]'));
  expect(document.querySelector('[role="alert"]').textContent).toContain('目标不可读取');
  expect(document.querySelector('[aria-label="进入 Parent folder"]')).not.toBeNull();
  expect(button('保存绑定').disabled).toBe(true);
});

it('keeps binding controls hidden until removing an existing binding succeeds', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  let failRemoval = true;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-get')) {
      return response({
        binding: { ...parent, url: 'https://team.feishu.cn/drive/folder/Parent' },
        revision: 'r1',
      });
    }
    if (url.endsWith('target-remove') && failRemoval) {
      return response({ code: 'LARK_TARGET_FAILED' });
    }
    return original(url, options);
  });
  await render(fetcher);
  const expectBound = () => {
    expect(document.body.textContent).toContain('已绑定：Parent folder');
    expect(document.querySelector('button[aria-label="工作区"]')).not.toBeNull();
    expect(button('解除绑定')).toBeDefined();
    expect(document.querySelector('button[aria-label="目标类型"]')).toBeNull();
    expect(document.querySelector('[aria-label="进入 Parent folder"]')).toBeNull();
    expect(button('保存绑定')).toBeUndefined();
  };
  expectBound();
  await click(button('解除绑定'));
  expectBound();
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  failRemoval = false;
  await click(button('重试解除绑定'));
  expect(button('解除绑定')).toBeUndefined();
  expect(document.querySelector('button[aria-label="目标类型"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="进入 Parent folder"]')).not.toBeNull();
  expect(button('保存绑定').disabled).toBe(true);
});

it('aborts an in-flight level load on unmount and ignores its late result', async () => {
  const fetcher = api();
  const original = fetcher.getMockImplementation();
  let finish;
  let signal;
  fetcher.mockImplementation(async (url, options) => {
    if (url.endsWith('target-options') && JSON.parse(options.body).parentToken === 'Parent') {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return original(url, options);
  });
  await render(fetcher);
  await click(document.querySelector('[aria-label="进入 Parent folder"]'));
  expect(signal.aborted).toBe(false);
  await act(async () => root.unmount());
  root = null;
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response(page([child]))));
  expect(document.body.textContent).toBe('');
});

it.each([
  ['LARK_APP_SCOPE_REQUIRED', 'bot', '应用尚未开通', '飞书开发者后台'],
  ['LARK_USER_SCOPE_REQUIRED', 'user', '用户尚未授权', '完成用户授权'],
  ['LARK_NETWORK_FAILED', 'bot', '无法连接飞书服务', '代理及防火墙'],
])(
  'explains the actual browsing failure and allows retry: %s',
  async (code, identity, title, help) => {
    const fetcher = api();
    const original = fetcher.getMockImplementation();
    let failed = true;
    fetcher.mockImplementation(async (url, options) => {
      if (url.endsWith('target-options') && failed) {
        return response({
          ready: false,
          code,
          details: {
            identity,
            upstreamCode: 99991672,
            missingScopes: ['drive:drive:readonly'],
          },
        });
      }
      return original(url, options);
    });
    await render(fetcher);
    const alert = document.querySelector('[role="alert"]');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain(help);
    expect(alert.textContent).toContain('99991672');
    expect(alert.textContent.includes('drive:drive:readonly')).toBe(code !== 'LARK_NETWORK_FAILED');
    expect(alert.textContent.includes('个人云盘')).toBe(code === 'LARK_APP_SCOPE_REQUIRED');
    expect(button('保存绑定').disabled).toBe(true);
    failed = false;
    await click(button('重试'));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[aria-label="进入 Parent folder"]')).not.toBeNull();
  },
);
