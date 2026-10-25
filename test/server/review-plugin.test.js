import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../../src/server/index.js';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { createOperations } from '../../src/server/operations.js';
import { saveConfig } from '../../src/server/config.js';

let root, close;
afterEach(async () => { await close?.(); vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); close = null; });
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'rh-plugin-review-')); vi.stubEnv('DSH_HOME', root); vi.stubEnv('DSH_PROFILE_DIR', root);
  const routes = new Map(), definitions = new Map(), scopeDisposers = [];
  const ctx = {
    workspaceRegistry: { list: () => [] }, connection: { admit: () => ({ peer: {} }) },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
    skills: { async list() { return []; }, async get() { return { name: 'one', content: 'fixture' }; } },
    agents: { get: () => undefined }, agentPresets: { async acquireScope() { const dispose = vi.fn(async () => {}); scopeDisposers.push(dispose); return { key: {}, [Symbol.asyncDispose]: dispose }; } },
    sessionQuery: { observeSession: async () => ({ header: { cwd: root }, projections: { values: { agentPreset: 'one' } } }) },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name); }, guard: () => () => {} },
    on: () => () => {}, effect: factory => factory(),
  };
  close = apply(ctx); return { ctx, routes, definitions, scopeDisposers };
}
it('releases both skill-route leases on successful reads and failures', async () => {
  const { ctx, routes, scopeDisposers } = await fixture();
  const operations = createOperations([...routes.values()]);
  for (const action of ['skills', 'skill-content']) await operations.execute({ action, query: { sessionId: 'cold', name: 'one' } }, { agent: { session: { id: 'cold' } } });
  expect(scopeDisposers).toHaveLength(2); for (const dispose of scopeDisposers) expect(dispose).toHaveBeenCalledOnce();
  ctx.skills.list = async () => { throw new Error('read failure'); };
  expect((await operations.execute({ action: 'skills', query: { sessionId: 'cold' } }, { agent: { session: { id: 'cold' } } })).status).toBe(500);
  expect(scopeDisposers.at(-1)).toHaveBeenCalledOnce();
});
it('awaits the actual plugin knowledge owner and unregisters every route and tool', async () => {
  let release; const original = KnowledgeService.prototype.close;
  vi.spyOn(KnowledgeService.prototype, 'close').mockImplementation(async function () { await new Promise(resolve => { release = resolve; }); await original.call(this); });
  const { routes, definitions } = await fixture(); let done = false;
  expect(definitions.has('req_hub_action')).toBe(true);
  const closing = close().then(() => { done = true; }); close = null;
  await vi.waitFor(() => expect(release).toBeTypeOf('function')); expect(done).toBe(false);
  release(); await closing; expect(done).toBe(true); expect(routes.size).toBe(0); expect(definitions.size).toBe(0);
});

it('guards real sync-file and write routes while preserving normal file operations', async () => {
  const { ctx, routes } = await fixture();
  ctx.workspaceRegistry.list = () => [{ id: 'ws', path: root }];
  await saveConfig({ docsDir: 'docs' });
  const requirement = '2026-10-25-orders', relative = 'alice/' + requirement;
  await mkdir(join(root, 'docs', relative), { recursive: true }); await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside/secret.md'), 'secret'); await writeFile(join(root, 'docs', relative, 'result.md'), 'result');
  await symlink(join(root, 'outside'), join(root, 'docs/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const operations = createOperations([...routes.values()]);
  expect((await operations.execute({ action: 'sync-file', query: { workspaceId: 'ws', requirementId: requirement, fileName: 'result.md' } }, {})).value.content).toBe('result');
  expect((await operations.execute({ action: 'sync-file', query: { workspaceId: 'ws', requirementId: requirement, fileName: '../../../outside/secret.md' } }, {})).status).toBe(403);
  expect((await operations.execute({ action: 'write', method: 'POST', body: { workspaceId: 'ws', path: 'linked/secret.md', content: 'overwritten' } }, {})).status).toBe(403);
  expect(await readFile(join(root, 'outside/secret.md'), 'utf8')).toBe('secret');
  expect((await operations.execute({ action: 'write', method: 'POST', body: { workspaceId: 'ws', path: relative + '/result.md', content: 'edited' } }, {})).status).toBe(200);
  expect(await readFile(join(root, 'docs', relative, 'result.md'), 'utf8')).toBe('edited');
  const outside = await mkdtemp(join(tmpdir(), 'rh-outside-docs-'));
  try {
    await mkdir(join(outside, relative), { recursive: true });
    await writeFile(join(outside, relative, 'result.md'), 'outside workspace');
    await symlink(outside, join(root, 'external-docs'), process.platform === 'win32' ? 'junction' : 'dir');
    await saveConfig({ docsDir: 'external-docs' });
    expect((await operations.execute({ action: 'sync-file', query: { workspaceId: 'ws', requirementId: requirement, fileName: 'result.md' } }, {})).status).toBe(403);
  } finally {
    // Remove the junction before its separately owned temporary target.
    await rm(join(root, 'external-docs'), { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
