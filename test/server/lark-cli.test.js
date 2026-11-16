import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLarkCliRoutes, validateLarkSettings } from '../../src/server/lark-cli.js';
import { createOperations } from '../../src/server/operations.js';
import { createConfigRoutes } from '../../src/server/routes/config-routes.js';
import { loadConfig, saveConfig } from '../../src/server/config.js';

const { spawn, replies } = vi.hoisted(() => ({ spawn: vi.fn(), replies: [] }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original()),
  realpath: async (path) => path,
}));
vi.mock('../../src/server/config.js', () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  updateConfig: vi.fn(async (updater) => {
    const next = await updater(await loadConfig());
    await saveConfig(next);
    return next;
  }),
  autoDefaultConfig: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'private-token',
          }),
          { status: 200 },
        ),
    ),
  );
  replies.length = 0;
  loadConfig.mockResolvedValue({
    lark: {
      executable: process.platform === 'win32' ? 'C:\\tools\\lark-cli.exe' : '/tools/lark-cli',
      profile: 'team',
      identity: 'user',
      timeoutMs: 1000,
    },
  });
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = vi.fn();
    child.kill = vi.fn(() => {
      setTimeout(() => child.emit('close', null), 5);
      return true;
    });
    const reply = replies.shift();
    if (reply !== undefined) {
      queueMicrotask(() => {
        if (typeof reply === 'string') {
          child.stdout.emit('data', Buffer.from(reply));
          child.emit('close', 0);
        } else {
          child.stderr.emit('data', Buffer.from(JSON.stringify(reply)));
          child.emit('close', 3);
        }
      });
    }
    return child;
  });
});

afterEach(() => vi.unstubAllGlobals());

it('saves the default Wiki destination and reuses it on the next save', async () => {
  const root = process.platform === 'win32' ? 'C:\\projects\\alpha' : '/projects/alpha';
  const service = createLarkCliRoutes({
    list: () => [
      { id: 'alpha', title: 'Alpha', path: root },
      { id: 'beta', title: 'Beta', path: root + '-beta' },
    ],
  });
  const auth = { appId: 'app', identities: { user: { available: true, verified: true } } };
  const node = {
    node_token: 'Root',
    space_id: '123',
    parent_node_token: '',
    obj_token: 'Doc',
    obj_type: 'docx',
    title: 'Alpha',
  };
  const output = (data) => JSON.stringify({ ok: true, data });
  const inspect = { url: 'https://team.feishu.cn/docx/Doc', wiki_node: node };
  replies.push(
    output(auth),
    output({ nodes: [], has_more: false }),
    output(node),
    output(auth),
    output(node),
    output(inspect),
  );
  const beta = { ...node, title: 'Beta', node_token: 'BetaRoot', obj_token: 'BetaDoc' };
  const betaInspect = { url: 'https://team.feishu.cn/docx/BetaDoc', wiki_node: beta };
  replies.push(
    output(auth),
    output({ nodes: [node], has_more: false }),
    output(beta),
    output(auth),
    output(beta),
    output(betaInspect),
  );
  const body = {
    workspaceId: 'alpha',
    spaceId: '123',
    workspaceName: 'Untrusted',
    expectedDefaultRevision: (await check(service, 'target-get', { workspaceId: 'alpha' })).body
      .defaultRevision,
  };
  const created = await check(service, 'target-default-save', body);
  expect(created.body).toMatchObject({
    saved: true,
    total: 2,
    created: 2,
    reused: 0,
    binding: { useDefault: true, title: 'Alpha', spaceId: '123', token: 'Root' },
  });
  const persisted = saveConfig.mock.calls[0][0];
  expect(persisted.larkTargets.beta).toMatchObject({ title: 'Beta', token: 'BetaRoot' });
  loadConfig.mockResolvedValue(persisted);
  replies.push(
    output(auth),
    output({ nodes: [node], has_more: false }),
    output(auth),
    output(node),
    output(inspect),
  );
  replies.push(
    output(auth),
    output({ nodes: [node, beta], has_more: false }),
    output(auth),
    output(beta),
    output(betaInspect),
  );
  const reused = await check(service, 'target-default-save', {
    ...body,
    expectedDefaultRevision: created.body.defaultRevision,
  });
  expect(reused.body).toMatchObject({
    saved: true,
    total: 2,
    created: 0,
    reused: 2,
    binding: { useDefault: true, token: 'Root' },
  });
  expect(spawn.mock.calls.filter(([, args]) => args.includes('+node-create'))).toHaveLength(2);
  const createArgs = spawn.mock.calls.find(([, args]) => args.includes('+node-create'))[1];
  expect(createArgs[createArgs.indexOf('--title') + 1]).toBe('Alpha');
  await service.dispose();
});

it('rejects stale default configuration before any CLI call', async () => {
  const root = process.platform === 'win32' ? 'C:\\projects\\alpha' : '/projects/alpha';
  const service = createLarkCliRoutes({ list: () => [{ id: 'alpha', path: root }] });
  const result = await check(service, 'target-default-save', {
    workspaceId: 'alpha',
    spaceId: '123',
    expectedDefaultRevision: 'stale',
  });
  expect(result.body.code).toBe('LARK_TARGET_CONFLICT');
  expect(spawn).not.toHaveBeenCalled();
  expect(saveConfig).not.toHaveBeenCalled();
  await service.dispose();
});

it('reports a created remote page when local binding persistence fails', async () => {
  const root = process.platform === 'win32' ? 'C:\\projects\\alpha' : '/projects/alpha';
  const service = createLarkCliRoutes({
    list: () => [{ id: 'alpha', title: 'Alpha', path: root }],
  });
  const auth = { appId: 'app', identities: { user: { available: true, verified: true } } };
  const node = {
    node_token: 'Root',
    space_id: '123',
    parent_node_token: '',
    obj_token: 'Doc',
    obj_type: 'docx',
    title: 'Alpha',
  };
  const output = (data) => JSON.stringify({ ok: true, data });
  replies.push(
    output(auth),
    output({ nodes: [], has_more: false }),
    output(node),
    output(auth),
    output(node),
    output({ url: 'https://team.feishu.cn/docx/Doc', wiki_node: node }),
  );
  saveConfig.mockRejectedValueOnce(new Error('Storage unavailable'));
  const result = await check(service, 'target-default-save', {
    workspaceId: 'alpha',
    spaceId: '123',
    expectedDefaultRevision: (await check(service, 'target-get', { workspaceId: 'alpha' })).body
      .defaultRevision,
  });
  expect(result.body).toMatchObject({ ready: false, details: { remoteChangePossible: true } });
  expect(result.body.saved).not.toBe(true);
  expect(JSON.stringify(result.body)).not.toContain('Storage unavailable');
  await service.dispose();
});

it('keeps default Wiki initialization user-only', async () => {
  const service = createLarkCliRoutes();
  const result = await createOperations(service.routes).execute(
    {
      action: 'lark/target-default-save',
      method: 'POST',
      body: { workspaceId: 'alpha', spaceId: '123', expectedDefaultRevision: 'batch' },
    },
    {},
  );
  expect(result).toMatchObject({ status: 403, value: { error: 'LARK_USER_REQUIRED' } });
  expect(spawn).not.toHaveBeenCalled();
  expect(saveConfig).not.toHaveBeenCalled();
  await service.dispose();
});

it.each([
  ['authorization', 'app_scope_not_applied', 'LARK_APP_SCOPE_REQUIRED', 99991672],
  ['authorization', 'missing_scope', 'LARK_USER_SCOPE_REQUIRED', 99991679],
  ['authorization', 'permission_denied', 'LARK_TARGET_ACCESS_FAILED', 403],
  ['network', 'transport', 'LARK_NETWORK_FAILED', null],
])(
  'preserves safe stderr diagnostics for target browsing: %s/%s',
  async (type, subtype, code, upstreamCode) => {
    const root = process.platform === 'win32' ? 'C:\\projects\\alpha' : '/projects/alpha';
    const service = createLarkCliRoutes({ list: () => [{ id: 'alpha', path: root }] });
    replies.push({
      ok: false,
      identity: 'bot',
      error: {
        type,
        subtype,
        code: upstreamCode,
        missing_scopes: ['drive:drive:readonly'],
        message: 'secret-token-in-message',
        hint: 'secret-token-in-hint',
        console_url: 'https://evil.test/private',
      },
    });
    const result = await check(service, 'target-options', { workspaceId: 'alpha', type: 'folder' });
    expect(result.body).toEqual({
      ready: false,
      code,
      details: {
        identity: 'user',
        upstreamCode,
        exitCode: 3,
        missingScopes: ['drive:drive:readonly'],
      },
    });
    expect(JSON.stringify(result.body)).not.toMatch(/secret-token|evil\.test/);
    expect(saveConfig).not.toHaveBeenCalled();
    await service.dispose();
  },
);

async function check(service, action = 'check', body = {}) {
  const { res, pending } = startRequest(service, action, body);
  await pending;
  return res;
}

it('lists registered workspace bindings and removes only the selected row without invoking CLI', async () => {
  const config = await loadConfig();
  const alpha = { workspaceRoot: '/projects/alpha', kind: 'wiki', title: 'Alpha', token: 'Root' };
  const beta = { workspaceRoot: '/old/beta', kind: 'folder', title: 'Folder', token: 'Folder' };
  config.larkTargets = { alpha, beta, hidden: { title: 'unregistered' } };
  const service = createLarkCliRoutes({
    list: () => [
      { id: 'alpha', title: 'Alpha', path: '/projects/alpha' },
      { id: 'beta', title: 'Beta', path: '/projects/beta' },
      { id: 'gamma', title: 'Gamma', path: '/projects/gamma' },
    ],
  });
  const list = await check(service, 'target-list');
  expect(list.body.items).toHaveLength(3);
  expect(list.body.items[0]).toMatchObject({
    id: 'alpha',
    path: '/projects/alpha',
    binding: alpha,
    bindingCurrent: true,
  });
  expect(list.body.items[1]).toMatchObject({ id: 'beta', binding: beta, bindingCurrent: false });
  expect(list.body.items[2]).toMatchObject({ id: 'gamma', binding: null });
  expect(
    (
      await check(service, 'target-remove', {
        workspaceId: 'beta',
        expectedRevision: 'stale',
      })
    ).body.code,
  ).toBe('LARK_TARGET_CONFLICT');
  expect(saveConfig).not.toHaveBeenCalled();
  const removed = await check(service, 'target-remove', {
    workspaceId: 'beta',
    expectedRevision: list.body.items[1].revision,
  });
  expect(removed.body).toMatchObject({ saved: true, binding: null });
  expect(saveConfig.mock.calls[0][0].larkTargets).toEqual({
    alpha,
    hidden: { title: 'unregistered' },
  });
  expect(spawn).not.toHaveBeenCalled();
  expect(
    (
      await check(service, 'target-remove', {
        workspaceId: 'hidden',
        expectedRevision: null,
      })
    ).body.code,
  ).toBe('LARK_WORKSPACE_INVALID');
  await service.dispose();
});

function startRequest(service, action = 'check', body = {}) {
  const res = new EventEmitter();
  res.writeHead = (status) => {
    res.status = status;
  };
  res.end = (body) => {
    res.body = JSON.parse(body);
  };
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' });
  const pending = service.routes
    .find((route) => route.path.endsWith('/' + action))
    .handler(req, res);
  return { res, pending };
}

it('waits for an aborted catalog process to exit before checking the connection', async () => {
  const root = process.platform === 'win32' ? 'C:\\projects\\alpha' : '/projects/alpha';
  const service = createLarkCliRoutes({ list: () => [{ id: 'alpha', path: root }] });
  const catalog = startRequest(service, 'target-options', { workspaceId: 'alpha', type: 'wiki' });
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  const child = spawn.mock.results[0].value;
  child.kill.mockImplementation(() => true);
  replies.push(
    'lark-cli version 1.0.99',
    JSON.stringify({
      appId: 'cli_test',
      identities: { user: { available: true, verified: true } },
    }),
  );
  const connection = startRequest(service);
  catalog.res.emit('close');
  await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'));
  expect(spawn).toHaveBeenCalledOnce();
  expect(connection.res.body).toBeUndefined();
  child.emit('close', null);
  await Promise.all([catalog.pending, connection.pending]);
  expect(catalog.res.body.code).toBe('LARK_CHECK_CANCELLED');
  expect(connection.res.body).toMatchObject({ ready: true, code: 'LARK_CHECK_OK' });
  expect(spawn).toHaveBeenCalledTimes(3);
  await service.dispose();
});

it('removes disconnected waiters without spawning another CLI process', async () => {
  const service = createLarkCliRoutes();
  const active = startRequest(service);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  const queued = startRequest(service);
  await vi.waitFor(() => expect(queued.res.listenerCount('close')).toBe(1));
  queued.res.emit('close');
  await queued.pending;
  expect(queued.res.body.code).toBe('LARK_CHECK_CANCELLED');
  await service.dispose();
  await active.pending;
  expect(spawn).toHaveBeenCalledOnce();
});

it('cancels both active operations and queued requests when unloaded', async () => {
  const service = createLarkCliRoutes();
  const active = startRequest(service);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  const queued = startRequest(service);
  await service.dispose();
  await Promise.all([active.pending, queued.pending]);
  expect(active.res.body.code).toBe('LARK_CHECK_CANCELLED');
  expect(queued.res.body.code).toBe('LARK_CHECK_CANCELLED');
  expect(spawn).toHaveBeenCalledOnce();
});

it('bounds queue waiting separately from the running CLI timeout', async () => {
  const current = await loadConfig();
  current.lark.timeoutMs = 120000;
  const service = createLarkCliRoutes();
  vi.useFakeTimers();
  try {
    const active = startRequest(service);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledOnce();
    const queued = startRequest(service);
    await vi.advanceTimersByTimeAsync(30001);
    await queued.pending;
    expect(queued.res.body.code).toBe('LARK_QUEUE_TIMEOUT');
    expect(spawn).toHaveBeenCalledOnce();
    const disposing = service.dispose();
    await vi.advanceTimersByTimeAsync(10);
    await disposing;
    await active.pending;
  } finally {
    vi.useRealTimers();
  }
});

it('requires online verification of the selected identity and returns only safe fields', async () => {
  replies.push(
    'lark-cli version 1.0.99',
    JSON.stringify({
      appId: 'cli_test',
      secret: 'must-not-leak',
      identities: { user: { available: true, verified: true, accessToken: 'private' } },
    }),
  );
  const service = createLarkCliRoutes();
  const res = await check(service);
  expect(res.body).toEqual({
    ready: true,
    code: 'LARK_CHECK_OK',
    version: '1.0.99',
    identity: 'user',
    appId: 'cli_test',
  });
  expect(spawn.mock.calls[1][1]).toEqual([
    '--profile',
    'team',
    'auth',
    'status',
    '--json',
    '--verify',
  ]);
  expect(spawn.mock.calls[1][2]).toMatchObject({ shell: false, windowsHide: true });
  await service.dispose();
});

it.each([
  [{ available: true, verified: false }, 'LARK_AUTH_UNVERIFIED'],
  [{ available: true }, 'LARK_AUTH_UNVERIFIED'],
  [{ available: false, status: 'missing' }, 'LARK_LOGIN_REQUIRED'],
])('does not mistake exit zero or an available bot for a verified user', async (user, code) => {
  replies.push(
    'lark-cli version 1.0.99',
    JSON.stringify({
      appId: 'cli_test',
      verified: true,
      identities: { user, bot: { available: true, verified: true } },
    }),
  );
  const service = createLarkCliRoutes();
  expect((await check(service)).body).toMatchObject({ ready: false, code });
  await service.dispose();
});

it('cancels and waits for the real child close before unload completes', async () => {
  const service = createLarkCliRoutes();
  const pending = check(service);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  const child = spawn.mock.results[0].value;
  await service.dispose();
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect((await pending).body.code).toBe('LARK_CHECK_CANCELLED');
});

it('does not trust malformed CLI output', async () => {
  replies.push('lark-cli version 1.0.99', 'not JSON');
  const service = createLarkCliRoutes();
  expect((await check(service)).body).toMatchObject({
    ready: false,
    code: 'LARK_RESPONSE_INVALID',
  });
  await service.dispose();
});

it('bounds a hanging process and reports timeout after its close', async () => {
  const service = createLarkCliRoutes();
  vi.useFakeTimers();
  try {
    const pending = check(service);
    await vi.advanceTimersByTimeAsync(1100);
    expect((await pending).body).toMatchObject({ ready: false, code: 'LARK_CHECK_TIMEOUT' });
    expect(spawn.mock.results[0].value.kill).toHaveBeenCalled();
    await service.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { executable: 'lark-cli --help' },
  { executable: 'C:\\tools\\lark-cli.cmd' },
  { profile: 'bad profile' },
  { timeoutMs: 0 },
  { identity: 'auto' },
  { appSecret: 'private' },
  null,
])('rejects commands, invalid settings and credential storage: %j', (value) => {
  expect(() => validateLarkSettings(value)).toThrow('LARK_CONFIG_INVALID');
});

it('prevents an Agent from changing which local executable the Host will run', async () => {
  const routes = createConfigRoutes({ list: () => [] }, {});
  const operations = createOperations(routes);
  expect(
    await operations.execute(
      {
        action: 'config',
        method: 'POST',
        body: { lark: { executable: '/tools/lark-cli' } },
      },
      {},
    ),
  ).toMatchObject({ status: 403, value: { error: 'LARK_USER_REQUIRED' } });
  expect(saveConfig).not.toHaveBeenCalled();
});

it('saves application credentials only through stdin to the selected CLI profile', async () => {
  replies.push('configured');
  const service = createLarkCliRoutes();
  const req = Object.assign(
    Readable.from([
      JSON.stringify({
        appId: 'cli_test',
        appSecret: 'test-secret',
        brand: 'feishu',
      }),
    ]),
    { method: 'POST' },
  );
  const res = new EventEmitter();
  res.writeHead = (status) => {
    res.status = status;
  };
  res.end = (body) => {
    res.body = JSON.parse(body);
  };
  await service.routes[1].handler(req, res);
  expect(res.body).toEqual({ configured: true, code: 'LARK_APP_SAVED' });
  expect(spawn.mock.calls[0][1]).toEqual([
    'config',
    'init',
    '--app-id',
    'cli_test',
    '--app-secret-stdin',
    '--brand',
    'feishu',
    '--name',
    'team',
  ]);
  expect(spawn.mock.results[0].value.stdin.end).toHaveBeenCalledWith('test-secret\n');
  expect(JSON.stringify(res.body)).not.toContain('test-secret');
  expect(saveConfig).not.toHaveBeenCalled();
  await service.dispose();
});

it('denies Agent application configuration before reading credentials or starting the CLI', async () => {
  const service = createLarkCliRoutes();
  const result = await createOperations(service.routes).execute(
    {
      action: 'lark/configure',
      method: 'POST',
      body: { appId: 'cli_test', appSecret: 'test-secret', brand: 'feishu' },
    },
    {},
  );
  expect(result).toMatchObject({ status: 403, value: { error: 'LARK_USER_REQUIRED' } });
  expect(spawn).not.toHaveBeenCalled();
  await service.dispose();
});

it('validates user settings before persistence', async () => {
  const route = createConfigRoutes({ list: () => [] }, {})[0];
  const req = Object.assign(Readable.from([JSON.stringify({ lark: null })]), { method: 'POST' });
  const res = {
    writeHead(status) {
      this.status = status;
    },
    end() {},
  };
  await route.handler(req, res);
  expect(res.status).toBe(400);
  expect(saveConfig).not.toHaveBeenCalled();
});

it('checks a draft without persisting it and rechecks before saving', async () => {
  const settings = { ...(await loadConfig()).lark, profile: 'draft' };
  const success = JSON.stringify({
    appId: 'cli_test',
    identities: { user: { available: true, verified: true } },
  });
  const service = createLarkCliRoutes();
  replies.push('lark-cli version 1.0.99', success);
  expect((await check(service, 'check', { lark: settings })).body.ready).toBe(true);
  expect(spawn.mock.calls[1][1].slice(0, 2)).toEqual(['--profile', 'draft']);
  expect(saveConfig).not.toHaveBeenCalled();
  replies.push(
    'lark-cli version 1.0.99',
    JSON.stringify({
      appId: 'cli_test',
      identities: { user: { available: false, verified: false } },
    }),
  );
  expect((await check(service, 'save', { lark: settings })).body.ready).toBe(false);
  expect(saveConfig).not.toHaveBeenCalled();
  replies.push('lark-cli version 1.0.99', success);
  expect((await check(service, 'save', { lark: settings })).body.saved).toBe(true);
  expect(saveConfig).toHaveBeenCalledWith({ lark: settings });
  await service.dispose();
});

it('verifies credentials without changing CLI storage or exposing the issued token', async () => {
  const service = createLarkCliRoutes();
  const body = { appId: 'cli_test', appSecret: 'test-secret', brand: 'feishu' };
  const result = await check(service, 'app-check', body);
  expect(result.body).toEqual({ credentialsValid: true, code: 'LARK_APP_CHECK_OK' });
  expect(spawn).not.toHaveBeenCalled();
  expect(saveConfig).not.toHaveBeenCalled();
  expect(fetch.mock.calls[0][0]).toBe(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
  );
  expect(fetch.mock.calls[0][1].redirect).toBe('error');
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 10003, msg: 'private' })));
  expect((await check(service, 'configure', body)).body).toEqual({
    ready: false,
    code: 'LARK_APP_CHECK_FAILED',
  });
  expect(spawn).not.toHaveBeenCalled();
  await service.dispose();
});

it('denies execution of unsaved executable settings through an Agent tool', async () => {
  const service = createLarkCliRoutes();
  const result = await createOperations(service.routes).execute(
    {
      action: 'lark/check',
      method: 'POST',
      body: { lark: { executable: '/tools/lark-cli' } },
    },
    {},
  );
  expect(result).toMatchObject({ status: 403, value: { error: 'LARK_USER_REQUIRED' } });
  expect(spawn).not.toHaveBeenCalled();
  await service.dispose();
});

it('binds a verified Wiki parent only to its registered workspace and preserves other bindings', async () => {
  const current = await loadConfig();
  current.larkTargets = { other: { title: 'keep' } };
  const root = process.platform === 'win32' ? 'C:\\projects\\alpha' : '/projects/alpha';
  const service = createLarkCliRoutes({
    list: () => [
      { id: 'alpha', path: root },
      { id: 'beta', path: root + '-beta' },
    ],
  });
  const auth = JSON.stringify({
    appId: 'cli_test',
    identities: {
      user: { available: true, verified: true, openId: 'ou_user' },
    },
  });
  const node = JSON.stringify({
    ok: true,
    data: {
      node_token: 'wikParent',
      space_id: '123',
      obj_token: 'docParent',
      obj_type: 'docx',
      title: 'Parent',
    },
  });
  replies.push(auth, node);
  const body = {
    workspaceId: 'alpha',
    url: 'https://team.feishu.cn/wiki/wikParent',
    expectedRevision: null,
  };
  expect((await check(service, 'target-check', body)).body.target.token).toBe('wikParent');
  expect(saveConfig).not.toHaveBeenCalled();
  replies.push(auth, node);
  const saved = await check(service, 'target-save', body);
  expect(saved.body).toMatchObject({
    saved: true,
    binding: {
      workspaceRoot: root,
      kind: 'wiki',
      token: 'wikParent',
      spaceId: '123',
      appId: 'cli_test',
      accountId: 'ou_user',
    },
  });
  const persisted = saveConfig.mock.calls[0][0];
  expect(persisted.larkTargets.other).toEqual({ title: 'keep' });
  loadConfig.mockResolvedValue(persisted);
  expect((await check(service, 'target-get', { workspaceId: 'beta' })).body.binding).toBeNull();
  expect((await check(service, 'target-get', { workspaceId: 'unknown' })).body.code).toBe(
    'LARK_WORKSPACE_INVALID',
  );
  const removed = await check(service, 'target-remove', {
    workspaceId: 'alpha',
    expectedRevision: saved.body.revision,
  });
  expect(removed.body).toMatchObject({ saved: true, binding: null });
  expect(saveConfig.mock.calls.at(-1)[0].larkTargets.other).toEqual({ title: 'keep' });
  expect(
    spawn.mock.calls.every(
      ([, args]) => !args.includes('+create') && !args.includes('+node-create'),
    ),
  ).toBe(true);
  await service.dispose();
});

it('rejects stale target saves and inaccessible folders without replacing existing configuration', async () => {
  const root = process.platform === 'win32' ? 'C:\\projects\\alpha' : '/projects/alpha';
  const service = createLarkCliRoutes({ list: () => [{ id: 'alpha', path: root }] });
  const auth = JSON.stringify({
    appId: 'cli_test',
    identities: { user: { available: true, verified: true } },
  });
  const folder = JSON.stringify({
    ok: true,
    data: { type: 'folder', token: 'fldParent', title: 'Folder' },
  });
  const body = {
    workspaceId: 'alpha',
    url: 'https://team.feishu.cn/drive/folder/fldParent',
    expectedRevision: 'stale',
  };
  replies.push(auth, folder, JSON.stringify({ ok: true, data: { files: [] } }));
  expect((await check(service, 'target-save', body)).body.code).toBe('LARK_TARGET_CONFLICT');
  expect(saveConfig).not.toHaveBeenCalled();
  replies.push(auth, folder, JSON.stringify({ ok: false, error: { code: 403 } }));
  expect((await check(service, 'target-check', body)).body.code).toBe('LARK_TARGET_ACCESS_FAILED');
  expect(saveConfig).not.toHaveBeenCalled();
  await service.dispose();
});
