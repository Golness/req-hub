import { expect, it, vi } from 'vitest';
import { listLarkTargets } from '../../src/server/lark-target-browser.js';
const settings = { executable: 'lark-cli', profile: 'team', identity: 'user', timeoutMs: 1000 };
const signal = new AbortController().signal;
const output = (data) => JSON.stringify({ ok: true, data });

it('reads only direct folders and preserves upstream paging', async () => {
  const execute = vi.fn(async () =>
    output({
      files: [
        { type: 'docx', token: 'Doc', name: 'Not a folder' },
        { type: 'folder', token: 'Child', name: 'Child folder' },
      ],
      has_more: true,
      page_token: 'next-page',
    }),
  );
  const result = await listLarkTargets(
    settings,
    { type: 'folder', parentToken: 'Parent' },
    execute,
    signal,
  );
  expect(result).toEqual({
    items: [{ kind: 'folder', token: 'Child', title: 'Child folder', spaceId: '' }],
    hasMore: true,
    pageToken: 'next-page',
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][1]).toContain('--folder-token');
  expect(execute.mock.calls[0][1]).toContain('Parent');
  expect(execute.mock.calls[0][1]).not.toContain('--page-all');
});

it('separates Wiki spaces from root and nested node requests', async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(
      output({ spaces: [{ space_id: '123', name: 'Engineering' }], has_more: false }),
    )
    .mockResolvedValueOnce(
      output({ nodes: [{ node_token: 'Child', title: 'Guide' }], has_more: false }),
    );
  expect((await listLarkTargets(settings, { type: 'wiki' }, execute, signal)).items[0].kind).toBe(
    'space',
  );
  expect(execute.mock.calls[0][1]).toContain('+space-list');
  await listLarkTargets(
    settings,
    { type: 'wiki', spaceId: '123', parentToken: 'Parent', pageToken: 'cursor' },
    execute,
    signal,
  );
  expect(execute.mock.calls[1][1]).toEqual([
    '--profile',
    'team',
    'wiki',
    '+node-list',
    '--space-id',
    '123',
    '--page-size',
    '50',
    '--parent-node-token',
    'Parent',
    '--page-token',
    'cursor',
    '--as',
    'user',
    '--format',
    'json',
  ]);
});

it.each([
  { type: 'all' },
  { type: 'wiki', parentToken: 'Parent' },
  { type: 'folder', spaceId: '123' },
  { type: 'wiki', spaceId: '--help' },
  { type: 'folder', parentToken: '../Parent' },
])('rejects invalid hierarchy parameters before starting the CLI: %j', async (input) => {
  const execute = vi.fn();
  await expect(listLarkTargets(settings, input, execute, signal)).rejects.toThrow(
    'LARK_TARGET_INVALID',
  );
  expect(execute).not.toHaveBeenCalled();
});

it('fails explicitly on an incomplete cursor contract', async () => {
  const execute = vi.fn(async () => output({ nodes: [], has_more: true }));
  await expect(
    listLarkTargets(settings, { type: 'wiki', spaceId: '123' }, execute, signal),
  ).rejects.toThrow('LARK_RESPONSE_INVALID');
});

it('rejects a repeated cursor instead of looping through the same level', async () => {
  const execute = vi.fn(async () => output({ nodes: [], has_more: true, page_token: 'same' }));
  await expect(
    listLarkTargets(settings, { type: 'wiki', spaceId: '123', pageToken: 'same' }, execute, signal),
  ).rejects.toThrow('LARK_RESPONSE_INVALID');
});
