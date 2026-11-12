import { expect, it, vi } from 'vitest';
import {
  bindAllLarkWorkspaces,
  larkWorkspacesRevision,
} from '../../src/server/lark-workspace-bindings.js';

vi.mock('node:fs/promises', () => ({
  realpath: async (path) => {
    if (typeof path !== 'string') {
      throw Object.assign(new TypeError('Invalid path'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    return path;
  },
}));
const settings = { executable: 'lark-cli', profile: '', identity: 'user', timeoutMs: 1000 };
const entries = [
  { id: 'alpha', title: 'Alpha', path: '/projects/alpha' },
  { id: 'beta', title: 'Beta', path: '/projects/beta' },
];
const output = (data) => JSON.stringify({ ok: true, data });
function setup() {
  let config = { lark: settings, larkTargets: { unrelated: { title: 'Keep' } } };
  const nodes = new Map();
  const registry = { list: vi.fn(() => entries) };
  const execute = vi.fn(async (_settings, args) => {
    if (args.includes('status')) {
      return output({ appId: 'app', identities: { user: { available: true, verified: true } } });
    }
    if (args.includes('+node-list')) {
      return output({ nodes: [...nodes.values()], has_more: false });
    }
    if (args.includes('+node-create')) {
      const title = args[args.indexOf('--title') + 1];
      const node = {
        title,
        node_token: 'Root' + title,
        space_id: '123',
        parent_node_token: '',
        obj_token: 'Doc' + title,
        obj_type: 'docx',
      };
      nodes.set(node.node_token, node);
      return output(node);
    }
    const token = args[args.indexOf('--node-token') + 1];
    if (args.includes('+node-get')) {
      return output(nodes.get(token));
    }
    if (args.includes('+inspect')) {
      const node = nodes.get(args[args.indexOf('--url') + 1]);
      return output({ wiki_node: node, url: 'https://team.feishu.cn/docx/' + node.obj_token });
    }
    throw new Error('Unexpected command');
  });
  const loadConfig = vi.fn(async () => config);
  const saveConfig = vi.fn(async (next) => {
    config = next;
  });
  const owner = new AbortController();
  const options = {
    registry,
    settings,
    spaceId: '123',
    expectedRevision: larkWorkspacesRevision(entries, config),
    loadConfig,
    saveConfig,
    execute,
    signal: owner.signal,
  };
  return { options, owner, nodes, current: () => config };
}

it('creates and binds every registered workspace, then reuses all nodes on retry', async () => {
  const { options, nodes, current } = setup();
  const result = await bindAllLarkWorkspaces(options);
  expect(result).toMatchObject({ total: 2, created: 2, reused: 0 });
  expect([...nodes.values()].map((node) => node.title)).toEqual(['Alpha', 'Beta']);
  expect(current().larkTargets.alpha).toMatchObject({ token: 'RootAlpha', useDefault: true });
  expect(current().larkTargets.beta).toMatchObject({ token: 'RootBeta', useDefault: true });
  expect(current().larkTargets.unrelated.title).toBe('Keep');
  expect(options.saveConfig).toHaveBeenCalledOnce();
  const retried = await bindAllLarkWorkspaces({
    ...options,
    expectedRevision: result.defaultRevision,
  });
  expect(retried).toMatchObject({ total: 2, created: 0, reused: 2 });
  expect(nodes.size).toBe(2);
});

it('projects getter-backed Host workspace entities without losing their paths or identities', async () => {
  class Workspace {
    constructor(entry) {
      this.entry = entry;
    }
    get id() {
      return this.entry.id;
    }
    get path() {
      return this.entry.path;
    }
    get title() {
      return this.entry.title;
    }
  }
  const { options, current } = setup();
  const entities = entries.map((entry) => new Workspace(entry));
  expect({ ...entities[0] }).not.toHaveProperty('path');
  options.registry.list.mockReturnValue(entities);
  const result = await bindAllLarkWorkspaces(options);
  expect(result).toMatchObject({ total: 2, created: 2 });
  expect(current().larkTargets.alpha).toMatchObject({
    title: 'Alpha',
    workspaceRoot: '/projects/alpha',
  });
  expect(current().larkTargets.beta).toMatchObject({
    title: 'Beta',
    workspaceRoot: '/projects/beta',
  });
  expect(options.saveConfig).toHaveBeenCalledOnce();
});

it('reports missing registry paths before issuing any remote command', async () => {
  const { options } = setup();
  options.registry.list.mockReturnValue([{ id: 'alpha', title: 'Alpha' }]);
  await expect(bindAllLarkWorkspaces(options)).rejects.toMatchObject({
    message: 'LARK_WORKSPACE_INVALID',
    details: {
      stage: 'workspace-path',
      batch: { completed: 0, created: 0, failedWorkspace: 'Alpha' },
    },
  });
  expect(options.execute).not.toHaveBeenCalled();
  expect(options.saveConfig).not.toHaveBeenCalled();
});

it('reports the authentication stage without changing bindings when user credentials are missing', async () => {
  const { options } = setup();
  options.execute.mockRejectedValueOnce(
    Object.assign(new Error('LARK_LOGIN_REQUIRED'), { details: { identity: 'user', exitCode: 3 } }),
  );
  await expect(bindAllLarkWorkspaces(options)).rejects.toMatchObject({
    message: 'LARK_LOGIN_REQUIRED',
    details: {
      identity: 'user',
      exitCode: 3,
      stage: 'authentication',
      batch: { total: 2, completed: 0, created: 0, failedWorkspace: 'Alpha' },
    },
  });
  expect(options.saveConfig).not.toHaveBeenCalled();
});

it('reports local save failures with a safe filesystem reason and remote progress', async () => {
  const { options } = setup();
  options.saveConfig.mockRejectedValueOnce(
    Object.assign(new Error('private configuration path'), { code: 'EACCES' }),
  );
  try {
    await bindAllLarkWorkspaces(options);
    expect.unreachable();
  } catch (error) {
    expect(error).toMatchObject({
      message: 'LARK_TARGET_FAILED',
      details: {
        stage: 'save-bindings',
        filesystemCode: 'EACCES',
        remoteChangePossible: true,
        batch: { completed: 2, created: 2 },
      },
    });
    expect(JSON.stringify(error.details)).not.toContain('private');
  }
});

it('fills the other workspace when one workspace already has a Wiki binding', async () => {
  const { options, nodes, current } = setup();
  const alpha = {
    title: 'Alpha',
    node_token: 'RootAlpha',
    space_id: '123',
    parent_node_token: '',
    obj_token: 'DocAlpha',
    obj_type: 'docx',
  };
  nodes.set(alpha.node_token, alpha);
  current().larkTargets.alpha = { title: 'Alpha', token: 'RootAlpha', spaceId: '123' };
  options.expectedRevision = larkWorkspacesRevision(entries, current());
  expect(await bindAllLarkWorkspaces(options)).toMatchObject({ total: 2, created: 1, reused: 1 });
  expect(current().larkTargets.alpha.token).toBe('RootAlpha');
  expect(current().larkTargets.beta.token).toBe('RootBeta');
  const writes = options.execute.mock.calls.filter(([, args]) => args.includes('+node-create'));
  expect(writes).toHaveLength(1);
  expect(writes[0][1]).toContain('Beta');
});

it('reports partial remote progress and leaves all local bindings intact on failure', async () => {
  const { options, current, nodes } = setup();
  const original = options.execute.getMockImplementation();
  options.execute.mockImplementation(async (connection, args) => {
    if (args.includes('+node-create') && args.includes('Beta')) {
      throw new Error('LARK_NETWORK_FAILED');
    }
    return original(connection, args);
  });
  await expect(bindAllLarkWorkspaces(options)).rejects.toMatchObject({
    message: 'LARK_NETWORK_FAILED',
    details: {
      remoteChangePossible: true,
      batch: { total: 2, completed: 1, created: 1, failedWorkspace: 'Beta' },
    },
  });
  expect(current().larkTargets).toEqual({ unrelated: { title: 'Keep' } });
  expect(nodes.size).toBe(1);
  expect(options.saveConfig).not.toHaveBeenCalled();
  options.execute.mockImplementation(original);
  expect(await bindAllLarkWorkspaces(options)).toMatchObject({ total: 2, created: 1, reused: 1 });
});

it('rejects a stale binding in any workspace before making remote calls', async () => {
  const { options, current } = setup();
  current().larkTargets.beta = { title: 'Changed elsewhere' };
  await expect(bindAllLarkWorkspaces(options)).rejects.toThrow('LARK_TARGET_CONFLICT');
  expect(options.execute).not.toHaveBeenCalled();
});

it('rejects a changed workspace set or connection after the preview', async () => {
  for (const changedSet of [true, false]) {
    const { options, current } = setup();
    if (changedSet) {
      options.registry.list.mockReturnValue([
        ...entries,
        { id: 'gamma', title: 'Gamma', path: '/projects/gamma' },
      ]);
    } else {
      current().lark = { ...settings, profile: 'another' };
      options.settings = current().lark;
    }
    await expect(bindAllLarkWorkspaces(options)).rejects.toThrow('LARK_TARGET_CONFLICT');
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.saveConfig).not.toHaveBeenCalled();
  }
});

it('stops if the workspace registry changes after one workspace was prepared', async () => {
  const { options } = setup();
  const original = options.execute.getMockImplementation();
  options.execute.mockImplementation(async (connection, args) => {
    const result = await original(connection, args);
    if (args.includes('+node-create')) {
      options.registry.list.mockReturnValue([entries[0]]);
    }
    return result;
  });
  await expect(bindAllLarkWorkspaces(options)).rejects.toMatchObject({
    message: 'LARK_TARGET_CONFLICT',
    details: {
      remoteChangePossible: true,
      batch: { completed: 1, total: 2, created: 1 },
    },
  });
  expect(
    options.execute.mock.calls.filter(([, args]) => args.includes('+node-create')),
  ).toHaveLength(1);
  expect(options.saveConfig).not.toHaveBeenCalled();
});

it('rejects duplicate workspace names before any remote write', async () => {
  const { options } = setup();
  options.registry.list.mockReturnValue([entries[0], { ...entries[1], title: 'Alpha' }]);
  await expect(bindAllLarkWorkspaces(options)).rejects.toThrow('LARK_WORKSPACE_NAME_AMBIGUOUS');
  expect(options.execute).not.toHaveBeenCalled();
  expect(options.saveConfig).not.toHaveBeenCalled();
});

it('stops before later workspaces when cancellation follows the first remote create', async () => {
  const { options, owner } = setup();
  const original = options.execute.getMockImplementation();
  options.execute.mockImplementation(async (connection, args) => {
    const result = await original(connection, args);
    if (args.includes('+node-create')) {
      owner.abort();
    }
    return result;
  });
  await expect(bindAllLarkWorkspaces(options)).rejects.toThrow();
  expect(
    options.execute.mock.calls.filter(([, args]) => args.includes('+node-create')),
  ).toHaveLength(1);
  expect(options.saveConfig).not.toHaveBeenCalled();
});
