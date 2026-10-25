import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

vi.mock('../../src/server/task-executor.js', async original => ({ ...await original(), executeTask: vi.fn() }));
vi.mock('../../src/server/config.js', async original => ({ ...await original(), loadConfig: async () => ({ docsDir: 'docs' }) }));
const { executeTask } = await import('../../src/server/task-executor.js');
const { createAnalyzeRoutes } = await import('../../src/server/routes/analyze-routes.js');
let root, base, server, routes, complete;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rh-review-analysis-'));
  await mkdir(join(root, 'docs/alice/2026-10-25-orders'), { recursive: true });
  await writeFile(join(root, 'docs/alice/2026-10-25-orders/requirement.md'), '# 订单\n\n下单。');
  executeTask.mockImplementation(async () => { await new Promise(resolve => { complete = resolve; }); return { output: JSON.stringify({ type: 'requirement', summary: 'late result', features: ['下单'] }), isError: false }; });
  routes = createAnalyzeRoutes({ list: () => [{ id: 'ws', path: root }] }, null, null, { get: () => ({ session: { id: 'parent' } }) }, null, null, {});
  server = createServer((req, res) => { const route = routes.find(item => item.path === new URL(req.url, 'http://x').pathname); route.handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}/req-hub`;
});
afterEach(async () => { complete?.(); await routes.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });
async function start() { const response = await fetch(base + '/analyze-stream?workspaceId=ws&sessionId=parent'); await vi.waitFor(() => expect(executeTask).toHaveBeenCalled()); return response; }

it('cancels the real analysis engine without publishing metadata and holds its execution slot', async () => {
  const response = await start(); const signal = executeTask.mock.calls[0][3].signal;
  expect(signal.aborted).toBe(false);
  expect((await fetch(base + '/analysis-cancel', { method: 'POST' })).status).toBe(200);
  expect(signal.aborted).toBe(true);
  expect((await (await fetch(base + '/analysis-status')).json()).active).toBe(true);
  expect((await fetch(base + '/analyze-stream?workspaceId=ws&sessionId=parent')).status).toBe(409);
  complete(); expect(await response.text()).toContain('cancelled');
  expect((await (await fetch(base + '/analysis-status')).json()).active).toBe(false);
  await expect(readFile(join(root, 'docs/alice/2026-10-25-orders/.meta.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('awaits analysis work on unload and rejects new starts', async () => {
  const response = await start(); let done = false;
  const closing = routes.dispose().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); expect(executeTask.mock.calls[0][3].signal.aborted).toBe(true);
  expect((await fetch(base + '/analyze-stream?workspaceId=ws&sessionId=parent')).status).toBe(503);
  complete(); await closing; await response.text(); expect(done).toBe(true);
  await expect(readFile(join(root, 'docs/alice/2026-10-25-orders/.meta.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves successful analysis and publishes its validated metadata', async () => {
  const response = await start(); complete(); expect(await response.text()).toContain('done');
  const meta = JSON.parse(await readFile(join(root, 'docs/alice/2026-10-25-orders/.meta.json'), 'utf8'));
  expect(meta.summary).toBe('late result');
});
