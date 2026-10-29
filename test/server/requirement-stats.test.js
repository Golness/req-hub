import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createTreeRoutes } from '../../src/server/routes/tree-routes.js';

const settings = vi.hoisted(() => ({ docsDir: 'docs' }));
vi.mock('../../src/server/config.js', () => ({ loadConfig: async () => ({ docsDir: settings.docsDir }) }));
let root, workspaces;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqhub-requirement-stats-'));
  settings.docsDir = 'docs';
  workspaces = [{ id: 'one', title: 'Project', path: join(root, 'one') }];
  await mkdir(workspaces[0].path);
});
afterEach(async () => {
  const local = relative(tmpdir(), root);
  if (isAbsolute(local) || local.startsWith('..') || !local.startsWith('reqhub-requirement-stats-')) throw new Error('Unsafe test cleanup');
  await rm(root, { recursive: true, force: true });
});
async function stats() {
  const route = createTreeRoutes({ list: () => workspaces }).find(route => route.path === '/req-hub/stats');
  const res = { writeHead(status) { this.status = status; }, end(body) { this.data = JSON.parse(body); } };
  await route.handler({ method: 'GET' }, res);
  expect(res.status).toBe(200);
  return res.data;
}
async function directory(path) { await mkdir(join(workspaces[0].path, path), { recursive: true }); }

it('counts only requirement directories at the configured developer level, including empty ones', async () => {
  for (const path of [
    'docs/alice/2026-10-29-empty', 'docs/alice/2026-10-28-many-files',
    'docs/bob/2026-10-29-empty', 'docs/alice/notes',
    'docs/alice/2026-10-29-', 'docs/alice/20261029-wrong-format',
    'docs/.hidden/2026-10-29-hidden', 'docs/2026-10-29-wrong-level',
    'docs/alice/notes/2026-10-29-nested', 'other/alice/2026-10-29-outside-docs',
  ]) await directory(path);
  for (const name of ['requirement.md', 'design.html', 'notes.txt']) {
    await writeFile(join(workspaces[0].path, 'docs/alice/2026-10-28-many-files', name), 'content');
  }
  await writeFile(join(workspaces[0].path, 'docs/alice/2026-10-29-file'), 'not a directory');
  const [row] = await stats();
  expect(row).toMatchObject({ workspaceId: 'one', projectPath: workspaces[0].path, exists: true, requirementCount: 3 });
  expect(row).not.toHaveProperty('docCount');
});

it('returns zero for a real project with no documents directory and reports missing project paths separately', async () => {
  workspaces.push({ id: 'missing', path: join(root, 'missing') });
  expect(await stats()).toMatchObject([
    { workspaceId: 'one', exists: true, requirementCount: 0 },
    { workspaceId: 'missing', exists: false, requirementCount: 0 },
  ]);
});

it('uses each project path and sees directory changes without cached file totals', async () => {
  await directory('docs/alice/2026-10-29-first');
  expect((await stats())[0].requirementCount).toBe(1);
  await directory('docs/alice/2026-10-29-second');
  const second = join(root, 'two');
  await mkdir(join(second, 'docs/bob/2026-10-29-third'), { recursive: true });
  workspaces.push({ id: 'two', title: 'Project', path: second });
  expect((await stats()).map(row => row.requirementCount)).toEqual([2, 1]);
  workspaces[0].path = second;
  expect((await stats())[0].requirementCount).toBe(1);
});

it('honors the configured documents directory', async () => {
  await directory('docs/alice/2026-10-29-ignored');
  await directory('requirements/alice/2026-10-29-included');
  await directory('requirements/bob/2026-10-29-included');
  settings.docsDir = 'requirements';
  expect((await stats())[0].requirementCount).toBe(2);
});

it('rejects document roots that escape the project through a link', async () => {
  const outside = join(root, 'outside');
  await mkdir(join(outside, 'alice/2026-10-29-private'), { recursive: true });
  await symlink(outside, join(workspaces[0].path, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await stats())[0]).toMatchObject({ exists: true, requirementCount: null, errorCode: 'REQUIREMENT_STATS_UNAVAILABLE' });
});

it('does not follow linked developer directories', async () => {
  const outside = join(root, 'outside');
  await mkdir(join(outside, '2026-10-29-private'), { recursive: true });
  await directory('docs');
  await symlink(outside, join(workspaces[0].path, 'docs/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect((await stats())[0]).toMatchObject({ exists: true, requirementCount: 0 });
});
