import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { creationStatus, updateMain } from '../../src/server/creation.js';
import { createCreationRoutes } from '../../src/server/routes/creation-routes.js';
import { createOperations } from '../../src/server/operations.js';
import { createTreeRoutes } from '../../src/server/routes/tree-routes.js';
import { configureStorage } from '../../src/server/config.js';
let root, seed, local, remote, workspace;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] }).trim();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rh-create-main-')); seed = join(root, 'seed'); local = join(root, 'local'); remote = join(root, 'remote.git');
  await mkdir(seed); git(root, 'init', '--bare', '--initial-branch=main', remote); git(seed, 'init', '--initial-branch=main');
  git(seed, 'config', 'user.name', 'Fixture'); git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'readme.txt'), 'initial'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-u', 'origin', 'main'); git(root, 'clone', remote, local);
  git(local, 'config', 'user.name', 'Fixture'); git(local, 'config', 'user.email', 'fixture@example.invalid'); workspace = { id: 'w', path: local };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it('detects the actual requirement directory of a valid feature branch', async () => {
  const id = '2026-10-28-ST-TPM'; git(local, 'checkout', '-b', `feature/alice/${id}`);
  await mkdir(join(local, 'docs/alice', id), { recursive: true });
  const result = await creationStatus(workspace, { docsDir: 'docs' });
  expect(result.existingRequirement).toMatchObject({ id, developer: 'alice' }); expect(result.canUpdateMain).toBe(false);
});
it('rejects bypassing the form when the current branch already has its matching directory', async () => {
  const id = '2026-10-28-ST-TPM'; git(local, 'checkout', '-b', `feature/alice/${id}`);
  await mkdir(join(local, 'docs/alice', id), { recursive: true });
  const restore = configureStorage({ docsDir: 'docs' }, { filePath: join(root, 'plugin-config.json') });
  try {
    const operations = createOperations(createTreeRoutes({ list: () => [workspace] }));
    const result = await operations.execute({ action: 'create-dir', method: 'POST', body: { workspaceId: 'w', developer: 'alice', date: '2026-10-29', title: 'Another', createBranch: true, branchName: 'feature/alice/2026-10-29-Another' } }, {});
    expect(result.status).toBe(409); expect(result.value.error).toBe('CREATE_ALREADY_EXISTS');
    expect(git(local, 'branch', '--show-current')).toBe(`feature/alice/${id}`);
    expect(git(local, 'branch', '--list', 'feature/alice/2026-10-29-Another')).toBe('');
  } finally { restore(); }
});
it.each(['main', 'master'])('only fast-forwards a clean %s to its same-name remote branch', async branch => {
  if (branch === 'master') { git(seed, 'branch', '-m', 'master'); git(seed, 'push', '-u', 'origin', 'master'); git(local, 'branch', '-m', 'master'); }
  const before = await creationStatus(workspace, {}); expect(before.canUpdateMain).toBe(true);
  await writeFile(join(seed, 'readme.txt'), 'latest'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'remote update'); git(seed, 'push');
  const result = await updateMain(workspace, before.head, undefined, branch);
  expect(result.branch).toBe(branch);
  expect(result.updated).toBe(true); expect(result.head).toBe(git(seed, 'rev-parse', 'HEAD'));
  expect(await readFile(join(local, 'readme.txt'), 'utf8')).toBe('latest');
});
it('refuses untracked, unstaged and staged changes without altering them', async () => {
  const head = git(local, 'rev-parse', 'HEAD');
  await writeFile(join(local, 'new.txt'), 'untracked'); expect((await creationStatus(workspace, {})).canUpdateMain).toBe(false);
  await expect(updateMain(workspace, head)).rejects.toThrow('CREATE_MAIN_CHANGED');
  await rm(join(local, 'new.txt')); await writeFile(join(local, 'readme.txt'), 'my edits');
  await expect(updateMain(workspace, head)).rejects.toThrow('CREATE_MAIN_CHANGED'); git(local, 'add', 'readme.txt');
  await expect(updateMain(workspace, head)).rejects.toThrow('CREATE_MAIN_CHANGED');
  expect(await readFile(join(local, 'readme.txt'), 'utf8')).toBe('my edits'); expect(git(local, 'rev-parse', 'HEAD')).toBe(head);
});
it('does not merge divergent histories or leave a merge in progress', async () => {
  await writeFile(join(local, 'local.txt'), 'local'); git(local, 'add', '.'); git(local, 'commit', '-m', 'local');
  await writeFile(join(seed, 'remote.txt'), 'remote'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'remote'); git(seed, 'push');
  const head = git(local, 'rev-parse', 'HEAD'); await expect(updateMain(workspace, head)).rejects.toThrow('CREATE_MAIN_MERGE_FAILED');
  expect(git(local, 'rev-parse', 'HEAD')).toBe(head); expect(git(local, 'status', '--porcelain')).toBe('');
  expect(await stat(join(local, '.git/MERGE_HEAD')).then(() => true, () => false)).toBe(false);
});
it('rejects switched branches, changed HEAD, missing remotes and cancelled operations', async () => {
  const head = git(local, 'rev-parse', 'HEAD');
  await expect(updateMain(workspace, '0'.repeat(40))).rejects.toThrow('CREATE_MAIN_CHANGED');
  await expect(updateMain(workspace, head, undefined, 'master')).rejects.toThrow('CREATE_MAIN_CHANGED');
  git(local, 'checkout', '-b', 'other'); await expect(updateMain(workspace, head)).rejects.toThrow('CREATE_MAIN_CHANGED'); git(local, 'checkout', 'main');
  git(local, 'remote', 'remove', 'origin'); await expect(updateMain(workspace, head)).rejects.toThrow('CREATE_MAIN_REMOTE_MISSING');
  const controller = new AbortController(); controller.abort(); await expect(updateMain(workspace, head, controller.signal)).rejects.toThrow();
});
it('does not update a parent repository through a nested workspace', async () => {
  const nested = join(local, 'nested'); await mkdir(nested);
  const target = { id: 'nested', path: nested };
  expect((await creationStatus(target, {})).canUpdateMain).toBe(false);
  await expect(updateMain(target, git(local, 'rev-parse', 'HEAD'))).rejects.toThrow('CREATE_MAIN_CHANGED');
});
it('shares status and main update operations with the Agent action and drains on disposal', async () => {
  const routes = createCreationRoutes({ list: () => [workspace] }, async () => ({ docsDir: 'docs' }));
  const operations = createOperations(routes.routes);
  try {
    const result = await operations.execute({ action: 'create-status', query: { workspaceId: 'w' } }, {});
    expect(result.value.canUpdateMain).toBe(true);
    expect((await operations.execute({ action: 'update-main', method: 'POST', body: { workspaceId: 'w', expectedHead: result.value.head } }, {})).value.success).toBe(true);
  } finally { await routes.dispose(); }
  expect((await operations.execute({ action: 'create-status', query: { workspaceId: 'w' } }, {})).status).toBe(503);
});
