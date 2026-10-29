import { EnhancementRuntime, installEnhancementTools, ENHANCEMENT_TOOLS } from '../../src/server/knowledge/enhancements/runtime.js';
import { DEFAULTS as ENHANCEMENT_DEFAULTS } from '../../src/server/knowledge/enhancements/contracts.js';
import { CodeProvider } from '../../src/server/knowledge/enhancements/code-provider.js';
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
import { resolveSyncBudget } from '../../src/server/sync-budget.js';
import { executeTask } from '../../src/server/task-executor.js';
import { ConversationStore } from '../../src/server/conversations/store.js';
import { ConversationService } from '../../src/server/conversations/service.js';
import { dshSource } from '../../src/server/conversations/dsh-source.js';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { createConversationKnowledgeRoutes } from '../../src/server/routes/conversation-knowledge-routes.js';
import { createOperations } from '../../src/server/operations.js';

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
    const directoryTree = await fetch(base + '/req-hub/tree?workspaceId=fixture', { headers: authenticated });
    expect(directoryTree.status).toBe(200); expect((await directoryTree.json()).caseSensitivePaths).toBe(process.platform !== 'win32');
    const fileDirectory = join(root, 'docs/alice/2026-10-28-files');
    await mkdir(fileDirectory, { recursive: true }); await writeFile(join(fileDirectory, 'requirement.md'), '# Fixture');
    const fileTree = await fetch(base + '/req-hub/file-tree?workspaceId=fixture&requirementId=2026-10-28-files&requirementPath=alice%2F2026-10-28-files', { headers: authenticated });
    expect(fileTree.status).toBe(200); expect((await fileTree.json()).tree[0].absolutePath).toBe(join(fileDirectory, 'requirement.md'));
    const enhancements = await fetch(base + '/req-hub/knowledge/enhancements/jobs?workspaceId=fixture', { headers: authenticated });
    expect(enhancements.status).toBe(200); expect((await enhancements.json()).enabled).toBe(false);
    const codeRefresh = await fetch(base + '/req-hub/knowledge/enhancements/jobs', {
      method: 'POST', headers: { ...authenticated, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'fixture', kind: 'code-refresh', mode: null, useCode: true, requestKey: 'http-refresh', documentRefs: [], scopeIds: [] }),
    });
    expect(codeRefresh.status, await codeRefresh.clone().text()).toBe(202);
    const refreshJob = await codeRefresh.json(); expect(refreshJob.kind).toBe('code-refresh');
    expect((await fetch(base + '/req-hub/knowledge/enhancements/jobs?workspaceId=fixture')).status).toBe(401);
    const { createMcpToolDefinition } = await load(join(dsh, 'packages/mcp/mcp-client/lib/index.js'));
    const repositoryPage = { repositories: [{ name: 'fixture', path: root }], pagination: { total: 1, offset: 0, returned: 1, hasMore: false } };
    const mcpCall = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(repositoryPage) + '\n\n---\nNext' }] }));
    ctx.tools.register(createMcpToolDefinition(ctx, { name: 'mcp__gitnexus__list_repos', rawName: 'list_repos', description: 'Fixture MCP repository list', inputSchema: { type: 'object', properties: {} }, call: mcpCall }));
    const codeProvider = new CodeProvider(ctx);
    expect(await codeProvider.repositories('gitnexus', new AbortController().signal)).toEqual(repositoryPage.repositories);
    const denyMcp = ctx.tools.guard(exec => exec.name === 'mcp__gitnexus__list_repos' ? 'Fixture policy denial' : undefined);
    await expect(codeProvider.call('gitnexus', 'list_repos', {}, new AbortController().signal)).rejects.toThrow('UNAVAILABLE');
    expect(mcpCall).toHaveBeenCalledTimes(1); denyMcp();
    const conversations = await fetch(base + '/req-hub/conversations-list?workspaceId=fixture', { headers: authenticated });
    expect(conversations.status).toBe(200); expect((await conversations.json()).sessions).toEqual([]);
    expect((await fetch(base + '/req-hub/conversations-list?workspaceId=fixture')).status).toBe(401);
    const importOptions = await fetch(base + '/req-hub/conversations-knowledge-options', { headers: authenticated });
    expect(importOptions.status).toBe(200); expect((await importOptions.json()).targets[0].id).toBe('fixture');
    expect((await fetch(base + '/req-hub/conversations-knowledge-options')).status).toBe(401);
    expect((await fetch(base + '/req-hub/write', { method: 'POST', headers: { ...authenticated, origin: 'https://outside.invalid' }, body: JSON.stringify({ workspaceId: 'fixture', path: 'a.md', content: 'attacked' }) })).status).toBe(403);
    const body = { workspaceId: 'fixture', path: 'a.md', content: '# Via tool' };
    const tool = ctx.tools.get('req_hub_action'); expect(tool).toBeTruthy();
    for (const action of ['analyze-preview', 'analyze-stream', 'analysis-status', 'analysis-cancel', 'meta']) {
      expect((await fetch(base + '/req-hub/' + action, { headers: authenticated })).status).toBe(404);
      await expect(tool.execute({ action }, { signal: new AbortController().signal })).rejects.toThrow('UNKNOWN_OPERATION');
    }
    const output = await tool.execute({ action: 'write', method: 'POST', body }, { signal: new AbortController().signal });
    expect(output.status).toBe(200); expect(await readFile(join(root, 'docs/a.md'), 'utf8')).toBe('# Via tool');
    const response = await fetch(base + '/req-hub/read?workspaceId=fixture&path=a.md', { headers: authenticated });
    expect((await response.json()).text).toBe('# Via tool');
    await fiber.dispose();
    expect(ctx.tools.get('req_hub_action')).toBeUndefined();
    expect((await fetch(base + '/req-hub/config', { headers: authenticated })).status).toBe(404);
  } finally { await ctx.fiber.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 30000);

it.skipIf(!available).each([[false, false], [true, false], [false, true], [false, 'outputs']])('binds controlled evidence to a real DSH spawn child (child-local tool: %s, premature stop: %s)', async (childLocalTool, earlyFinish) => {
  const requireHost = createRequire(join(dsh, 'packages/test-support/agent-loop-testkit/package.json'));
  const requireSpawn = createRequire(join(dsh, 'packages/subagent/subagent-spawn-in-process/package.json'));
  const { Context } = await load(requireHost.resolve('@deepseek-ai/cordis'));
  const { LlmAdapter, createUserMessage } = await load(requireHost.resolve('@deepseek-ai/dsh-llm'));
  const { mountAgentLoopTestDependencies } = await load(join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'));
  const { default: AgentLoop } = await load(requireHost.resolve('@deepseek-ai/dsh-agent-loop'));
  const { default: Subagents } = await load(requireSpawn.resolve('@deepseek-ai/dsh-subagent'));
  const Spawn = await load(join(dsh, 'packages/subagent/subagent-spawn-in-process/lib/index.js'));
  const requests = [];
  let localCalls = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 256000 } }; }
    async *stream(request) {
      requests.push(request);
      const writingOutput = earlyFinish === 'outputs' && [4, 5].includes(requests.length);
      if (requests.length === (earlyFinish ? 2 : 1) || writingOutput) {
        expect(request.tools.some(tool => tool.name === 'outside_evidence')).toBe(false);
        if (childLocalTool) {
          expect(request.tools.some(tool => tool.name === 'child_session_helper')).toBe(true);
          for (const nested of [false, true]) {
            const denied = await ctx.tools.execute({ name: 'child_session_helper', arguments: {}, callId: `denied-${nested}`,
              agent: ctx.agents.get(request.sessionId), signal: new AbortController().signal,
              ...(nested ? { parent: Symbol('run_code') } : {}) });
            expect(JSON.stringify(denied.content)).toContain('禁止旁路工具');
          }
          expect(localCalls).toBe(0);
        }
        const outputId = requests.length === 4 ? 'report' : 'changes';
        const block = writingOutput
          ? { type: 'tool-call', id: `write-${outputId}`, name: 'req_hub_sync_write', arguments: JSON.stringify({ outputId, content: outputId === 'report' ? 'verified report' : '{"changes":[],"pending":[]}' }) }
          : { type: 'tool-call', id: 'read-evidence', name: 'req_hub_sync_read', arguments: JSON.stringify({ artifactId: 'evidence' }) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = earlyFinish && requests.length === 1 ? 'Premature completion claim'
          : earlyFinish === 'outputs' && requests.length === 3 ? 'I already wrote the files'
          : requests.length === (earlyFinish === 'outputs' ? 6 : earlyFinish ? 3 : 2) ? 'child complete' : 'ordinary parent response';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  const ctx = new Context(); let installation, outputRoot;
  try {
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' });
    ctx.llm.registerAdapter(['mock'], new Adapter());
    ctx.tools.register({ name: 'outside_evidence', description: 'Unrelated inherited capability', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async () => 'outside evidence' });
    const parent = await ctx.agentLoop.create('review-parent', { provider: 'mock', model: 'mock' }, { cwd: process.cwd() });
    if (childLocalTool) ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.parentSession !== parent.session.id) return;
      agent.ctx.tools.register({ name: 'child_session_helper', description: 'Scope-local framework fixture', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        execute: async () => { localCalls++; return 'must not run'; } });
    }, { global: true });
    installation = installSyncTools(ctx);
    const budget = await resolveSyncBudget({ ctx, llm: ctx.llm, parentAgent: parent, agentOptions: { maxTokens: 8000 } });
    expect(budget.contextWindow).toBe(256000); expect(budget.source).toBe('model');
    outputRoot = await mkdtemp(join(tmpdir(), 'rh-real-sync-outputs-'));
    const outputs = earlyFinish === 'outputs' ? { report: join(outputRoot, 'report.md'), changes: join(outputRoot, 'changes.json') } : {};
    const runtime = installation.create({ store: { read: async () => 'complete frozen evidence' }, allowed: ['evidence'], required: ['evidence'], outputs, budget });
    const result = await executeTask(ctx, ctx.llm, {}, {
      parentAgent: parent, promptKey: 'phased-code-analysis-requirement', variables: { runtimeId: runtime.id, manifestId: 'manifest' }, runtime, syncV2: true, liveness: { enabled: false },
      toolFilter: { allow: SYNC_TOOLS }, preparedPromptData: { fullPrompt: 'Read evidence and finish. REQHUB_SYNC_V2=' + runtime.id, skillUsed: null },
    });
    expect(result.isError, result.diagnostic).toBe(false);
    expect(result.output).toContain('child complete'); await runtime.assertCoverage();
    if (earlyFinish) {
      expect(runtime.completionReminders).toBe(earlyFinish === 'outputs' ? 2 : 1);
      expect(JSON.stringify(requests[1].messages)).toContain('NOT complete');
      if (earlyFinish === 'outputs') {
        expect(await readFile(outputs.report, 'utf8')).toBe('verified report');
        expect(JSON.parse(await readFile(outputs.changes, 'utf8'))).toEqual({ changes: [], pending: [] });
        expect(JSON.stringify(requests[3].messages)).toContain('missingOutputs');
      }
    }
    expect(runtime.inputLimit).toBe(budget.limit); expect(runtime.maxRequestCost).toBeGreaterThan(0);
    expect(runtime.sessionId).toBe(result.sessionId); expect(ctx.agents.get(result.sessionId)).toBeUndefined();
    runtime.close();
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explain stale REQHUB_SYNC_V2=' + runtime.id }], source: { kind: 'user' } }));
    await parent.whenIdle();
    expect(requests).toHaveLength(earlyFinish === 'outputs' ? 7 : earlyFinish ? 4 : 3);
    expect(requests.at(-1).tools.some(tool => tool.name === 'outside_evidence')).toBe(true);
    expect(parent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(true);
    const libraryRoot = await mkdtemp(join(tmpdir(), 'rh-real-dsh-conversations-'));
    const store = new ConversationStore(join(libraryRoot, 'conversations.sqlite'));
    const library = new ConversationService({ store, owner: 'real-host' });
    try {
      // Use the real registry/entity implementation. Only its durable medium is
      // in memory; plain object workspace fixtures miss prototype getter bugs.
      const { default: WorkspaceRegistry } = await load(join(dsh, 'packages/workspace/workspace/lib/index.js'));
      let state = { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] };
      const records = new Map(); records.put = async (id, record) => records.set(id, record);
      ctx.provide('sessionPersistence', { list: async () => [] });
      ctx.provide('storageDomain', { open: async () => ({ table: () => records, global: { get: () => state, set: async value => { state = value; } }, close: async () => {} }) });
      await ctx.plugin(WorkspaceRegistry);
      const workspace = await ctx.workspaceRegistry.create(parent.session.header.cwd || process.cwd(), 'Real DSH workspace');
      expect(Object.hasOwn(workspace, 'path')).toBe(false);
      const adapter = dshSource({ registry: ctx.workspaceRegistry, sessions: ctx.sessions, instance: 'real-host' });
      const imported = await library.refresh(workspace.id, workspace.id, adapter);
      expect(imported.workspace).toMatchObject({ id: workspace.id, path: workspace.path, title: workspace.title });
      expect(imported.workspace).not.toHaveProperty('host');
      expect(imported.workspace).not.toHaveProperty('record');
      const entry = imported.sessions.find(row => row.id === parent.session.id);
      expect(entry?.syncTurnCount).toBe(1);
      const document = await readFile(join(libraryRoot, entry.markdownFile), 'utf8');
      expect(document).toContain('ordinary parent response');
      expect(document).toContain('Explain stale REQHUB_SYNC_V2=');
      const snapshot = await library.snapshot(workspace.id, parent.session.id, adapter);
      expect(snapshot.version).toBe(entry.snapshotVersion);
      const targetRegistry = { list: () => [{ id: 'separate-knowledge-workspace', title: 'Knowledge target', path: libraryRoot }] };
      const knowledge = new KnowledgeService({ registry: targetRegistry, configLoader: async () => ({ docsDir: 'docs' }), databasePath: join(libraryRoot, 'knowledge/library.sqlite') });
      try {
        const operations = createOperations(createConversationKnowledgeRoutes(targetRegistry, library, [adapter], knowledge));
        const detail = await operations.execute({ action: 'conversations-knowledge-detail', query: { id: entry.conversationId, targetWorkspaceId: 'separate-knowledge-workspace' } }, {});
        expect(detail.status).toBe(200);
        const imported = await operations.execute({ action: 'conversations-knowledge-import', method: 'POST', body: { targetWorkspaceId: 'separate-knowledge-workspace', selections: [{ id: entry.conversationId, version: entry.snapshotVersion, turnKeys: [detail.value.turns[0].key] }] } }, {});
        expect(imported.status).toBe(200); expect(imported.value.added).toBe(1);
        const hit = (await knowledge.searchAll('ordinary parent response')).hits[0];
        expect(hit.type).toBe('conversation'); expect(hit.workspaceId).toBe('separate-knowledge-workspace');
        expect(hit.sources[0].conversation.sourceWorkspaceId).toBe(workspace.id);
      } finally { await knowledge.close(); }
    } finally { await library.close(); await store.close(); await rm(libraryRoot, { recursive: true, force: true }); }
  } finally { installation?.dispose(); await ctx.fiber.dispose(); if (outputRoot) await rm(outputRoot, { recursive: true, force: true }); }
}, 30000);

it.skipIf(!available)('runs enhancement evidence tools through a real isolated DSH spawn child', async () => {
  const requireHost = createRequire(join(dsh, 'packages/test-support/agent-loop-testkit/package.json'));
  const requireSpawn = createRequire(join(dsh, 'packages/subagent/subagent-spawn-in-process/package.json'));
  const { Context } = await load(requireHost.resolve('@deepseek-ai/cordis'));
  const { LlmAdapter } = await load(requireHost.resolve('@deepseek-ai/dsh-llm'));
  const { mountAgentLoopTestDependencies } = await load(join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'));
  const { default: AgentLoop } = await load(requireHost.resolve('@deepseek-ai/dsh-agent-loop'));
  const { default: Subagents } = await load(requireSpawn.resolve('@deepseek-ai/dsh-subagent'));
  const Spawn = await load(join(dsh, 'packages/subagent/subagent-spawn-in-process/lib/index.js'));
  let count = 0, installation;
  class Adapter extends LlmAdapter {
    async *stream() {
      count++;
      if (count <= 2) {
        const block = { type: 'tool-call', id: 'enhancement-' + count, name: count === 1 ? ENHANCEMENT_TOOLS[0] : ENHANCEMENT_TOOLS[1],
          arguments: JSON.stringify(count === 1 ? { documentId: 'd' } : { result: { findings: [], patterns: [] } }) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'complete' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } }; yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  const ctx = new Context();
  try {
    await mountAgentLoopTestDependencies(ctx); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' });
    ctx.llm.registerAdapter(['mock'], new Adapter());
    const parent = await ctx.agentLoop.create('enhancement-parent', { provider: 'mock', model: 'mock' }, { cwd: process.cwd() });
    const signal = new AbortController().signal;
    const runtime = new EnhancementRuntime([{ id: 'd', version: 1, body: '# Frozen\nSelected business evidence', sources: [] }], { limit: 150000 }, ENHANCEMENT_DEFAULTS, signal);
    installation = installEnhancementTools(ctx); installation.add(runtime);
    const denied = await ctx.tools.execute({ callId: 'outside-child', name: ENHANCEMENT_TOOLS[0], arguments: { documentId: 'd' }, agent: parent, signal });
    expect(denied.isError).toBe(true);
    const result = await executeTask(ctx, ctx.llm, {}, { parentAgent: parent, cwd: process.cwd(), promptKey: 'knowledge-enhancement', variables: { runtimeId: runtime.id, kind: 'consistency-check', documents: '[{"id":"d","version":1}]' }, runtime, signal, toolFilter: { allow: ENHANCEMENT_TOOLS } });
    expect(result.isError, result.diagnostic).toBe(false); expect(runtime.result.coverage.fullyReadDocuments).toBe(1); expect(count).toBe(3);
    installation.close(runtime);
  } finally { await installation?.dispose(); await ctx.fiber.dispose(); }
}, 30000);

it.skipIf(!available).each(['native', 'repair-text', 'never-submits'])('runs writing with real DSH output validation and bounded completion repair: %s', async mode => {
  const { WritingRuntime, installWritingTools, WRITING_TOOLS } = await import('../../src/server/writing-runtime.js');
  const requireHost = createRequire(join(dsh, 'packages/test-support/agent-loop-testkit/package.json'));
  const requireSpawn = createRequire(join(dsh, 'packages/subagent/subagent-spawn-in-process/package.json'));
  const { Context } = await load(requireHost.resolve('@deepseek-ai/cordis'));
  const { LlmAdapter } = await load(requireHost.resolve('@deepseek-ai/dsh-llm'));
  const { mountAgentLoopTestDependencies } = await load(join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'));
  const { default: AgentLoop } = await load(requireHost.resolve('@deepseek-ai/dsh-agent-loop'));
  const { default: Subagents } = await load(requireSpawn.resolve('@deepseek-ai/dsh-subagent'));
  const Spawn = await load(join(dsh, 'packages/subagent/subagent-spawn-in-process/lib/index.js'));
  let count = 0, installation, runtime;
  class Adapter extends LlmAdapter {
    async *stream(request) {
      count++;
      if (count > 1) expect(JSON.stringify(request.messages)).not.toContain('INVALID_TOOL_OUTPUT');
      if (mode === 'repair-text' && [3, 5].includes(count)) expect(JSON.stringify(request.messages)).toContain('does NOT execute tools');
      const phase = mode === 'native' ? count - 1 : mode === 'repair-text' ? ({ 1: 0, 3: 1, 5: 2 })[count] : undefined;
      if (phase !== undefined && phase <= 2) {
        const args = [{ scopeId: 'exact-scope', query: 'rule' }, { id: 'exact-doc' }, { content: '# Improved', evidenceIds: ['exact-doc'] }][phase];
        const block = { type: 'tool-call', id: 'writing-' + count, name: WRITING_TOOLS[phase], arguments: JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const fake = mode === 'never-submits' || mode === 'repair-text' && [2, 4].includes(count);
        const text = fake ? '<function=req_hub_writing_read><parameter=id>exact-doc</parameter></function> Claimed submitted.' : 'done';
        if (fake && count <= 2) expect(runtime.activity.read).toBe(0);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  const ctx = new Context();
  try {
    await mountAgentLoopTestDependencies(ctx); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(Subagents); await ctx.plugin(Spawn, { providerName: 'spawn' });
    ctx.llm.registerAdapter(['mock'], new Adapter());
    const parent = await ctx.agentLoop.create('writing-parent', { provider: 'mock', model: 'mock' }, { cwd: process.cwd() });
    ctx.tools.register({ name: 'writing_wrong_contract', description: 'Regression: previously declared object but returned array', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: () => [] });
    const wrong = await ctx.tools.execute({ callId: 'wrong-contract', name: 'writing_wrong_contract', arguments: {}, agent: parent, signal: new AbortController().signal });
    expect(wrong.error).toMatchObject({ info: { code: 'INVALID_TOOL_OUTPUT' } });
    installation = installWritingTools(ctx);
    runtime = new WritingRuntime([{ id: 'exact-scope', title: 'Selected' }], [{ id: 'exact-doc', scopeId: 'exact-scope', title: 'Rule', tags: [], version: 1, body: 'Complete business rule', sources: [{ relativePath: 'alice/2026-10-29-rule/requirement.md' }] }]);
    installation.add(runtime);
    const controller = new AbortController(); runtime.signal = controller.signal; runtime.onFatal = error => controller.abort(error);
    const result = await executeTask(ctx, ctx.llm, {}, { signal: controller.signal, parentAgent: parent, cwd: process.cwd(), promptKey: 'writing', variables: { runtimeId: runtime.id, docTypeName: 'Requirement', scopes: '[{"id":"exact-scope"}]', content: '# Original', instruction: 'Improve' }, runtime, toolFilter: { allow: WRITING_TOOLS }, liveness: { enabled: false } });
    if (mode === 'never-submits') {
      expect(result.isError).toBe(true); expect(count).toBe(4);
      expect(runtime.failure.message).toBe('WRITING_RESULT_INCOMPLETE'); expect(runtime.result).toBeUndefined(); expect(runtime.activity.read).toBe(0);
    } else {
      expect(result.isError, result.diagnostic).toBe(false); expect(count).toBe(mode === 'native' ? 4 : 6);
      expect(runtime.result.content).toBe('# Improved'); expect(runtime.result.evidence[0].id).toBe('exact-doc');
      expect(runtime.activity.toolErrors).toBe(0); expect(runtime.activity.read).toBe(1);
    }
    expect(runtime.completionReminders || 0).toBe(mode === 'native' ? 0 : mode === 'repair-text' ? 2 : 3);
    installation.close(runtime);
  } finally { await installation?.dispose(); await ctx.fiber.dispose(); }
}, 30000);
