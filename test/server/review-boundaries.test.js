import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { authenticatedRoute, disposeAll } from '../../src/server/plugin-boundaries.js';
import { safeDocumentPath } from '../../src/server/safe-path.js';
import { Config, configureStorage, loadConfig, saveConfig, configFilePath } from '../../src/server/config.js';
import { createOperations } from '../../src/server/operations.js';
import { installSyncTools } from '../../src/server/sync-controlled-tools.js';
import { getScopedSkills } from '../../src/server/prompts.js';
import { delegationContext, bindOwnedSession } from '../../src/server/delegation-context.js';

const roots = [], servers = [], releases = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'rh-review-')); roots.push(root); return root; }
async function listen(handler) { const server = createServer(handler); servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } for (const release of releases.splice(0)) release(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('rejects before calling a privileged handler, including unsafe origins', async () => {
  const handler = vi.fn((_req, res) => res.end('allowed'));
  const connection = { admit: req => req.headers.origin === 'https://untrusted.invalid' ? { rejection: 403 } : req.headers.cookie === 'fixture=authenticated' ? { peer: {} } : { rejection: 401 } };
  const route = authenticatedRoute(connection, { handler });
  const base = await listen(route.handler);
  expect((await fetch(base)).status).toBe(401);
  expect((await fetch(base, { headers: { origin: 'https://untrusted.invalid', cookie: 'fixture=authenticated' } })).status).toBe(403);
  expect(handler).not.toHaveBeenCalled();
  expect(await (await fetch(base, { headers: { cookie: 'fixture=authenticated' } })).text()).toBe('allowed');
  expect(handler).toHaveBeenCalledOnce();
});

it('rejects traversal, absolute and sibling-prefix paths; permits normal and new docs', async () => {
  const root = await fixture(); await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs/a.md'), 'safe');
  for (const input of ['../secret', '..\\secret', '/outside', 'D:\\outside', '../docs-other/a', 'file:stream', '\\outside']) await expect(safeDocumentPath(join(root, 'docs'), input)).rejects.toThrow('outside');
  expect(await readFile(await safeDocumentPath(join(root, 'docs'), 'a.md'), 'utf8')).toBe('safe');
  expect(await safeDocumentPath(join(root, 'new-docs'), 'alice/new.md', { allowMissing: true })).toBe(join(root, 'new-docs/alice/new.md'));
});

it('rejects Windows junctions and missing children behind an escaping link', async () => {
  const root = await fixture(); await mkdir(join(root, 'docs')); await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside/secret.md'), 'secret');
  await symlink(join(root, 'outside'), join(root, 'docs/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(safeDocumentPath(join(root, 'docs'), 'linked/secret.md')).rejects.toThrow('outside');
  await expect(safeDocumentPath(join(root, 'docs'), 'linked/new.md', { allowMissing: true })).rejects.toThrow('outside');
  expect(await readFile(join(root, 'outside/secret.md'), 'utf8')).toBe('secret');
});

it('passes unrelated requests containing live-looking and stale markers unchanged', async () => {
  let hook; const installation = installSyncTools({ tools: { register: () => () => {}, guard: () => () => {} }, on: (_name, callback) => { hook = callback; return () => {}; } });
  try {
    const seen = [];
    for await (const value of hook({ sessionId: 'unrelated', messages: ['REQHUB_SYNC_V2=00000000-0000-0000-0000-000000000000'], tools: [{ name: 'ordinary-tool' }] }, async function* () { yield 'unchanged'; })) seen.push(value);
    expect(seen).toEqual(['unchanged']);
  } finally { installation.dispose(); }
});

it('ignores live markers and auxiliary requests, but rejects the actual revoked child', async () => {
  let hook;
  const ctx = { agents: { get: () => ({ session: { header: { parentSession: 'different-parent' } } }) }, tools: { register: () => () => {}, guard: () => () => {} }, on: (_name, callback) => { hook = callback; return () => {}; } };
  const installation = installSyncTools(ctx);
  const runtime = installation.create({ parentSessionId: 'owner', allowed: [], required: [], outputs: {}, store: {} });
  const run = async request => { const result = []; for await (const value of hook(request, async function* () { yield 'ordinary'; })) result.push(value); return result; };
  try {
    expect(await run({ sessionId: 'unrelated', messages: ['REQHUB_SYNC_V2=' + runtime.id] })).toEqual(['ordinary']);
    expect(await delegationContext.run(runtime, () => run({ messages: ['auxiliary title request'] }))).toEqual(['ordinary']);
    expect(await delegationContext.run(runtime, () => run({ sessionId: 'another-child', messages: [] }))).toEqual(['ordinary']);
    bindOwnedSession(runtime, 'owned-child'); runtime.close();
    await expect(run({ sessionId: 'owned-child', messages: [] })).rejects.toThrow('RUNTIME_CLOSED');
  } finally { installation.dispose(); }
});

it('awaits all asynchronous cleanup owners and reports failures after cleanup', async () => {
  const completed = []; let release;
  const closing = disposeAll([() => new Promise(resolve => { release = () => { completed.push('writing'); resolve(); }; }), async () => { completed.push('knowledge'); throw new Error('close failed'); }, async () => { completed.push('routes'); }]);
  let settled = false; closing.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); expect(completed).toEqual([]);
  release(); await expect(closing).rejects.toThrow('cleanup'); expect(completed).toEqual(['writing', 'knowledge', 'routes']);
});

it('releases cold-session preset leases even when returning the fallback', async () => {
  const dispose = vi.fn(async () => {});
  expect(await getScopedSkills('cold', { observeSession: async () => ({ projections: { values: { agentPreset: 'one' } } }) }, { get: () => null }, { acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: dispose }) })).toBeNull();
  expect(dispose).toHaveBeenCalledOnce();
});

it('uses Standard Schema validation and refuses malformed tunable values', () => {
  expect(Config['~standard'].version).toBe(1);
  for (const value of [[], { docsDir: '../outside' }, { docsDir: 1 }, { ai: [] }, { ai: { enabled: 'true' } }, { ai: { prompts: { writing: 3 } } }]) expect(Config['~standard'].validate(value).issues).toBeTruthy();
  expect(Config['~standard'].validate({ docsDir: 'requirements', ai: { enabled: true } }).value.docsDir).toBe('requirements');
});

it('isolates profile config and refuses corrupt files instead of losing settings', async () => {
  const root = await fixture(); vi.stubEnv('DSH_HOME', root); vi.stubEnv('DSH_PROFILE_DIR', ''); vi.stubEnv('DSH_PROFILE', 'first');
  releases.push(configureStorage({})); await saveConfig({ docsDir: 'requirements', ai: { selectedModel: 'fixture' } });
  const first = configFilePath(); expect(first.startsWith(root)).toBe(true);
  vi.stubEnv('DSH_PROFILE', 'second'); expect(configFilePath()).not.toBe(first);
  await saveConfig({ docsDir: 'second-docs' }); expect((await loadConfig()).docsDir).toBe('second-docs');
  vi.stubEnv('DSH_PROFILE', 'first'); expect((await loadConfig()).docsDir).toBe('requirements');
  await writeFile(first, '{ broken'); await expect(loadConfig()).rejects.toThrow();
});

it('runs UI and tools through the same operation and returns identical failures', async () => {
  const root = await fixture(); const config = { docsDir: 'docs' };
  const handler = async (req, res) => {
    if (req.method === 'POST') { let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text); if (body.fail) { res.writeHead(409); res.end(JSON.stringify({ error: 'conflict' })); return; } Object.assign(config, body); await writeFile(join(root, 'saved.json'), JSON.stringify(config)); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(config));
  };
  const operations = createOperations([{ kind: 'exact', path: '/req-hub/config', handler }, { kind: 'exact', path: '/req-hub/open-in-explorer', handler }]);
  const base = await listen(operations.routes[0].handler);
  const tool = await operations.execute({ action: 'config', method: 'POST', body: { docsDir: 'custom' } }, { agent: { session: { id: 'actual' } } });
  const ui = await fetch(base); expect(tool.value).toEqual(await ui.json());
  expect(JSON.parse(await readFile(join(root, 'saved.json'), 'utf8')).docsDir).toBe('custom');
  const failure = await operations.execute({ action: 'config', method: 'POST', body: { fail: true } }, {});
  expect(failure).toEqual({ status: 409, value: { error: 'conflict' } });
  expect(operations.actions).not.toContain('open-in-explorer');
});

it('binds delegation to the real caller while preserving selected evidence session IDs', async () => {
  const capture = async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    res.end(JSON.stringify({ headers: req.headers, body: text ? JSON.parse(text) : null, query: Object.fromEntries(new URL(req.url, 'http://x').searchParams) }));
  };
  const operations = createOperations([{ kind: 'prefix', path: '/req-hub/writing', handler: capture }, { kind: 'exact', path: '/req-hub/session-turns', handler: capture }, { kind: 'exact', path: '/req-hub/phased-sync', handler: capture }]);
  const exec = { agent: { session: { id: 'real-caller' } } };
  const writing = await operations.execute({ action: 'writing-optimize', method: 'POST', body: { sessionId: 'forged' } }, exec);
  expect(writing.value.body.sessionId).toBe('real-caller');
  const sync = await operations.execute({ action: 'phased-sync', method: 'POST', body: { sessionIds: ['codex:selected'] } }, exec);
  expect(sync.value.headers['x-session-id']).toBe('real-caller');
  expect(sync.value.body.sessionIds).toEqual(['codex:selected']);
  const evidence = await operations.execute({ action: 'session-turns', query: { sessionId: 'codex:selected' } }, exec);
  expect(evidence.value.query.sessionId).toBe('codex:selected');
});
