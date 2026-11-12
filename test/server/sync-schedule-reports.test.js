import { installWorkspaceTaskAgents } from '../helpers/workspace-task-agent.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, access, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TaskReports } from '../../src/server/task-reports.js';
import {
  SyncDailyScheduler,
  matchesScheduledBranch,
} from '../../src/server/sync-daily-scheduler.js';
import { findRequirementDir } from '../../src/server/doc-reader.js';
import { parseBranchName } from '../../src/server/utils.js';
import { listSyncBranches } from '../../src/server/sync-branches.js';
import { SyncSupervisor } from '../../src/server/sync-supervisor.js';
let root, knowledge, registry, reports, scheduler, config, now, runQuick, workspaces;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reqhub-sync-schedule-'));
  workspaces = ['a', 'b'].map((id) => ({ id, title: id.toUpperCase(), path: join(root, id) }));
  for (const workspace of workspaces) await mkdir(workspace.path);
  registry = { list: () => workspaces };
  config = {
    docsDir: 'docs',
    defaultUsername: 'alice',
    sync: {
      dailyUpdateEnabled: true,
      dailyUpdateTime: '03:00',
      dailyUpdateTimeZone: 'Asia/Shanghai',
      dailyOffsetDays: 1,
    },
  };
  now = new Date('2026-11-03T18:59:00Z');
  knowledge = {
    ctx: installWorkspaceTaskAgents({ agents: {} }),
    scope: async (workspaceId) => {
      const workspace = workspaces.find((item) => item.id === workspaceId);
      if (!workspace) {
        throw new Error('WORKSPACE_NOT_FOUND');
      }
      return { scope: { workspace } };
    },
    close: async () => {},
  };
  reports = new TaskReports(registry, { directory: join(root, 'reports') });
  runQuick = vi.fn(async (_routes, input, _parent, signal, event) => {
    signal.throwIfAborted();
    const task = {
      id: input.workspaceId + input.targetBranch,
      docType: 'requirement',
      status: 'completed',
      requirementId: input.requirementId,
    };
    event({ type: 'done', sync: task });
    return { status: 200, value: { type: 'done' }, tasks: [task] };
  });
  scheduler = new SyncDailyScheduler({
    registry,
    reports,
    routes: [],
    knowledge,
    configLoader: async () => config,
    clock: () => now,
    runQuick,
    listBranches: async () => [
      'feature/alice/2026-11-03-b',
      'feature/alice/2026-11-03-a',
      'feature/alice/2026-11-02-old',
      'feature/bob/2026-11-03-other',
      'feature/2026-11-03-no-user',
    ],
  });
});
afterEach(async () => {
  await scheduler.close();
  await knowledge.close();
  // TaskReports owns its SQLite connection, so the file must be released
  // before the temporary directory is removed on Windows.
  reports.close();
  const child = relative(tmpdir(), root);
  if (isAbsolute(child) || child.startsWith('..') || !child.startsWith('reqhub-sync-schedule-')) {
    throw new Error('Unsafe test cleanup');
  }
  await rm(root, { recursive: true, force: true });
});
async function due() {
  await scheduler.check(new AbortController().signal);
  now = new Date('2026-11-03T19:00:00Z');
  await scheduler.check(new AbortController().signal);
}
it('matches T-1 on the prior calendar day, processes all workspaces in order and claims once', async () => {
  await due();
  expect(runQuick.mock.calls.map((call) => [call[1].workspaceId, call[1].targetBranch])).toEqual([
    ['a', 'feature/alice/2026-11-03-a'],
    ['a', 'feature/alice/2026-11-03-b'],
    ['b', 'feature/alice/2026-11-03-a'],
    ['b', 'feature/alice/2026-11-03-b'],
  ]);
  await scheduler.check(new AbortController().signal);
  expect(runQuick).toHaveBeenCalledTimes(4);
  const result = reports.detail(reports.begin('sync', '2026-11-04').report.id);
  expect(result).toMatchObject({
    targetDay: '2026-11-03',
    status: 'completed',
    stats: { workspaces: 2, branches: 4, succeeded: 4 },
  });
  expect(result.workspaces[0].items[0].tasks[0].status).toBe('completed');
  await access(join(workspaces[0].path, 'docs/alice/2026-11-03-a'));
});
it('supports the no-username layout and literal usernames containing hyphens', async () => {
  config.defaultUsername = '';
  await due();
  expect(runQuick.mock.calls.map((call) => call[1].targetBranch)).toEqual([
    'feature/2026-11-03-no-user',
    'feature/2026-11-03-no-user',
  ]);
  const path = await findRequirementDir(join(workspaces[0].path, 'docs'), '2026-11-03-no-user');
  expect(path).toBe(join(workspaces[0].path, 'docs/2026-11-03-no-user'));
  expect(parseBranchName('feature/alice-smith/2026-11-03-topic')).toMatchObject({
    developer: 'alice-smith',
    requirementId: '2026-11-03-topic',
  });
  expect(
    matchesScheduledBranch('feature/alice-smith/2026-11-03-topic', '2026-11-03', 'alice-smith'),
  ).toBe(true);
  expect(
    matchesScheduledBranch('feature/alice/2026-11-03-topic/extra', '2026-11-03', 'alice'),
  ).toBe(false);
});

it('uses the general clock for the execution minute and target calendar day', async () => {
  config.general = { timeZone: 'UTC' };
  config.sync.dailyUpdateTimeZone = 'Asia/Tokyo';
  now = new Date('2026-11-04T02:59:00Z');
  await scheduler.check(new AbortController().signal);
  expect(runQuick).not.toHaveBeenCalled();
  now = new Date('2026-11-04T03:00:00Z');
  await scheduler.check(new AbortController().signal);
  expect(runQuick).toHaveBeenCalledTimes(4);
  expect(runQuick.mock.calls.every((call) => call[1].targetBranch.includes('2026-11-03'))).toBe(
    true,
  );
});
it('does not catch up when activated after the daily minute, and crosses year boundaries', async () => {
  now = new Date('2027-01-01T19:01:00Z');
  await scheduler.check(new AbortController().signal);
  expect(runQuick).not.toHaveBeenCalled();
  now = new Date('2027-01-02T19:00:00Z');
  config.sync.dailyOffsetDays = 3;
  // A configuration change establishes a fresh activation boundary.
  await scheduler.check(new AbortController().signal);
  now = new Date('2027-01-03T19:00:00Z');
  scheduler.listBranches = async () => ['feature/alice/2027-01-01-topic'];
  await scheduler.check(new AbortController().signal);
  expect(runQuick.mock.calls[0][1].targetBranch).toBe('feature/alice/2027-01-01-topic');
});
it('retains failures and continues with later branches and workspaces', async () => {
  runQuick.mockImplementationOnce(async () => {
    throw new Error('TEMPORARY_FAILURE');
  });
  await due();
  expect(runQuick).toHaveBeenCalledTimes(4);
  expect(reports.detail(reports.begin('sync', '2026-11-04').report.id)).toMatchObject({
    status: 'partial',
    stats: { failed: 1, succeeded: 3 },
  });
});
it('never reports an incomplete quick response as success', async () => {
  runQuick.mockResolvedValue({ status: 200, value: {} });
  await due();
  expect(reports.detail(reports.begin('sync', '2026-11-04').report.id).stats.failed).toBe(4);
});
it('cancels and awaits in-flight work before closing, and fences late report writes', async () => {
  await scheduler.refresh();
  now = new Date('2026-11-03T19:00:00Z');
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  runQuick.mockImplementation(async (_routes, _input, _parent, signal) => {
    entered();
    await new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const running = scheduler.refresh();
  await ready;
  await scheduler.close();
  await running;
  const report = reports.begin('sync', '2026-11-04').report;
  expect(report.status).toBe('cancelled');
  reports.item(report.id, workspaces[0], 'feature/alice/2026-11-03-a', { status: 'completed' });
  expect(reports.detail(report.id).workspaces[0].items[0].status).toBe('cancelled');
  expect(runQuick).toHaveBeenCalledOnce();
});
it('groups knowledge sources and imported sessions without duplicate rows, and hides removed workspaces', () => {
  const report = reports.begin('knowledge', '2026-11-04').report;
  const storeA = { scope: { scopeId: 'scope', workspaceId: 'a', workspace: workspaces[0] } };
  reports.item(report.id, workspaces[0], 'session:codex:one', {
    kind: 'session',
    source: 'codex',
    sessionId: 'one',
    status: 'completed',
    documentIds: ['doc'],
  });
  reports.knowledgeSource(report.id, storeA, {
    id: 'doc',
    revision: 'rev-1',
    kind: 'session',
    title: 'Conversation',
    origin: { provider: 'codex', sessionId: 'one' },
  });
  reports.item(report.id, workspaces[1], 'source:two', {
    kind: 'document',
    status: 'queued',
    documentId: 'two',
  });
  reports.finish(report.id);
  expect(reports.detail(report.id).stats).toMatchObject({ total: 2, sessions: 1, documents: 1 });
  reports.knowledgeJob({
    id: 'job',
    kind: 'ingest',
    scopeId: 'scope',
    status: 'completed',
    sourceIds: ['doc'],
    sourceRevisions: { doc: 'rev-1' },
  });
  expect(reports.detail(report.id).workspaces[0].items[0]).toMatchObject({
    status: 'completed',
    source: 'codex',
  });
  workspaces = workspaces.slice(0, 1);
  expect(reports.detail(report.id).stats).toMatchObject({ total: 1, workspaces: 1 });
  expect(() => reports.detail('unknown')).toThrow('REPORT_NOT_FOUND');
});
it('marks running persisted batches interrupted on restart and denies late completion', () => {
  const report = reports.begin('sync', '2026-11-04').report;
  reports.item(report.id, workspaces[0], 'branch', { kind: 'branch', status: 'running' });
  const restored = new TaskReports(registry, { directory: join(root, 'reports') });
  restored.item(report.id, workspaces[0], 'branch', { status: 'completed' });
  expect(restored.detail(report.id)).toMatchObject({ status: 'interrupted', stats: { failed: 1 } });
  restored.close();
});
it('validates actual Git repository ownership and refuses a docs junction outside the workspace', async () => {
  const repo = workspaces[0].path;
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  await writeFile(join(repo, 'source.js'), 'base');
  git('add', '.');
  git('commit', '-m', 'base');
  git('branch', 'feature/alice/2026-11-03-a');
  expect(await listSyncBranches(repo)).toContain('feature/alice/2026-11-03-a');
  await mkdir(join(repo, 'nested'));
  await expect(listSyncBranches(join(repo, 'nested'))).rejects.toThrow(
    'SYNC_WORKSPACE_REPOSITORY_MISMATCH',
  );
  await symlink(
    workspaces[1].path,
    join(repo, 'docs'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await due();
  expect(runQuick.mock.calls.every((call) => call[1].workspaceId === 'b')).toBe(true);
  expect(reports.detail(reports.begin('sync', '2026-11-04').report.id).stats.failed).toBe(2);
});
it('waits for the shared sync owner without polling and removes aborted waiters', async () => {
  const supervisor = new SyncSupervisor();
  const owner = supervisor.acquire({ workspaceId: 'a' });
  const controller = new AbortController();
  const waiting = supervisor.waitAvailable(controller.signal);
  controller.abort(new Error('CANCELLED'));
  await expect(waiting).rejects.toThrow('CANCELLED');
  expect(supervisor.waiters.size).toBe(0);
  const next = supervisor.waitAvailable(new AbortController().signal);
  supervisor.release(owner);
  await next;
  expect(supervisor.waiters.size).toBe(0);
});

it('serves newest reports first and rejects report mutation or invalid pagination', () => {
  const old = reports.begin('sync', '2026-11-03').report;
  const latest = reports.begin('sync', '2026-11-04').report;
  const handler = reports.routes()[0].handler;
  const request = (url, method = 'GET') => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        this.body = JSON.parse(text);
      },
    };
    handler({ url, method }, res);
    return res;
  };
  expect(request('/req-hub/task-reports?kind=sync').body.items.map((item) => item.id)).toEqual([
    latest.id,
    old.id,
  ]);
  expect(request('/req-hub/task-reports?kind=sync&cursor=-1').status).toBe(400);
  expect(request('/req-hub/task-reports', 'POST').status).toBe(405);
  expect(request('/req-hub/task-reports?id=other-profile').status).toBe(404);
});

it('does not update reports belonging to a different configuration owner', () => {
  const report = reports.begin('knowledge', '2026-11-04').report;
  const store = { scope: { scopeId: 'scope', workspaceId: 'a', workspace: workspaces[0] } };
  reports.knowledgeSource(report.id, store, {
    id: 'doc',
    revision: 'rev-1',
    kind: 'document',
    title: 'Source',
    origin: { relativePath: 'doc.md' },
  });
  reports.db
    .prepare('UPDATE reqhub_reports SET owner=? WHERE id=?')
    .run('another-profile', report.id);
  expect(() =>
    reports.knowledgeJob({
      id: 'job',
      kind: 'ingest',
      scopeId: 'scope',
      status: 'failed',
      sourceIds: ['doc'],
      sourceRevisions: { doc: 'rev-1' },
    }),
  ).not.toThrow();
  const saved = reports.db
    .prepare('SELECT payload FROM reqhub_report_items WHERE report_id=?')
    .get(report.id);
  expect(JSON.parse(saved.payload).status).toBe('queued');
  expect(() => reports.detail(report.id)).toThrow('REPORT_NOT_FOUND');
});
