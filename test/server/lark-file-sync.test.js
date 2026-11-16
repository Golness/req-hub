import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncLarkFile } from '../../src/server/lark-file-sync.js';
import { createLarkCliRoutes } from '../../src/server/lark-cli.js';

const settings = { profile: 'team', identity: 'user', executable: 'lark-cli', timeoutMs: 30000 };
const auth = { appId: 'app', identities: { user: { available: true, verified: true } } };
const output = (data) => JSON.stringify({ ok: true, data });
const PATH = '11-03 需求/requirement.md';
let root;
let docsRoot;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'req-hub-lark-sync-')));
  docsRoot = join(root, 'docs');
  await mkdir(join(docsRoot, '11-03 需求'), { recursive: true });
  await writeFile(join(docsRoot, '11-03 需求', 'requirement.md'), '# 需求\n\n正文', 'utf8');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const registry = () => ({ list: () => [{ id: 'ws', title: 'WS', path: root }] });
const config = (binding) => ({
  docsDir: 'docs',
  larkTargets: binding ? { ws: { workspaceRoot: root, ...binding } } : {},
});
const folderBinding = {
  kind: 'folder',
  token: 'Root',
  url: 'https://x.feishu.cn/drive/folder/Root',
};
const wikiBinding = {
  kind: 'wiki',
  token: 'Root',
  spaceId: '123',
  url: 'https://x.feishu.cn/wiki/Root',
};
const valueOf = (args, flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : '';
};

/** Fake the bounded CLI runner and record every issued command. */
function runner(state) {
  return vi.fn(async (_settings, args, _signal, input) => {
    state.calls.push({ args, input });
    if (args.includes('status')) {
      return output(state.auth === undefined ? auth : state.auth);
    }
    if (args.includes('+create-folder')) {
      state.createdFolders.push(valueOf(args, '--name'));
      return output({ token: state.folderToken(valueOf(args, '--name')) });
    }
    if (args.includes('+node-create')) {
      state.createdFolders.push(valueOf(args, '--title'));
      return output({ node_token: state.folderToken(valueOf(args, '--title')) });
    }
    if (args.includes('+node-list') || (args.includes('files') && args.includes('list'))) {
      const token = valueOf(args, '--parent-node-token') || valueOf(args, '--folder-token');
      return output(state.listings(token, args));
    }
    if (args.includes('+overwrite') || (args.includes('markdown') && args.includes('+create'))) {
      state.write = { args, input };
      return output({ file_token: 'File1', url: 'https://x.feishu.cn/file/File1' });
    }
    throw new Error('Unexpected command: ' + args.join(' '));
  });
}
const stateOf = (listings = () => ({ files: [], has_more: false })) => ({
  calls: [],
  createdFolders: [],
  folderToken: (name) => (name === 'docs' ? 'DocsFolder' : 'ReqFolder'),
  listings,
  auth: undefined,
  write: null,
});
const sync = (state, binding = folderBinding, path = PATH) =>
  syncLarkFile({
    registry: registry(),
    config: config(binding),
    settings,
    workspaceId: 'ws',
    path,
    execute: runner(state),
    signal: new AbortController().signal,
  });

it('creates missing project/requirement folders and a new Markdown file', async () => {
  const state = stateOf();
  const result = await sync(state);
  expect(state.createdFolders).toEqual(['docs', '11-03 需求']);
  expect(result).toMatchObject({
    action: 'created',
    path: 'docs / 11-03 需求 / requirement.md',
    name: 'requirement.md',
    directoriesCreated: 2,
    fileToken: 'File1',
    url: 'https://x.feishu.cn/file/File1',
  });
  expect(state.write.args).toContain('--content');
  expect(state.write.args).toContain('-');
  expect(state.write.args).toContain('--folder-token');
  expect(state.write.args).toContain('ReqFolder');
  expect(state.write.input).toBe('# 需求\n\n正文');
});

it('reuses existing folders and overwrites a same-named file', async () => {
  const state = stateOf((token) => {
    if (token === 'Root') {
      return { files: [{ name: 'docs', token: 'DocsFolder', type: 'folder' }], has_more: false };
    }
    if (token === 'DocsFolder') {
      return {
        files: [{ name: '11-03 需求', token: 'ReqFolder', type: 'folder' }],
        has_more: false,
      };
    }
    return {
      files: [{ name: 'requirement.md', token: 'Existing', type: 'file' }],
      has_more: false,
    };
  });
  const result = await sync(state);
  expect(state.createdFolders).toEqual([]);
  expect(result.directoriesCreated).toBe(0);
  expect(result.action).toBe('updated');
  expect(state.write.args).toContain('+overwrite');
  expect(state.write.args).toContain('Existing');
  expect(state.write.input).toContain('正文');
});

it('creates Wiki child nodes and uploads under the final wiki node', async () => {
  const state = stateOf(() => ({ nodes: [], has_more: false }));
  const result = await sync(state, wikiBinding);
  expect(result.action).toBe('created');
  expect(state.createdFolders).toEqual(['docs', '11-03 需求']);
  const createNode = state.calls.find(({ args }) => args.includes('+node-create'));
  expect(createNode.args).toContain('--parent-node-token');
  expect(createNode.args).toContain('Root');
  expect(state.write.args).toContain('--wiki-token');
  expect(state.write.args).toContain('ReqFolder');
});

it('overwrites a same-named Wiki file with its object token', async () => {
  const state = stateOf((token) =>
    token === 'Root'
      ? { nodes: [{ title: 'docs', node_token: 'DocsFolder', obj_type: 'docx' }], has_more: false }
      : token === 'DocsFolder'
        ? {
            nodes: [{ title: '11-03 需求', node_token: 'ReqFolder', obj_type: 'docx' }],
            has_more: false,
          }
        : {
            nodes: [
              {
                title: 'requirement.md',
                node_token: 'WikiNode',
                obj_token: 'FileObj',
                obj_type: 'file',
              },
            ],
            has_more: false,
          },
  );
  const result = await sync(state, wikiBinding);
  expect(result.action).toBe('updated');
  expect(state.write.args).toContain('+overwrite');
  expect(state.write.args).toContain('FileObj');
});

it('follows all listing pages before creating a folder', async () => {
  const pages = [
    {
      files: [{ name: 'other', token: 'Other', type: 'folder' }],
      has_more: true,
      page_token: 'p2',
    },
    { files: [{ name: 'docs', token: 'DocsFolder', type: 'folder' }], has_more: false },
  ];
  const state = stateOf((token) => {
    if (token === 'Root') {
      return pages.shift();
    }
    if (token === 'DocsFolder') {
      return { files: [], has_more: false };
    }
    return { files: [], has_more: false };
  });
  const result = await sync(state);
  expect(state.createdFolders).toEqual(['11-03 需求']);
  expect(result.directoriesCreated).toBe(1);
  expect(state.calls.some(({ args }) => args.includes('p2'))).toBe(true);
});

it('normalizes a non-Markdown document name', async () => {
  await writeFile(join(docsRoot, '11-03 需求', 'notes.txt'), '纯文本', 'utf8');
  const state = stateOf();
  const result = await sync(state, folderBinding, '11-03 需求/notes.txt');
  expect(result.name).toBe('notes.md');
  expect(state.write.args).toContain('notes.md');
});

it('rejects an unbound or stale workspace binding', async () => {
  await expect(sync(stateOf(), null)).rejects.toThrow('LARK_TARGET_NOT_BOUND');
  await expect(sync(stateOf(), { ...folderBinding, workspaceRoot: 'D:\\other' })).rejects.toThrow(
    'LARK_TARGET_NOT_BOUND',
  );
});

it('rejects path traversal and empty documents', async () => {
  await expect(sync(stateOf(), folderBinding, '../secret.md')).rejects.toThrow(
    'LARK_SYNC_PATH_INVALID',
  );
  await writeFile(join(docsRoot, '11-03 需求', 'empty.md'), '', 'utf8');
  await expect(sync(stateOf(), folderBinding, '11-03 需求/empty.md')).rejects.toThrow(
    'LARK_SYNC_CONTENT_INVALID',
  );
});

it('stops on duplicate remote names instead of updating an arbitrary file', async () => {
  const state = stateOf((token) => {
    if (token === 'Root') {
      return {
        files: [
          { name: 'docs', token: 'DocsFolder', type: 'folder' },
          { name: 'docs', token: 'DocsFolder2', type: 'folder' },
        ],
        has_more: false,
      };
    }
    return { files: [], has_more: false };
  });
  await expect(sync(state)).rejects.toThrow('LARK_SYNC_NAME_AMBIGUOUS');
  expect(state.write).toBeNull();
});

it('requires a verified CLI identity before any write', async () => {
  const state = stateOf();
  state.auth = { appId: 'app', identities: { user: { available: false, verified: false } } };
  await expect(sync(state)).rejects.toThrow('LARK_AUTH_UNVERIFIED');
  expect(state.write).toBeNull();
});

it('surfaces CLI error envelopes as stable public codes', async () => {
  const execute = vi.fn(async () =>
    JSON.stringify({ ok: false, error: { type: 'authorization', code: 123, subtype: 'denied' } }),
  );
  await expect(
    syncLarkFile({
      registry: registry(),
      config: config(folderBinding),
      settings,
      workspaceId: 'ws',
      path: PATH,
      execute,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('LARK_TARGET_ACCESS_FAILED');
});

it('registers the file-sync action as an authenticated Lark route', async () => {
  const service = createLarkCliRoutes({ list: () => [] });
  expect(service.routes.some((route) => route.path === '/req-hub/lark/file-sync')).toBe(true);
  await service.dispose();
});
