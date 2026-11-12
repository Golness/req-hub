import { expect, it, vi } from 'vitest';
import { inspectLarkTarget, parseLarkTarget } from '../../src/server/lark-target.js';

const settings = { profile: '', identity: 'user' };
const auth = { appId: 'app', identities: { user: { available: true, verified: true } } };
const output = (data) => JSON.stringify({ ok: true, data });

it('binds a selected folder using revalidated remote metadata', async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce(output(auth))
    .mockResolvedValueOnce(
      output({
        type: 'folder',
        token: 'Folder',
        title: 'Remote title',
        url: 'https://team.feishu.cn/drive/folder/Folder',
      }),
    )
    .mockResolvedValueOnce(output({ files: [] }));
  const result = await inspectLarkTarget(
    settings,
    {
      kind: 'folder',
      token: 'Folder',
      title: 'Untrusted title',
    },
    execute,
  );
  expect(result).toMatchObject({
    title: 'Remote title',
    token: 'Folder',
    url: 'https://team.feishu.cn/drive/folder/Folder',
  });
  expect(execute.mock.calls[2][1]).toContain('--folder-token');
});

it('binds a selected nested Wiki node and rejects a different space', async () => {
  const node = {
    node_token: 'Node',
    space_id: '123',
    obj_token: 'Doc',
    obj_type: 'docx',
    title: 'Remote node',
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce(output(auth))
    .mockResolvedValueOnce(output({ node }))
    .mockResolvedValueOnce(output({ wiki_node: node, url: 'https://team.feishu.cn/docx/Doc' }));
  const result = await inspectLarkTarget(
    settings,
    { kind: 'wiki', token: 'Node', spaceId: '123' },
    execute,
  );
  expect(result).toMatchObject({
    title: 'Remote node',
    spaceId: '123',
    url: 'https://team.feishu.cn/wiki/Node',
  });
  execute.mockReset().mockResolvedValueOnce(output(auth)).mockResolvedValueOnce(output({ node }));
  await expect(
    inspectLarkTarget(settings, { kind: 'wiki', token: 'Node', spaceId: '456' }, execute),
  ).rejects.toThrow('LARK_TARGET_INVALID');
  expect(execute).toHaveBeenCalledTimes(2);
});

it('extracts case-sensitive parents and removes share parameters', () => {
  expect(parseLarkTarget('https://team.feishu.cn/drive/folder/FldABC?share=1#x')).toEqual({
    kind: 'folder',
    token: 'FldABC',
    url: 'https://team.feishu.cn/drive/folder/FldABC',
  });
  expect(parseLarkTarget('https://team.larksuite.com/wiki/WikABC').kind).toBe('wiki');
});

it.each([
  'https://team.feishu.cn/docx/DocABC',
  'https://evil.test/wiki/WikABC',
  'https://feishu.cn.evil.test/wiki/WikABC',
  'http://team.feishu.cn/wiki/WikABC',
  'https://user:pass@team.feishu.cn/wiki/WikABC',
  'https://team.feishu.cn:8443/wiki/WikABC',
  'https://team.feishu.cn/wiki/../docx/DocABC',
  'https://team.feishu.cn/wiki/a%2Fb',
  'WikABC',
  null,
])('rejects non-parent and unsafe URLs: %s', (value) => {
  expect(() => parseLarkTarget(value)).toThrow('LARK_TARGET_INVALID');
});
