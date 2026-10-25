import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ReqHub from '../../src/server/index.js';
import { saveConfig, configFilePath } from '../../src/server/config.js';
import { installSyncTools, SYNC_TOOLS } from '../../src/server/sync-controlled-tools.js';
import { executeTask } from '../../src/server/task-executor.js';
import { ConversationStore } from '../../src/server/conversations/store.js';
import { ConversationService } from '../../src/server/conversations/service.js';
import { dshSource } from '../../src/server/conversations/dsh-source.js';

const dsh = resolve(import.meta.dirname, '../../../deepseek-harness');
const available = existsSync(join(dsh, 'packages/client/connection/lib/index.js'));
const load = path => import(/* @vite-ignore */ pathToFileURL(path).href);

it.skipIf(!available)('composes ReqHub with real DSH Cordis, WebServer, Connection, tools and session services', async () => {
  const requireHost = createRequire(join(dsh, 'packages/client/connection/package.json'));
  const { Context } = await load(requireHost.resolve('@deepseek-ai/cordis'));
  const { default: WebServer } = await load(requireHost.resolve('@deepseek-ai/dsh-host-webserver'));
  const Connection = await load(join(dsh, 'packages/client/connection/lib/index.js'));
  const { mountAgentLoopTestDependencies } = await load(join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'));
  const root = await mkdtemp(join(tmpdir(), 'rh-dsh-composition-'));
  const ctx = new Context(); let record;
  vi.stubEnv('DSH_HOME', root); vi.stubEnv('DSH_PROFILE_DIR', root);
  try {
    await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs/a.md'), '# Original');
    await saveConfig({ docsDir: 'docs' });
    await mountAgentLoopTestDependencies(ctx);
    ctx.provide('credentials', { async modifyRecord(_key, update) { const next = await update(record); if (next !== undefined) record = next; return record; } });
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    await ctx.plugin(Connection);
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'fixture', path: root, title: 'Fixture' }] });
    ctx.provide('skills', { load: async () => '', get: async () => null });
    ctx.provide('agentPresets', {}); ctx.provide('sessionQuery', {}); ctx.provide('subagents', {});
    const profileDir = join(root, 'host-profile');
    ctx.provide('profileContext', { name: 'fixture', dir: profileDir });
    const fiber = ctx.plugin(ReqHub, {}); await fiber.await();
    expect(configFilePath()).toBe(join(profileDir, 'req-hub/config.json'));
    await saveConfig({ docsDir: 'docs', developerName: 'profile-owned' });
    expect(JSON.parse(await readFile(join(profileDir, 'req-hub/config.json'), 'utf8')).developerName).toBe('profile-owned');
    expect(JSON.parse(await readFile(join(root, 'req-hub/config.json'), 'utf8')).developerName).toBeUndefined();
    const base = `http://127.0.0.1:${ctx.webServer.port}`;
    expect((await fetch(base + '/req-hub/config')).status).toBe(401);
    let headers;
    const login = new URL(ctx.connection.authenticatedUrl(base + '/'));
    expect(ctx.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: login.host } }, { writeHead(_status, value) { headers = value; }, end() {} })).toBe(false);
    const cookie = headers['set-cookie'].split(';')[0];
    const authenticated = { cookie };
    expect((await fetch(base + '/req-hub/config', { headers: authenticated })).status).toBe(200);
    const conversations = await fetch(base + '/req-hub/conversations-list?workspaceId=fixture', { headers: authenticated });
    expect(conversations.status).toBe(200); expect((await conversations.json()).sessions).toEqual([]);
    expect((await fetch(base + '/req-hub/conversations-list?workspaceId=fixture')).status).toBe(401);
    expect((await fetch(base + '/req-hub/write', { method: 'POST', headers: { ...authenticated, origin: 'https://outside.invalid' }, body: JSON.stringify({ workspaceId: 'fixture', path: 'a.md', content: 'attacked' }) })).status).toBe(403);
    const body = { workspaceId: 'fixture', path: 'a.md', content: '# Via tool' };
    const tool = ctx.tools.get('req_hub_action'); expect(tool).toBeTruthy();
    const output = await tool.execute({ action: 'write', method: 'POST', body }, { signal: new AbortController().signal });
    expect(output.status).toBe(200); expect(await readFile(join(root, 'docs/a.md'), 'utf8')).toBe('# Via tool');
    const response = await fetch(base + '/req-hub/read?workspaceId=fixture&path=a.md', { headers: authenticated });
    expect((await response.json()).text).toBe('# Via tool');
    await fiber.dispose();
    expect(ctx.tools.get('req_hub_action')).toBeUndefined();
    expect((await fetch(base + '/req-hub/config', { headers: authenticated })).status).toBe(404);
  } finally { await ctx.fiber.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);

it.skipIf(!available)('binds controlled evidence to a real DSH spawn child and leaves its parent unaffected', async () => {
  const requireHost = createRequire(join(dsh, 'packages/test-support/agent-loop-testkit/package.json'));
  const requireSpawn = createRequire(join(dsh, 'packages/subagent/subagent-spawn-in-process/package.json'));
  const { Context } = await load(requireHost.resolve('@deepseek-ai/cordis'));
  const { LlmAdapter, createUserMessage } = await load(requireHost.resolve('@deepseek-ai/dsh-llm'));
  const { mountAgentLoopTestDependencies } = await load(join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'));
  const { default: AgentLoop } = await load(requireHost.resolve('@deepseek-ai/dsh-agent-loop'));
  const { default: Subagents } = await load(requireSpawn.resolve('@deepseek-ai/dsh-subagent'));
  const Spawn = await load(join(dsh, 'packages/subagent/subagent-spawn-in-process/lib/index.js'));
  const requests = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model }; }
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        const block = { type: 'tool-call', id: 'read-evidence', name: 'req_hub_sync_read', arguments: JSON.stringify({ artifactId: 'evidence' }) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = requests.length === 2 ? 'child complete' : 'ordinary parent response';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  const ctx = new Context(); let installation;
  try {
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' });
    ctx.llm.registerAdapter(['mock'], new Adapter());
    const parent = await ctx.agentLoop.create('review-parent', { provider: 'mock', model: 'mock' }, { cwd: process.cwd() });
    installation = installSyncTools(ctx);
    const runtime = installation.create({ store: { read: async () => 'complete frozen evidence' }, allowed: ['evidence'], required: ['evidence'], outputs: {} });
    const result = await executeTask(ctx, ctx.llm, {}, {
      parentAgent: parent, promptKey: 'analyze', variables: { requirementId: 'review', docsContent: 'frozen evidence' }, runtime, syncV2: true, liveness: { enabled: false },
      toolFilter: { allow: SYNC_TOOLS }, preparedPromptData: { fullPrompt: 'Read evidence and finish. REQHUB_SYNC_V2=' + runtime.id, skillUsed: null },
    });
    expect(result.isError, result.diagnostic).toBe(false);
    expect(result.output).toContain('child complete'); await runtime.assertCoverage();
    expect(runtime.sessionId).toBe(result.sessionId); expect(ctx.agents.get(result.sessionId)).toBeUndefined();
    runtime.close();
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explain stale REQHUB_SYNC_V2=' + runtime.id }], source: { kind: 'user' } }));
    await parent.whenIdle();
    expect(requests).toHaveLength(3);
    expect(parent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true);
    const libraryRoot = await mkdtemp(join(tmpdir(), 'rh-real-dsh-conversations-'));
    const store = new ConversationStore(join(libraryRoot, 'conversations.sqlite'));
    const library = new ConversationService({ store, owner: 'real-host' });
    try {
      const adapter = dshSource({ registry: { list: () => [{ id: 'real-workspace', path: parent.session.header.cwd || process.cwd() }] }, sessions: ctx.sessions, instance: 'real-host' });
      const imported = await library.refresh('real-workspace', 'real-workspace', adapter);
      const entry = imported.sessions.find(row => row.id === parent.session.id);
      expect(entry?.syncTurnCount).toBe(1);
      const document = await readFile(join(libraryRoot, entry.markdownFile), 'utf8');
      expect(document).toContain('ordinary parent response');
      expect(document).toContain('Explain stale REQHUB_SYNC_V2=');
      const snapshot = await library.snapshot('real-workspace', parent.session.id, adapter);
      expect(snapshot.version).toBe(entry.snapshotVersion);
    } finally { await library.close(); await store.close(); await rm(libraryRoot, { recursive: true, force: true }); }
  } finally { installation?.dispose(); await ctx.fiber.dispose(); }
}, 30000);
