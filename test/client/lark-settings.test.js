// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { LarkCliSettings } = require('../../src/client/components/LarkCliSettings.js');
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

async function render(fetcher) {
  vi.stubGlobal('fetch', (url, options) =>
    String(url).endsWith('/workspaces') ? Promise.resolve(response([])) : fetcher(url, options),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(LarkCliSettings)));
}

const response = (data, ok = true) => ({ ok, json: async () => data });
const button = (name) =>
  [...document.querySelectorAll('button')].find((node) => node.textContent === name);
const profile = () => document.querySelector('input[id$="-profile"]');
const click = async (node) => act(async () => node.click());
const edit = async (value) => {
  const advanced = document.querySelector('[data-rh-disclosure-trigger]');
  if (advanced.getAttribute('aria-expanded') === 'false') {
    await click(advanced);
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      profile(),
      value,
    );
    profile().dispatchEvent(new Event('input', { bubbles: true }));
  });
};

it('submits only one check when clicked twice before React updates the button', async () => {
  let finish;
  const fetcher = vi.fn((url) => {
    if (url.endsWith('/config')) {
      return Promise.resolve(response({}));
    }
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await render(fetcher);
  await act(async () => {
    button('检查连接').click();
    button('检查连接').click();
  });
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/lark/check'))).toHaveLength(1);
  await act(async () => finish(response({ ready: true, code: 'LARK_CHECK_OK' })));
});

it('shows connection network failures with safe details and leaves save disabled', async () => {
  await render(
    vi.fn(async (url) =>
      response(
        url.endsWith('/config')
          ? {}
          : {
              ready: false,
              code: 'LARK_NETWORK_FAILED',
              details: { identity: 'user', upstreamCode: null, missingScopes: [] },
            },
      ),
    ),
  );
  await click(button('检查连接'));
  expect(document.querySelector('[role="alert"]').textContent).toContain('网络请求失败');
  expect(button('保存连接').disabled).toBe(true);
});

it('separates connection and target controls and keeps credentials under the connection section', async () => {
  await render(vi.fn(async () => response({})));
  const headings = [...document.querySelectorAll('h3')];
  const connection = headings.find((node) => node.textContent === '飞书连接').closest('section');
  const targets = headings.find((node) => node.textContent === '发布到飞书').closest('section');
  expect(connection).not.toBe(targets);
  expect(connection.contains(button('检查连接'))).toBe(true);
  expect(targets.contains(button('检查连接'))).toBe(false);
  const setup = [...document.querySelectorAll('[data-rh-disclosure-trigger]')].find(
    (node) => node.textContent === '设置飞书连接',
  );
  expect(connection.contains(setup)).toBe(true);
  expect(setup.getAttribute('aria-expanded')).toBe('false');
  const help = document.querySelector('button[aria-label="连接检测说明"]');
  await act(async () => help.focus());
  expect(document.querySelector('[role="tooltip"]').textContent).toContain('在线凭据');
});

it('checks unsaved settings before saving and invalidates verification on edit', async () => {
  const fetcher = vi.fn(async (url) =>
    response(
      url.endsWith('/config')
        ? {}
        : {
            ready: true,
            saved: url.endsWith('/lark/save'),
            code: 'LARK_CHECK_OK',
            version: '1.0.99',
            identity: 'user',
            appId: 'cli_test',
          },
    ),
  );
  await render(fetcher);
  const advanced = document.querySelector('[data-rh-disclosure-trigger]');
  expect(advanced.textContent).toBe('高级设置');
  expect(advanced.getAttribute('aria-expanded')).toBe('false');
  expect(profile().closest('[data-rh-disclosure-content]').hidden).toBe(true);
  expect(document.querySelector(`label[for="${profile().id}"]`).textContent).toBe(
    '应用配置名称（可选）',
  );
  await click(button('检查连接'));
  expect(document.body.textContent).toContain('检测通过');
  await edit('team');
  expect(document.body.textContent).not.toContain('检测通过');
  expect(button('检查连接').disabled).toBe(false);
  expect(button('保存连接').disabled).toBe(true);
  await click(button('检查连接'));
  expect(button('保存连接').disabled).toBe(false);
  await click(button('保存连接'));
  expect(
    JSON.parse(fetcher.mock.calls.find(([, options]) => options?.body?.includes('team'))[1].body),
  ).toEqual({
    lark: { executable: 'lark-cli', profile: 'team', identity: 'user', timeoutMs: 30000 },
  });
  expect(button('检查连接').disabled).toBe(false);
  await click(button('检查连接'));
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body).lark.profile).toBe('team');
});

it('preserves drafts on save failure and reports authentication failure as an error', async () => {
  const fetcher = vi.fn(async (url, options) => {
    if (url.endsWith('/lark/check')) {
      return response({ ready: false, code: 'LARK_LOGIN_REQUIRED' });
    }
    if (url.endsWith('/lark/save')) {
      return response({}, false);
    }
    return response({});
  });
  await render(fetcher);
  await click(button('检查连接'));
  expect(document.querySelector('[role="alert"]').textContent).toContain('尚未登录');
  await edit('draft');
  fetcher.mockImplementation(async (url) => {
    if (url.endsWith('/lark/check')) {
      return response({ ready: true, code: 'LARK_CHECK_OK' });
    }
    return response({}, false);
  });
  await click(button('检查连接'));
  await click(button('保存连接'));
  expect(profile().value).toBe('draft');
  expect(document.querySelector('[role="alert"]').textContent).toContain('保存失败');
  expect(button('检查连接').disabled).toBe(false);
});

it('retries a failed load and aborts pending detection on unmount', async () => {
  let fail = true;
  const fetcher = vi.fn(async (url) => {
    if (url.endsWith('/config')) {
      return response({}, !fail);
    }
    return new Promise(() => {});
  });
  await render(fetcher);
  expect(document.body.textContent).toContain('读取配置失败');
  fail = false;
  await click(button('重试'));
  await click(button('检查连接'));
  const signal = fetcher.mock.calls.at(-1)[1].signal;
  expect(signal.aborted).toBe(false);
  await act(async () => root.unmount());
  root = null;
  expect(signal.aborted).toBe(true);
});

it('keeps application secrets out of plugin settings and clears the input after CLI configuration', async () => {
  const fetcher = vi.fn(async (url) => {
    if (url.endsWith('/lark/configure')) {
      return response({ configured: true, code: 'LARK_APP_SAVED' });
    }
    if (url.endsWith('/lark/app-check')) {
      return response({ credentialsValid: true, code: 'LARK_APP_CHECK_OK' });
    }
    return response({});
  });
  await render(fetcher);
  const setup = [...document.querySelectorAll('[data-rh-disclosure-trigger]')].find(
    (node) => node.textContent === '设置飞书连接',
  );
  expect(setup.getAttribute('aria-expanded')).toBe('false');
  expect(document.body.textContent).toContain('可选：配置飞书发布到知识库。');
  expect(
    button('检查连接').compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await click(setup);
  const help = document.querySelector('button[aria-label="应用 App ID说明"]');
  await act(async () => help.focus());
  expect(document.querySelector('[role="tooltip"]').textContent).toContain('应用 App ID');
  await act(async () =>
    help.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    ),
  );
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  const inputs = [...document.querySelectorAll('input')];
  const appId = inputs.find((node) => node.id.endsWith('-appId'));
  const secret = document.querySelector('input[type="password"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(appId, 'cli_test');
    appId.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(secret, 'test-secret');
    secret.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('配置连接').disabled).toBe(true);
  await click(button('检查应用'));
  expect(button('配置连接').disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      secret,
      'changed-secret',
    );
    secret.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('配置连接').disabled).toBe(true);
  await click(button('检查应用'));
  await click(button('配置连接'));
  expect(fetcher.mock.calls.at(-1)[0]).toBe('/req-hub/lark/configure');
  expect(JSON.parse(fetcher.mock.calls.at(-1)[1].body)).toEqual({
    appId: 'cli_test',
    appSecret: 'changed-secret',
    brand: 'feishu',
    lark: { executable: 'lark-cli', profile: '', identity: 'user', timeoutMs: 30000 },
  });
  expect(secret.value).toBe('');
  expect(document.body.textContent).toContain('应用配置已保存到 CLI');
  expect(document.body.textContent).not.toContain('检测通过');
});
