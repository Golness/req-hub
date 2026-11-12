import { expect, it, vi } from 'vitest';
import { ensureLarkWorkspaceNode } from '../../src/server/lark-workspace-node.js';

const settings = { profile: 'team', identity: 'user' };
const auth = { appId: 'app', identities: { user: { available: true, verified: true } } };
const node = {
  node_token: 'Root',
  title: 'Alpha',
  space_id: '123',
  parent_node_token: '',
  obj_token: 'Doc',
  obj_type: 'docx',
};
const output = (data) => JSON.stringify({ ok: true, data });
function runner(pages) {
  return vi.fn(async (_settings, args) => {
    if (args.includes('status')) {
      return output(auth);
    }
    if (args.includes('+node-list')) {
      return output(pages.shift());
    }
    if (args.includes('+node-create')) {
      return output({ ...node, resolved_space_id: '123' });
    }
    if (args.includes('+node-get')) {
      return output(node);
    }
    if (args.includes('+inspect')) {
      return output({ url: 'https://team.feishu.cn/docx/Doc', wiki_node: node });
    }
    throw new Error('Unexpected command');
  });
}
const page = (nodes, next = '') => ({ nodes, has_more: !!next, page_token: next });
const controller = () => new AbortController();

it('checks all root pages, reuses an exact match and never creates a duplicate', async () => {
  const execute = runner([page([], 'next'), page([node])]);
  const guard = vi.fn();
  const result = await ensureLarkWorkspaceNode(
    settings,
    '123',
    'Alpha',
    execute,
    controller().signal,
    guard,
  );
  expect(result).toMatchObject({
    created: false,
    target: {
      useDefault: true,
      kind: 'wiki',
      token: 'Root',
      spaceId: '123',
      title: 'Alpha',
    },
  });
  expect(execute.mock.calls.some(([, args]) => args.includes('+node-create'))).toBe(false);
  expect(guard).not.toHaveBeenCalled();
  const listCalls = execute.mock.calls.filter(([, args]) => args.includes('+node-list'));
  expect(listCalls).toHaveLength(2);
  expect(listCalls[1][1]).toContain('next');
  expect(listCalls.every(([, args]) => !args.includes('--parent-node-token'))).toBe(true);
});

it('creates one root docx page with the Host workspace name after a final guard', async () => {
  const execute = runner([page([])]);
  const guard = vi.fn();
  const result = await ensureLarkWorkspaceNode(
    settings,
    '123',
    'Alpha',
    execute,
    controller().signal,
    guard,
  );
  expect(result.created).toBe(true);
  expect(guard).toHaveBeenCalledOnce();
  const command = execute.mock.calls.find(([, args]) => args.includes('+node-create'))[1];
  expect(command).toEqual([
    '--profile',
    'team',
    'wiki',
    '+node-create',
    '--space-id',
    '123',
    '--title',
    'Alpha',
    '--node-type',
    'origin',
    '--obj-type',
    'docx',
    '--as',
    'user',
    '--format',
    'json',
  ]);
});

it('fails on duplicate root titles across pages instead of choosing arbitrarily', async () => {
  const execute = runner([page([node], 'next'), page([{ ...node, node_token: 'Other' }])]);
  await expect(
    ensureLarkWorkspaceNode(settings, '123', 'Alpha', execute, controller().signal, vi.fn()),
  ).rejects.toThrow('LARK_WIKI_NAME_AMBIGUOUS');
  expect(execute.mock.calls.some(([, args]) => args.includes('+node-create'))).toBe(false);
});

it('does not create when configuration changes or cancellation wins before the write', async () => {
  for (const cancel of [false, true]) {
    const owner = controller();
    const execute = runner([page([])]);
    const guard = async () => {
      if (cancel) {
        owner.abort();
      } else {
        throw new Error('LARK_TARGET_CONFLICT');
      }
    };
    await expect(
      ensureLarkWorkspaceNode(settings, '123', 'Alpha', execute, owner.signal, guard),
    ).rejects.toThrow();
    expect(execute.mock.calls.some(([, args]) => args.includes('+node-create'))).toBe(false);
  }
});

it('reports possible remote changes when creation or its verification fails', async () => {
  const execute = runner([page([])]);
  const original = execute.getMockImplementation();
  execute.mockImplementation(async (connection, args) => {
    if (args.includes('+node-create')) {
      throw new Error('LARK_CHECK_TIMEOUT');
    }
    return original(connection, args);
  });
  await expect(
    ensureLarkWorkspaceNode(settings, '123', 'Alpha', execute, controller().signal, vi.fn()),
  ).rejects.toMatchObject({
    message: 'LARK_CHECK_TIMEOUT',
    details: { remoteChangePossible: true },
  });
});

it('refuses to bind a matching node moved below another parent during verification', async () => {
  const execute = runner([page([node])]);
  const original = execute.getMockImplementation();
  execute.mockImplementation(async (connection, args) => {
    if (args.includes('+node-get')) {
      return output({ ...node, parent_node_token: 'Moved' });
    }
    return original(connection, args);
  });
  await expect(
    ensureLarkWorkspaceNode(settings, '123', 'Alpha', execute, controller().signal, vi.fn()),
  ).rejects.toThrow('LARK_TARGET_CONFLICT');
});
