import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  larkPushFailure,
  pushKnowledgeArtifacts,
  pushSyncArtifacts,
} from '../../src/server/lark-scheduled-push.js';
import { pushLarkDocuments } from '../../src/server/lark-file-sync.js';

let root;
let docsRoot;
let directory;
const signal = () => new AbortController().signal;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'req-hub-lark-push-')));
  docsRoot = join(root, 'docs');
  directory = join(docsRoot, 'alice', '2026-11-13-需求');
  await mkdir(directory, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const larkService = (result) => ({
  pushDocuments: vi.fn(async ({ documents }) => ({
    results:
      result ||
      documents.map((document) => ({
        name: document.name,
        path: [...document.segments, document.name].join(' / '),
        action: 'created',
        url: 'https://x.feishu.cn/file/File1',
        fileToken: 'File1',
      })),
    directoriesCreated: 0,
  })),
});
const collect = () => {
  const items = [];
  return {
    items,
    onItem: (key, item) => items.push({ key, item }),
  };
};
const pushSync = (lark, onItem, extra = {}) =>
  pushSyncArtifacts({
    lark,
    config: { docsDir: 'docs' },
    workspaceId: 'ws',
    docsRoot,
    directory,
    keyPrefix: 'feature/alice/2026-11-13-需求',
    signal: signal(),
    onItem,
    ...extra,
  });

describe('scheduled sync products', () => {
  it('publishes requirement.md and design.md under the mirrored docs path', async () => {
    await writeFile(join(directory, 'requirement.md'), '# 需求\n\n正文', 'utf8');
    await writeFile(join(directory, 'design.md'), '# 方案', 'utf8');
    const lark = larkService();
    const { items, onItem } = collect();
    const counts = await pushSync(lark, onItem);

    expect(counts).toEqual({ pushed: 2, skipped: 0, failed: 0 });
    expect(lark.pushDocuments).toHaveBeenCalledTimes(1);
    const { workspaceId, documents } = lark.pushDocuments.mock.calls[0][0];
    expect(workspaceId).toBe('ws');
    expect(documents.map((item) => item.name)).toEqual(['requirement.md', 'design.md']);
    expect(documents[0].segments).toEqual(['docs', 'alice', '2026-11-13-需求']);
    expect(documents[0].content).toBe('# 需求\n\n正文');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      key: 'lark:feature/alice/2026-11-13-需求:requirement.md',
      item: { kind: 'lark', status: 'completed', action: 'created' },
    });
  });

  it('publishes only the document that a branch actually produced', async () => {
    await writeFile(join(directory, 'design.md'), '# 方案', 'utf8');
    const lark = larkService();
    const { items, onItem } = collect();
    await pushSync(lark, onItem);
    expect(lark.pushDocuments.mock.calls[0][0].documents.map((item) => item.name)).toEqual([
      'design.md',
    ]);
    expect(items[0].item.path).toContain('design.md');
  });

  it('skips empty products without calling the CLI', async () => {
    await writeFile(join(directory, 'requirement.md'), '   \n', 'utf8');
    const lark = larkService();
    const { items, onItem } = collect();
    const counts = await pushSync(lark, onItem);
    expect(counts).toEqual({ pushed: 0, skipped: 1, failed: 0 });
    expect(lark.pushDocuments).not.toHaveBeenCalled();
    expect(items[0].item).toMatchObject({
      status: 'skipped',
      reason: 'LARK_PUSH_NO_DOCUMENTS',
    });
  });

  it('records an unbound workspace as a skipped configuration problem', async () => {
    await writeFile(join(directory, 'requirement.md'), '# 需求', 'utf8');
    const lark = {
      pushDocuments: vi.fn(async () => {
        throw new Error('LARK_TARGET_NOT_BOUND');
      }),
    };
    const { items, onItem } = collect();
    const counts = await pushSync(lark, onItem);
    expect(counts).toEqual({ pushed: 0, skipped: 1, failed: 0 });
    expect(items[0].item).toMatchObject({
      status: 'skipped',
      reason: 'LARK_TARGET_NOT_BOUND',
    });
    expect(items[0].item.error).toBeUndefined();
  });

  it('records a CLI write error as a standalone failed push item', async () => {
    await writeFile(join(directory, 'requirement.md'), '# 需求', 'utf8');
    const lark = {
      pushDocuments: vi.fn(async () => {
        throw new Error('LARK_NETWORK_FAILED');
      }),
    };
    const { items, onItem } = collect();
    const counts = await pushSync(lark, onItem);
    expect(counts).toEqual({ pushed: 0, skipped: 0, failed: 1 });
    expect(items[0].item).toMatchObject({ status: 'failed', error: 'LARK_NETWORK_FAILED' });
  });

  it('refuses a requirement directory outside the authorized docs root', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'requirement.md'), '# 需求', 'utf8');
    const lark = larkService();
    const { items, onItem } = collect();
    await pushSync(lark, onItem, { directory: outside });
    expect(lark.pushDocuments).not.toHaveBeenCalled();
    expect(items[0].item).toMatchObject({
      status: 'skipped',
      reason: 'LARK_SYNC_PATH_INVALID',
    });
  });
});

describe('scheduled knowledge products', () => {
  const store = () => ({ path: (...parts) => join(root, 'scope', ...parts) });
  const release = async (generationId = 'gen-1') => {
    const scope = join(root, 'scope');
    await mkdir(join(scope, 'releases', generationId, 'wiki', 'sources'), { recursive: true });
    await writeFile(join(scope, 'current.json'), JSON.stringify({ generationId }), 'utf8');
    const wiki = join(scope, 'releases', generationId, 'wiki');
    await writeFile(join(wiki, 'index.md'), '# 索引', 'utf8');
    await writeFile(join(wiki, 'overview.md'), '# 总览', 'utf8');
    await writeFile(join(wiki, 'sources', 'src-1.md'), '# 来源', 'utf8');
    await writeFile(join(wiki, 'manifest.json'), '{}', 'utf8');
  };
  const pushWiki = (lark, onItem, waitForCompile) =>
    pushKnowledgeArtifacts({
      lark,
      config: { docsDir: 'docs' },
      store: store(),
      workspaceId: 'ws',
      signal: signal(),
      waitForCompile,
      onItem,
    });

  it('waits for compile, then publishes every Markdown page of the current release', async () => {
    await release();
    const lark = larkService();
    const { items, onItem } = collect();
    const waitForCompile = vi.fn(async () => {});
    const result = await pushWiki(lark, onItem, waitForCompile);

    expect(waitForCompile).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pushed: 3, generationId: 'gen-1' });
    const { documents } = lark.pushDocuments.mock.calls[0][0];
    expect(documents.map((item) => item.name)).toEqual(['index.md', 'overview.md', 'src-1.md']);
    expect(documents[2].segments).toEqual(['docs', 'knowledge-v2', 'sources']);
    expect(items.every(({ item }) => item.status === 'completed')).toBe(true);
    expect(items[0].item.generationId).toBe('gen-1');
  });

  it('skips when no Wiki generation has been published yet', async () => {
    const scope = join(root, 'scope');
    await mkdir(scope, { recursive: true });
    await writeFile(join(scope, 'current.json'), JSON.stringify({ generationId: null }), 'utf8');
    const lark = larkService();
    const { items, onItem } = collect();
    const result = await pushWiki(lark, onItem);
    expect(result).toMatchObject({ pushed: 0, skipped: 1, generationId: null });
    expect(lark.pushDocuments).not.toHaveBeenCalled();
    expect(items[0].item).toMatchObject({ status: 'skipped', reason: 'LARK_PUSH_NO_WIKI' });
  });

  it('skips when the published generation has no readable wiki directory', async () => {
    const scope = join(root, 'scope');
    await mkdir(scope, { recursive: true });
    await writeFile(join(scope, 'current.json'), JSON.stringify({ generationId: 'gen-x' }), 'utf8');
    const lark = larkService();
    const { items, onItem } = collect();
    const result = await pushWiki(lark, onItem);
    expect(result).toMatchObject({ pushed: 0, skipped: 1, generationId: 'gen-x' });
    expect(items[0].item.reason).toBe('LARK_PUSH_NO_WIKI');
  });

  it('does not fail the knowledge run when the Lark target is unbound', async () => {
    await release();
    const lark = {
      pushDocuments: vi.fn(async () => {
        throw new Error('LARK_TARGET_NOT_BOUND');
      }),
    };
    const { items, onItem } = collect();
    const result = await pushWiki(lark, onItem);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(items[0].item.status).toBe('skipped');
  });
});

describe('batch publisher', () => {
  const settings = { profile: '', identity: 'user', executable: 'lark-cli', timeoutMs: 30000 };
  // Remote tokens only accept alphanumerics; hex keeps names distinguishable.
  const folderToken = (name) => 'D' + Buffer.from(name, 'utf8').toString('hex').slice(0, 24);
  const runner = () => {
    const calls = [];
    const execute = vi.fn(async (_settings, args, _signal, input) => {
      calls.push({ args, input });
      if (args.includes('status')) {
        return JSON.stringify({
          ok: true,
          data: { appId: 'app', identities: { user: { available: true, verified: true } } },
        });
      }
      if (args.includes('+create-folder')) {
        const name = args[args.indexOf('--name') + 1];
        return JSON.stringify({ ok: true, data: { token: folderToken(name) } });
      }
      if (args.includes('files') && args.includes('list')) {
        return JSON.stringify({ ok: true, data: { files: [], has_more: false } });
      }
      if (args.includes('markdown')) {
        return JSON.stringify({
          ok: true,
          data: { file_token: 'File1', url: 'https://x.feishu.cn/file/File1' },
        });
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    });
    return { calls, execute };
  };
  const publish = (documents, state) =>
    pushLarkDocuments({
      registry: { list: () => [{ id: 'ws', title: 'WS', path: root }] },
      config: {
        docsDir: 'docs',
        larkTargets: {
          ws: { workspaceRoot: root, kind: 'folder', token: 'Root' },
        },
      },
      settings,
      workspaceId: 'ws',
      documents,
      execute: state.execute,
      signal: signal(),
    });

  it('shares authentication and directory creation across a whole release', async () => {
    const state = runner();
    const documents = ['a.md', 'b.md', 'c.md'].map((name) => ({
      segments: ['docs', 'knowledge-v2'],
      name,
      content: '# ' + name,
    }));
    const { results, directoriesCreated } = await publish(documents, state);
    expect(results.map((item) => item.action)).toEqual(['created', 'created', 'created']);
    expect(directoriesCreated).toBe(2);
    expect(state.calls.filter(({ args }) => args.includes('status'))).toHaveLength(1);
    expect(state.calls.filter(({ args }) => args.includes('+create-folder'))).toHaveLength(2);
    expect(state.calls.filter(({ args }) => args.includes('+create'))).toHaveLength(3);
    // The final parent is listed once, then reused for every page.
    expect(
      state.calls.filter(
        ({ args }) =>
          args.includes('list') &&
          args.includes('--folder-token') &&
          args.includes(folderToken('knowledge-v2')),
      ),
    ).toHaveLength(1);
  });

  it('overwrites instead of duplicating a repeated name in the same batch', async () => {
    const state = runner();
    const document = (content) => ({
      segments: ['docs'],
      name: 'index.md',
      content,
    });
    const { results } = await publish([document('# A'), document('# B')], state);
    expect(results.map((item) => item.action)).toEqual(['created', 'updated']);
    const overwrite = state.calls.find(({ args }) => args.includes('+overwrite'));
    expect(overwrite.input).toBe('# B');
    expect(state.calls.filter(({ args }) => args.includes('+create'))).toHaveLength(1);
  });
});

describe('stable push error mapping', () => {
  it('separates configuration problems from delivery failures', () => {
    expect(larkPushFailure(new Error('LARK_TARGET_NOT_BOUND'))).toEqual({
      code: 'LARK_TARGET_NOT_BOUND',
      status: 'skipped',
    });
    expect(larkPushFailure(new Error('LARK_NETWORK_FAILED'))).toEqual({
      code: 'LARK_NETWORK_FAILED',
      status: 'failed',
    });
    expect(larkPushFailure(new Error('connection reset'))).toEqual({
      code: 'LARK_PUSH_FAILED',
      status: 'failed',
    });
  });
});
