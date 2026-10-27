import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createCodexTranscript } from '../../src/server/codex-sessions/transcript.js';
import { CodexSessionService } from '../../src/server/codex-sessions/service.js';
import { CodexSource } from '../../src/server/codex-sessions/source.js';
import { createCodexSessionRoutes } from '../../src/server/routes/codex-session-routes.js';
import { codexRecords, writeCodexRollout, codexState } from './codex-fixture.js';
import { matchesWorkspacePath } from '../../src/server/conversations/workspace-path.js';

let root, home, service, native;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqhub-codex-')); home = join(root, 'codex'); await mkdir(home);
  service = new CodexSessionService({ codexHome: home, databasePath: join(root, 'imported', 'codex.sqlite') });
});
afterEach(async () => { native?.close(); native = null; await service.close(); await rm(root, { recursive: true, force: true }); });
const parse = records => { const parser = createCodexTranscript('codex:cx-one'); records.forEach(record => parser.push(record)); return parser.finish(); };

it.each([
  ['D:\\project\\repo', 'd:/PROJECT/repo/', true],
  ['D:/project/other/../repo', 'd:/project/repo', true],
  ['\\\\server\\share\\repo', '//SERVER/share/repo/', true],
  ['/project/repo', '/project/repo/', true],
  ['/project/repo', '/project/Repo', false],
  ['D:/project/repo', 'D:/other/repo', false],
  ['D:/project/repo', 'D:/project/repository', false],
  ['', '', false],
])('matches exact workspace paths %s and %s', (path, current, expected) => {
  expect(matchesWorkspacePath({ paths: [path] }, current)).toBe(expected);
});

it('matches Codex by current path, ignores unrelated bindings and overrides client-supplied project IDs', async () => {
  const origin = { id: 'native-id', path: 'd:/PROJECT/repo/', title: 'Different title' };
  const refreshed = [];
  let origins = [origin], bound = { id: 'other', path: 'D:/elsewhere' };
  const routes = createCodexSessionRoutes({ list: () => [{ id: 'ws', path: 'D:\\project\\repo' }] }, {
    workspaces: async () => ({ workspaces: origins, warnings: [] }),
    list: async () => ({ workspace: bound, sessions: [{ id: 'current', cwd: 'D:/project/repo' }, { id: 'other', cwd: 'D:/project/elsewhere' }, { id: 'unknown' }] }),
    refresh: async (workspace, project) => { refreshed.push([workspace, project]); return { workspace: origin, sessions: [{ id: 'current', cwd: 'D:/project/repo' }, { id: 'other', cwd: 'D:/project/elsewhere' }] }; },
  });
  const invoke = async (action, body) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    req.method = body ? 'POST' : 'GET'; req.url = '/req-hub/codex/' + action + '?workspaceId=ws&matchWorkspace=true';
    const res = { writeHead(status) { this.status = status; }, end(raw) { this.value = JSON.parse(raw); } };
    await routes.find(route => route.path.endsWith('/' + action)).handler(req, res);
    return res;
  };
  expect((await invoke('sessions')).value).toMatchObject({ workspace: origin, sessions: [] });
  expect((await invoke('refresh', { workspaceId: 'ws', codexWorkspaceId: 'forged', matchWorkspace: true })).value.sessions.map(item => item.id)).toEqual(['current']);
  expect(refreshed).toEqual([['ws', 'native-id']]);
  bound = origin;
  expect((await invoke('sessions')).value.sessions).toHaveLength(1);
  origins = [{ ...origin, path: 'D:/project', sessionPaths: ['D:/project/repo'] }];
  expect((await invoke('sessions')).value.sessions.map(item => item.id)).toEqual(['current']);
  origins = [{ ...origin, id: 'wrong', path: 'D:/elsewhere', title: 'repo' }];
  expect((await invoke('sessions')).value).toMatchObject({ workspace: null, sessions: [] });
  await invoke('refresh', { workspaceId: 'ws', matchWorkspace: true });
  expect(refreshed).toHaveLength(1);
  origins = [origin, { ...origin, id: 'ambiguous' }];
  expect((await invoke('sessions')).status).toBe(409);
});

it('streams refresh progress before the result and reports errors inside an opened stream', async () => {
  const run = async fail => {
    const events = [];
    const routes = createCodexSessionRoutes({ list: () => [{ id: 'ws' }] }, {
      async refresh(workspaceId, projectId, onProgress) {
        expect(workspaceId).toBe('ws'); expect(projectId).toBe('project:p');
        onProgress({ phase: 'importing', completed: 1, total: 2 });
        expect(events).toHaveLength(1);
        if (fail) throw Error('读取失败');
        return { sessions: [] };
      },
    });
    const req = Readable.from([JSON.stringify({ workspaceId: 'ws', codexWorkspaceId: 'project:p', stream: true })]);
    req.method = 'POST';
    const res = { writeHead(status, headers) { expect(status).toBe(200); expect(headers['Content-Type']).toContain('application/x-ndjson'); },
      write(line) { events.push(JSON.parse(line)); }, end() { this.ended = true; } };
    await routes[2].handler(req, res);
    expect(res.ended).toBe(true);
    return events;
  };
  expect(await run(false)).toEqual([
    { type: 'progress', phase: 'importing', completed: 1, total: 2 }, { type: 'result', result: { sessions: [] } },
  ]);
  expect((await run(true)).at(-1)).toEqual({ type: 'error', error: '读取失败' });
});

it('keeps full ordered visible replies, human steering and completed turns without mirrored duplicates', () => {
  const final = '最终回复'.repeat(15000), intermediate = '中间回复'.repeat(15000);
  const snapshot = parse(codexRecords({ final, intermediate, incomplete: true }));
  expect(snapshot).toMatchObject({ turnCount: 2, syncTurnCount: 1 });
  expect(snapshot.turns[0].messages.map(message => [message.kind, message.text])).toEqual([
    ['input', '用户确认新规则'], ['intermediate', intermediate], ['followup', '保留旧接口。'], ['final', final],
  ]);
  expect(snapshot.turns[1].syncable).toBe(false);
  expect(snapshot.markdown).toContain(final); expect(snapshot.markdown).not.toContain('SECRET');
});

it('preserves repeated same-origin messages and refuses aborted, tool-only and unfinished commentary as final replies', () => {
  const records = codexRecords(); records.splice(14, 0, { type: 'event_msg', payload: { type: 'user_message', message: '保留旧接口。' } });
  expect(parse(records).turns[0].messages.filter(message => message.text === '保留旧接口。')).toHaveLength(2);
  const aborted = codexRecords(); aborted.at(-1).payload.type = 'turn_aborted';
  expect(parse(aborted).syncTurnCount).toBe(0);
  const tool = codexRecords().slice(0, 12);
  tool.push({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } });
  expect(parse(tool).syncTurnCount).toBe(0);
  expect(parse(codexRecords().slice(0, 10)).syncTurnCount).toBe(0);
});

it('uses Codex projects across worktree paths, excludes archived and subagent threads, and persists immutable Markdown', async () => {
  const file = await writeCodexRollout(home, codexRecords({ cwd: 'D:/worktree' }));
  const bytes = await readFile(file);
  native = codexState(home, [
    { id: 'cx-one', cwd: 'D:/worktree', file, projectId: 'p', title: '需求讨论' },
    { id: 'archived', cwd: 'D:/repo', file, archived: 1, projectId: 'p' },
    { id: 'child', cwd: 'D:/repo', file, source: '{"subagent":{}}', projectId: 'p' },
  ], [{ id: 'p', title: '订单项目', paths: ['D:/repo', 'D:/other-root'] }]);
  const { workspaces } = await service.workspaces(); expect(workspaces[0]).toMatchObject({ id: 'project:p', title: '订单项目', sessionCount: 1 });
  expect(workspaces[0].paths).toHaveLength(2);
  const progress = [];
  const result = await service.refresh('dsh-ws', 'project:p', event => progress.push(event));
  expect(progress).toEqual([
    { phase: 'queued', completed: 0, total: null },
    { phase: 'inventory', completed: 0, total: null },
    { phase: 'importing', completed: 0, total: 1 },
    { phase: 'importing', completed: 1, total: 1 },
    { phase: 'saving', completed: 1, total: 1 },
  ]);
  expect(result.sessions).toHaveLength(1); expect(result.importedCount).toBe(1);
  const imported = result.sessions[0]; expect(imported.id).toBe('codex:cx-one');
  expect(imported).toMatchObject({ turnCount: 1, syncTurnCount: 1 });
  const document = await readFile(join(root, 'imported', imported.markdownFile), 'utf8');
  expect(document).toContain('### 用户输入'); expect(document).toContain('### 助手中间回复 1'); expect(document).toContain('### 助手最终回复');
  expect(document).not.toContain('SECRET'); expect(await readFile(file)).toEqual(bytes);
  expect((await service.snapshot(imported.id)).version).toBe(imported.snapshotVersion);
  await service.refresh('dsh-ws', 'project:p');
  const db = await service.database(); expect(db.prepare('SELECT count(*) AS count FROM snapshots').get().count).toBe(1);
  await service.close(); service = new CodexSessionService({ codexHome: home, databasePath: join(root, 'imported', 'codex.sqlite') });
  expect((await service.list('dsh-ws')).sessions[0].snapshotVersion).toBe(imported.snapshotVersion);
});

it('rejects changed or archived evidence until refresh and removes archived sessions from subsequent lists', async () => {
  const file = await writeCodexRollout(home, codexRecords());
  native = codexState(home, [{ id: 'cx-one', cwd: 'D:/repo', file, projectId: 'p' }], [{ id: 'p', title: '项目', paths: ['D:/repo'] }]);
  const initial = await service.refresh('ws', 'project:p');
  await writeCodexRollout(home, codexRecords({ final: '已经改变的最终回复' }));
  await expect(service.snapshot('codex:cx-one')).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('SESSION_CHANGED') });
  const updated = await service.refresh('ws', 'project:p'); expect(updated.sessions[0].snapshotVersion).not.toBe(initial.sessions[0].snapshotVersion);
  expect((await service.snapshot('codex:cx-one')).turns[0].messages.at(-1).text).toBe('已经改变的最终回复');
  native.prepare('UPDATE threads SET archived=1 WHERE id=?').run('cx-one');
  await expect(service.snapshot('codex:cx-one')).rejects.toThrow('CODEX_SESSION_ARCHIVED');
  expect((await service.refresh('ws', 'project:p')).sessions).toEqual([]);
});

it('prefers desktop names over prompt titles and persists renamed titles on refresh without changing snapshots', async () => {
  const file = await writeCodexRollout(home, codexRecords());
  native = codexState(home, [{ id: 'cx-one', cwd: 'D:/repo', file, title: '首条用户输入\n这是一段正文，不是会话名称。' }]);
  native.exec('ALTER TABLE threads ADD COLUMN name TEXT');
  native.prepare('UPDATE threads SET name=?').run('订单接口设计');
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: 'cx-one', thread_name: '旧索引名称' }) + '\n');
  const workspaceId = (await service.workspaces()).workspaces[0].id;
  const first = (await service.refresh('ws', workspaceId)).sessions[0];
  expect(first.title).toBe('订单接口设计');
  native.prepare('UPDATE threads SET name=?').run('订单接口设计评审');
  const renamed = (await service.refresh('ws', workspaceId)).sessions[0];
  expect(renamed.title).toBe('订单接口设计评审');
  expect(renamed.snapshotVersion).toBe(first.snapshotVersion);
  expect(renamed.markdownFile).toBe(first.markdownFile);
  expect((await service.list('ws')).sessions[0].title).toBe('订单接口设计评审');
  native.prepare('UPDATE threads SET name=?').run('   ');
  expect((await service.refresh('ws', workspaceId)).sessions[0].title).toBe('旧索引名称');
});

it('uses the title index with older SQLite schemas before falling back to legacy titles', async () => {
  const file = await writeCodexRollout(home, codexRecords());
  native = codexState(home, [{ id: 'cx-one', cwd: 'D:/repo', file, title: '旧版本标题' }]);
  const source = new CodexSource(home);
  expect((await source.inventory()).sessions[0].title).toBe('旧版本标题');
  await writeFile(join(home, 'session_index.jsonl'), [
    { id: 'cx-one', thread_name: '索引旧名称' }, { id: 'cx-one', thread_name: '索引新名称' },
  ].map(item => JSON.stringify(item)).join('\n') + '\n{"id":');
  expect((await source.inventory()).sessions[0].title).toBe('索引新名称');
});

it('falls back to active JSONL and session index titles without importing archived directories', async () => {
  const file = await writeCodexRollout(home, codexRecords());
  await writeFile(join(home, 'session_index.jsonl'), JSON.stringify({ id: 'cx-one', thread_name: '来自标题索引' }) + '\n');
  await mkdir(join(home, 'archived_sessions')); await writeFile(join(home, 'archived_sessions', 'archived.jsonl'), await readFile(file));
  const { workspaces } = await service.workspaces(); expect(workspaces).toHaveLength(1); expect(workspaces[0].sessionCount).toBe(1);
  const result = await service.refresh('ws', workspaces[0].id); expect(result.sessions[0].title).toBe('来自标题索引');
});

it('surfaces partial/corrupt rollouts and does not mark stale snapshots as selectable', async () => {
  const file = await writeCodexRollout(home, codexRecords());
  native = codexState(home, [{ id: 'cx-one', cwd: 'D:/repo', file }]);
  const id = (await service.workspaces()).workspaces[0].id;
  await service.refresh('ws', id);
  await writeFile(file, (await readFile(file, 'utf8')) + '{"type":');
  const result = await service.refresh('ws', id);
  expect(result.warnings).toHaveLength(1); expect(result.sessions[0].syncTurnCount).toBe(0); expect(result.sessions[0].snapshotVersion).toBeUndefined();
  await expect(service.snapshot('codex:cx-one')).rejects.toThrow('CODEX_SESSION_MISSING');
});

it('rejects files outside the active Codex directory and binds import routes to real DSH workspaces', async () => {
  await mkdir(join(home, 'sessions'));
  const source = new CodexSource(home), outside = join(root, 'outside.jsonl'); await writeFile(outside, codexRecords().map(row => JSON.stringify(row)).join('\n'));
  await expect(source.snapshot({ sourcePath: outside, nativeId: 'cx-one', id: 'codex:cx-one' })).rejects.toThrow('CODEX_SOURCE_INVALID');
  const routes = createCodexSessionRoutes({ list: () => [{ id: 'ws' }] }, service), res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
  await routes[0].handler({ method: 'GET', url: '/req-hub/codex/workspaces?workspaceId=missing' }, res);
  expect(res.status).toBe(404);
});
