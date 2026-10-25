import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore, hash } from '../../src/server/conversations/store.js';
import { ConversationService } from '../../src/server/conversations/service.js';
import { KnowledgeService } from '../../src/server/knowledge/build-service.js';
import { createConversationKnowledgeRoutes } from '../../src/server/routes/conversation-knowledge-routes.js';
import { createOperations } from '../../src/server/operations.js';
import { WritingRuntime } from '../../src/server/writing-runtime.js';

let root, library, store, knowledge, operations, adapter, turns, entry, registry;
const turn = (number, text, id = 'native-' + number) => ({ sessionId: 'codex:one', turnNumber: number, ...(id ? { sourceTurnId: id } : {}), status: 'completed', syncable: true,
  messages: [{ role: 'user', kind: 'input', label: '用户输入', text: 'Question ' + number }, { role: 'assistant', kind: 'intermediate', label: '助手中间回复', text: 'Discuss ' + number }, { role: 'assistant', kind: 'final', label: '助手最终回复', text }] });
const snapshot = () => ({ sessionId: 'codex:one', version: hash(JSON.stringify(turns)), turns, turnCount: turns.length, syncTurnCount: turns.filter(turn => turn.syncable).length, totalTokens: 10 });
const action = (name, body, query) => operations.execute({ action: 'conversations-knowledge-' + name, method: body ? 'POST' : 'GET', body, query }, {});
const select = (keys, version = entry.snapshotVersion, id = entry.conversationId) => ({ id, version, turnKeys: keys });
const run = (keys, targetWorkspaceId = 'kb-target', version) => action('import', { targetWorkspaceId, selections: [select(keys, version)] });
async function refresh() { entry = (await library.refresh('app-source', 'codex-native-project', adapter)).sessions[0]; }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rh-conversation-knowledge-'));
  await mkdir(join(root, 'source')); await mkdir(join(root, 'target'));
  registry = { list: () => [{ id: 'app-source', title: 'Same title', path: join(root, 'source') }, { id: 'kb-target', title: 'Same title', path: join(root, 'target') }] };
  store = new ConversationStore(join(root, 'conversations/library.sqlite'));
  library = new ConversationService({ store, owner: 'dsh-profile' });
  knowledge = new KnowledgeService({ registry, configLoader: async () => ({ docsDir: 'docs' }), databasePath: join(root, 'knowledge/library.sqlite') });
  turns = [turn(1, 'Shipping requires approval'), turn(2, 'Refund original payment method'), turn(3, 'Not selected secret decision')];
  adapter = { source: 'codex', instance: '/separate/codex-home', inventory: async () => ({ workspaces: [{ id: 'codex-native-project', title: 'Same title', paths: ['/unrelated/codex-root'] }], sessions: [{ id: 'codex:one', workspaceId: 'codex-native-project', title: 'Order discussion' }], warnings: [] }), snapshot: async () => snapshot() };
  await refresh();
  operations = createOperations(createConversationKnowledgeRoutes(registry, library, [adapter], knowledge));
});
afterEach(async () => { await library.close(); await store.close(); await knowledge.close(); await rm(root, { recursive: true, force: true }); });

it('explicitly selects a destination without mapping same-name DSH and Codex workspaces', async () => {
  const options = await action('options');
  expect(options.value.targets).toHaveLength(2);
  expect(options.value.sessions[0]).toMatchObject({ sourceWorkspaceId: 'codex-native-project', sourceWorkspaceTitle: 'Same title' });
  expect((await action('import', { selections: [select(['id:native-1'])] })).status).toBe(400);
  const result = await run(['id:native-1']); expect(result.status).toBe(200);
  expect(result.value).toMatchObject({ targetWorkspaceId: 'kb-target', added: 1, updated: 0, skipped: 0 });
  const target = await knowledge.scope('kb-target'), source = await knowledge.scope('app-source');
  expect(source.store.list()).toHaveLength(0);
  const document = target.store.list()[0];
  expect(document).toMatchObject({ workspaceId: 'kb-target', type: 'conversation', conversation: { source: 'codex', sourceWorkspaceId: 'codex-native-project', nativeSessionId: 'codex:one' } });
  expect(document.body).toContain('Shipping requires approval'); expect(document.body).not.toContain('Not selected secret');
  expect(document.sources[0].workspaceId).toBe('kb-target');
  expect(document.sources[0].conversation.sourceWorkspacePaths).toEqual(['/unrelated/codex-root']);
});

it('unions overlapping round selections, skips duplicates and retains one stable knowledge entry', async () => {
  await run(['id:native-1', 'id:native-2']);
  const scope = await knowledge.scope('kb-target'), first = scope.store.list()[0];
  const duplicate = await run(['id:native-2', 'id:native-1']); expect(duplicate.value).toMatchObject({ added: 0, updated: 0, skipped: 2 });
  expect(scope.store.entry(first.id).version).toBe(1);
  const extended = await run(['id:native-2', 'id:native-3']); expect(extended.value).toMatchObject({ added: 1, updated: 0, skipped: 1 });
  const document = scope.store.entry(first.id); expect(document.version).toBe(2); expect(scope.store.list()).toHaveLength(1);
  expect(document.conversation.turns.map(turn => turn.number)).toEqual([1, 2, 3]);
  expect(document.body.split('Refund original payment method')).toHaveLength(2);
  expect(document.versions).toHaveLength(2);
});

it('updates only reselected changed rounds and keeps every imported round snapshot citation', async () => {
  const old = entry.snapshotVersion; await run(['id:native-1', 'id:native-2']);
  turns = [turn(1, 'NEW shipping policy'), turn(2, 'NEW refund policy'), turn(3, 'Appended policy')]; await refresh();
  const detail = await action('detail', null, { targetWorkspaceId: 'kb-target', id: entry.conversationId, version: entry.snapshotVersion });
  expect(detail.value.turns.map(turn => turn.knowledgeState)).toEqual(['changed', 'changed', 'new']);
  const result = await run(['id:native-2', 'id:native-3']); expect(result.value).toMatchObject({ added: 1, updated: 1 });
  const document = (await knowledge.scope('kb-target')).store.list()[0];
  expect(document.body).toContain('Shipping requires approval'); expect(document.body).not.toContain('NEW shipping policy');
  expect(document.body).toContain('NEW refund policy');
  expect(document.conversation.turns.map(turn => turn.snapshotVersion)).toEqual([old, entry.snapshotVersion, entry.snapshotVersion]);
});

it('keeps destinations independent and does not deduplicate different source instances by title', async () => {
  await run(['id:native-1']); await run(['id:native-1'], 'app-source');
  const other = { ...adapter, instance: '/different/codex-home' };
  await library.refresh('app-source', 'codex-native-project', other);
  operations = createOperations(createConversationKnowledgeRoutes(registry, library, [adapter, other], knowledge));
  const sources = (await action('options')).value.sessions;
  expect(sources).toHaveLength(2);
  const second = sources.find(row => row.conversationId !== entry.conversationId);
  expect((await action('import', { targetWorkspaceId: 'kb-target', selections: [select(['id:native-1'], second.snapshotVersion, second.conversationId)] })).value.added).toBe(1);
  expect((await knowledge.scope('kb-target')).store.list()).toHaveLength(2);
  expect((await knowledge.scope('app-source')).store.list()).toHaveLength(1);
});

it('indexes imported records globally, preserves them after cache deletion, and freezes them for writing', async () => {
  await run(['id:native-1']); const scope = await knowledge.scope('kb-target');
  await store.remove(entry.conversationId);
  const results = await knowledge.searchAll('Shipping'); expect(results.hits).toHaveLength(1);
  const document = scope.store.list()[0]; expect(document.sources[0].status).toBe('active');
  const runtime = new WritingRuntime([{ id: scope.identity }], [{ ...document, scopeId: scope.identity }]);
  expect(runtime.search({ scopeId: scope.identity, query: 'Shipping' })[0].conversation.turns[0].number).toBe(1);
  const read = runtime.read({ id: document.id }); expect(read.sources[0].conversation.turns[0].snapshotVersion).toBe(entry.snapshotVersion);
  runtime.submit({ content: 'Updated requirement', evidenceIds: [document.id] });
  expect(runtime.result.evidence[0].type).toBe('conversation');
  const files = await readdir(join(root, 'knowledge/documents'));
  expect(await readFile(join(root, 'knowledge/documents', files[0]), 'utf8')).toContain('"sourceWorkspaceId":"codex-native-project"');
});

it('imports explicitly selected unfinished rounds as records and never invents a final reply', async () => {
  turns[1] = { ...turns[1], status: 'running', syncable: false, messages: [{ role: 'user', kind: 'input', label: '用户输入', text: 'Unfinished question' }, { role: 'assistant', kind: 'intermediate', label: '助手中间回复', text: 'Work in progress' }] }; await refresh();
  expect((await run(['id:native-2'])).value.added).toBe(1);
  const document = (await knowledge.scope('kb-target')).store.list()[0];
  expect(document.conversation.turns[0]).toMatchObject({ status: 'running', syncable: false });
  expect(document.body).not.toContain('助手最终回复');
});

it('rejects forged rounds, missing snapshots and inaccessible source instances before writing any entry', async () => {
  expect((await run(['id:forged'])).status).toBe(400);
  expect((await run(['id:native-1'], 'kb-target', 'not-a-version')).status).toBe(409);
  const alien = new ConversationService({ store, owner: 'other-profile' });
  try {
    const foreignOperations = createOperations(createConversationKnowledgeRoutes(registry, alien, [adapter], knowledge));
    expect((await foreignOperations.execute({ action: 'conversations-knowledge-options' }, {})).value.sessions).toEqual([]);
    expect((await foreignOperations.execute({ action: 'conversations-knowledge-import', method: 'POST', body: { targetWorkspaceId: 'kb-target', selections: [select(['id:native-1'])] } }, {})).status).toBe(400);
  } finally { await alien.close(); }
  expect((await knowledge.scope('kb-target')).store.list()).toEqual([]);
});

it('rolls back an entire selection when an ordinal-only source changes round identity', async () => {
  turns = [turn(1, 'Old', null)]; await refresh(); await run(['number:1']);
  turns = [turn(1, 'Different', null)]; turns[0].messages[0].text = 'Reordered source'; await refresh();
  const result = await run(['number:1']); expect(result.status).toBe(409); expect(result.value.error).toBe('KNOWLEDGE_TURN_IDENTITY_CONFLICT');
  const document = (await knowledge.scope('kb-target')).store.list()[0]; expect(document.version).toBe(1); expect(document.body).not.toContain('Different');
});

it('serializes concurrent overlapping imports without losing rounds or adding duplicate entries', async () => {
  const results = await Promise.all([run(['id:native-1', 'id:native-2']), run(['id:native-2', 'id:native-3'])]);
  expect(results.every(result => result.status === 200)).toBe(true);
  const entries = (await knowledge.scope('kb-target')).store.list(); expect(entries).toHaveLength(1); expect(entries[0].conversation.turns).toHaveLength(3);
  expect(results.reduce((sum, result) => sum + result.value.added, 0)).toBe(3);
});

it('rejects a mixed invalid batch atomically and enforces the complete selected-turn limit', async () => {
  const invalid = await action('import', { targetWorkspaceId: 'kb-target', selections: [select(['id:native-1']), select(['forged'], entry.snapshotVersion, 'unknown-conversation')] });
  expect(invalid.status).toBe(400); expect((await knowledge.scope('kb-target')).store.list()).toHaveLength(0);
  turns = Array.from({ length: 1001 }, (_, index) => turn(index + 1, 'Content')); await refresh();
  const oversized = await run(turns.map(turn => 'id:' + turn.sourceTurnId));
  expect(oversized.status).toBe(413); expect((await knowledge.scope('kb-target')).store.list()).toHaveLength(0);
});

it('makes DSH native turn numbers updatable and keeps repeated equal text in distinct rounds', async () => {
  adapter.source = 'dsh'; adapter.instance = 'dsh-profile';
  operations = createOperations(createConversationKnowledgeRoutes(registry, library, [adapter], knowledge));
  turns = [turn(1, 'Repeated', null), turn(2, 'Repeated', null)]; await refresh();
  expect((await run(['number:1', 'number:2'])).value.added).toBe(2);
  turns[0].messages[0].text = 'Corrected DSH input'; await refresh();
  expect((await run(['number:1'])).value.updated).toBe(1);
  const document = (await knowledge.scope('kb-target')).store.list()[0];
  expect(document.body.split('Repeated')).toHaveLength(3); expect(document.conversation.source).toBe('dsh');
});
