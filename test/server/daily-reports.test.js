import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  readFile,
  utimes,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DailyReports, previousDay, requirementGroup } from '../../src/server/daily-reports.js';
import { briefBatches } from '../../src/server/daily-brief.js';
import { createDailyReportRoutes } from '../../src/server/routes/daily-report-routes.js';
import { notifyDocumentCommit } from '../../src/server/document-commits.js';
import { DocumentReplicas } from '../../src/server/document-replicas.js';

let root, workspace, service, config, now, generator, registry;
const collect = async (values) => {
  const items = [];
  for await (const item of values) {
    items.push(item);
  }
  return items;
};
const consume = async (input, summary = 'Summary of confirmed files.') => {
  input.observedEvidence = await collect(input.readEvidence());
  return summary;
};
const read = (group) => collect(service.evidence(group));
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'reqhub-daily-')));
  workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'docs/author/2026-11-17-change'), { recursive: true });
  registry = { list: () => [{ id: 'ws', title: 'Workspace', path: workspace }] };
  config = { docsDir: 'docs', general: { timeZone: 'Asia/Shanghai' } };
  await mkdir(join(root, 'wiki/topics'), { recursive: true });
  await writeFile(join(root, 'wiki/topics/page.md'), 'published');
  now = new Date('2026-11-17T04:00:00Z');
  generator = vi.fn(consume);
  service = new DailyReports({
    registry,
    directory: root,
    configLoader: async () => config,
    now: () => now,
    generateBrief: generator,
    knowledgeFile: async (file) => ({ root: join(root, 'wiki'), path: file.pageId + '.md' }),
  });
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});
const save = async (path, body, source = 'sync') => {
  await writeFile(join(workspace, 'docs', path), body);
  await service.committed('ws', path, source);
};
const previous = () => service.view('2026-11-17');
const finish = async () => {
  await service.refresh();
  await service.execution;
};

it('groups all producers, deduplicates versions and reads current original files and identifies later overwrites', async () => {
  const path = 'author/2026-11-17-change/requirement.md';
  await save(path, 'one', 'writing');
  await save(path, 'two', 'sync');
  await service.committed('ws', path, 'writing');
  await save('session.md', 'conversation', 'conversation');
  now = new Date('2026-11-18T01:00:00Z');
  await save(path, 'today', 'writing');
  const report = await previous();
  expect(report.groups).toHaveLength(2);
  const group = report.groups.find((item) => item.group);
  expect(group.files).toHaveLength(1);
  expect(group.files[0].sources).toEqual(['sync', 'writing']);
  expect((await read(group))[0]).toMatchObject({
    body: 'today',
    fileState: 'updated_since_collection',
  });
  await finish();
  expect(generator).toHaveBeenCalledTimes(1);
  expect(
    generator.mock.calls.flatMap(([input]) => input.observedEvidence).map((file) => file.body),
  ).toEqual(expect.arrayContaining(['today', 'conversation']));
  expect((await service.view('2026-11-18')).groups.flatMap((item) => item.files)).toHaveLength(1);
});

it('groups dated filenames as shared files and repairs recorded file-as-directory groups', async () => {
  const files = ['author/2026-11-17-api-test.log', 'author/2026-11-17-excel-test.log'];
  for (const path of files) {
    await save(path, 'Confirmed test output');
  }
  // Reproduce rows written by the faulty grouping logic before this release.
  for (const row of service.db.prepare('SELECT id,payload FROM daily_files').all()) {
    const item = JSON.parse(row.payload);
    item.group = item.path;
    service.db
      .prepare('UPDATE daily_files SET payload=? WHERE id=?')
      .run(JSON.stringify(item), row.id);
  }
  const before = await previous();
  expect(before.groups).toHaveLength(1);
  expect(before.groups[0].group).toBe('');
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  const group = (await previous()).groups[0];
  expect((await previous()).brief).toMatchObject({
    status: 'completed',
    path: 'daily-reports/2026-11-17-summary.md',
  });
  expect(group.files.map((file) => file.path)).toEqual(files);
  expect(generator).toHaveBeenCalledOnce();
  expect(await readFile(join(workspace, 'docs', (await previous()).brief.path), 'utf8')).toContain(
    'Summary',
  );
});

it('generates one brief for all sections and ignores legacy per-section brief records', async () => {
  for (let index = 0; index < 12; index++) {
    const directory = 'author/2026-11-17-group-' + index;
    await mkdir(join(workspace, 'docs', directory));
    await save(directory + '/notes.md', 'Evidence ' + index);
  }
  const report = await previous();
  for (const group of report.groups) {
    service.saveBrief(group.id, {
      digest: group.digest,
      status: 'completed',
      summary: 'Legacy brief',
    });
  }
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  const routes = createDailyReportRoutes(registry, service);
  const first = await routes[0].operation.execute({ day: '2026-11-17' }, { kind: 'user' });
  expect(first.value.groups).toHaveLength(10);
  expect(first.value.groups.every((group) => !('brief' in group))).toBe(true);
  expect(first.value.brief.status).toBe('completed');
  expect(first.value.brief.summary).not.toBe('Legacy brief');
  expect(generator).toHaveBeenCalledOnce();
  expect(generator.mock.calls[0][0].observedEvidence).toHaveLength(12);
});

it('reads identically named files from their own workspaces and publishes one daily artifact', async () => {
  const other = join(root, 'other');
  await mkdir(join(other, 'docs/author/2026-11-17-change'), { recursive: true });
  registry.list = () => [
    { id: 'ws', title: 'Workspace', path: workspace },
    { id: 'other', title: 'Other', path: other },
  ];
  const path = 'author/2026-11-17-change/requirement.md';
  await save(path, 'Workspace one requirement');
  await writeFile(join(other, 'docs', path), 'Workspace two requirement');
  await service.committed('other', path, 'writing');
  config.workspaceId = 'other';
  service.onBrief = vi.fn();
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  const report = await previous();
  expect(report.groups).toHaveLength(2);
  expect(report.brief).toMatchObject({ status: 'completed', workspaceId: 'other' });
  expect(report.brief.reads.map((file) => file.workspaceId)).toEqual(['ws', 'other']);
  expect(generator).toHaveBeenCalledOnce();
  expect(generator.mock.calls[0][0].observedEvidence.map((file) => file.body)).toEqual([
    'Workspace one requirement',
    'Workspace two requirement',
  ]);
  expect(await readFile(join(other, 'docs', report.brief.path), 'utf8')).toContain('Summary');
  expect(
    await readFile(join(workspace, 'docs', report.brief.path)).catch((error) => error.code),
  ).toBe('ENOENT');
  expect(service.onBrief).toHaveBeenCalledExactlyOnceWith('other', report.brief.path);
  const routes = createDailyReportRoutes(registry, service);
  const scoped = await routes[0].operation.execute(
    { day: report.day, workspaceId: 'ws' },
    {
      kind: 'agent',
      agent: { session: { header: { cwd: workspace } } },
    },
  );
  expect(scoped.value.groups).toHaveLength(1);
  expect(scoped.value.brief).toBeNull();
  expect(scoped.value.id).toBeUndefined();
  config.workspaceId = 'ws';
  await finish();
  expect(generator).toHaveBeenCalledOnce();
  expect((await previous()).brief.workspaceId).toBe('other');
});

it('retains tool failure diagnostics and clears the previous failure while retrying', async () => {
  await save('session.md', 'Evidence');
  generator.mockRejectedValueOnce(
    Object.assign(new Error('KB_TOOL_FAILED'), {
      code: 'KB_TOOL_FAILED',
      details: {
        cause: 'KB_EVIDENCE_NOT_FULLY_READ',
        causeDetails: { unreadRequired: [{ id: 'one', offset: 0 }] },
      },
    }),
  );
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  const group = (await previous()).groups[0];
  expect((await previous()).brief).toMatchObject({
    status: 'failed',
    error: 'KB_TOOL_FAILED',
    errorDetails: {
      cause: 'KB_EVIDENCE_NOT_FULLY_READ',
      unreadRequiredCount: 1,
    },
  });
  await finish();
  expect(generator).toHaveBeenCalledOnce();
  let release;
  generator.mockImplementationOnce(async (input) => {
    await consume(input);
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  service.enqueue('2026-11-17', (await previous()).id);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect((await previous()).brief).toMatchObject({
    status: 'running',
    error: null,
    errorDetails: null,
  });
  release('Recovered summary');
  await service.execution;
  expect((await previous()).brief.status).toBe('completed');
});

it('recovers interrupted and older failed brief attempts once after restart', async () => {
  await save('session.md', 'Evidence');
  const group = (await previous()).groups[0];
  service.saveBrief((await previous()).id, {
    digest: (await previous()).digest,
    status: 'running',
    error: 'KB_TOOL_FAILED',
  });
  await service.close();
  service = new DailyReports({
    registry,
    directory: root,
    configLoader: async () => config,
    now: () => now,
    generateBrief: generator,
  });
  expect((await previous()).brief).toMatchObject({
    status: 'stale',
    error: 'DAILY_INTERRUPTED',
  });
  service.saveBrief((await previous()).id, {
    digest: (await previous()).digest,
    status: 'failed',
    error: 'ENOTDIR',
  });
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  await finish();
  expect(generator).toHaveBeenCalledOnce();
  expect((await previous()).brief.status).toBe('completed');
});

it('waits for 08:00 in the configured zone and catches up once after restart', async () => {
  await save('session.md', 'frozen');
  now = new Date('2026-11-17T23:59:00Z');
  await finish();
  expect(generator).not.toHaveBeenCalled();
  now = new Date('2026-11-18T00:00:00Z');
  await finish();
  expect(generator).toHaveBeenCalledTimes(1);
  const brief = (await previous()).brief;
  expect(brief.status).toBe('completed');
  expect(await readFile(join(workspace, 'docs', brief.path), 'utf8')).toContain('Summary');
  await service.close();
  service = new DailyReports({
    registry,
    directory: root,
    configLoader: async () => config,
    now: () => now,
    generateBrief: generator,
  });
  await finish();
  expect(generator).toHaveBeenCalledTimes(1);
  expect((await service.view('2026-11-18')).groups).toHaveLength(0);
});

it('collects while Feishu is disabled and does not let discovery erase the producer', async () => {
  const documents = new DocumentReplicas({
    registry,
    directory: root,
    lark: {},
    configLoader: async () => config,
  });
  try {
    await writeFile(join(workspace, 'docs/generated.md'), 'content');
    expect(
      await notifyDocumentCommit(
        { documents, dailyReports: service },
        'ws',
        'generated.md',
        'writing',
      ),
    ).toEqual({
      status: 'disabled',
    });
    await service.refresh();
    expect((await previous()).groups[0].files[0].sources).toEqual(['writing']);
  } finally {
    await documents.close();
  }
});

it('bootstraps only recent current versions and reports discovery provenance', async () => {
  for (const [path, date] of [
    ['old.md', '2026-11-10'],
    ['yesterday.md', '2026-11-16'],
  ]) {
    await writeFile(join(workspace, 'docs', path), path);
    await utimes(join(workspace, 'docs', path), new Date(date), new Date(date));
  }
  await service.refresh();
  const report = await service.view('2026-11-16');
  expect(report.groups.flatMap((item) => item.files).map((file) => file.path)).toEqual([
    'yesterday.md',
  ]);
  expect(report.groups[0].files[0].observed).toBe(true);
  expect((await service.view('2026-11-10')).groups).toHaveLength(0);
});

it('retains the old brief and protects user edits when yesterday gains another file', async () => {
  await save('session.md', 'frozen');
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  const group = (await previous()).groups[0];
  await writeFile(join(workspace, 'docs', (await previous()).brief.path), 'user edited');
  now = new Date('2026-11-17T05:00:00Z');
  await save('another.md', 'late');
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  const next = await previous();
  expect(next.brief.status).toBe('failed');
  expect(next.brief.error).toBe('DAILY_OUTPUT_CONFLICT');
  expect(next.brief.summary).toBe('Summary of confirmed files.');
  expect(await readFile(join(workspace, 'docs', (await previous()).brief.path), 'utf8')).toBe(
    'user edited',
  );
});

it('does not publish stale model results and retries a newer input version', async () => {
  await save('session.md', 'one');
  let release;
  generator.mockImplementationOnce(async (input) => {
    await consume(input);
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  now = new Date('2026-11-18T01:00:00Z');
  await service.refresh();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  now = new Date('2026-11-17T06:00:00Z');
  await save('session.md', 'two');
  now = new Date('2026-11-18T01:00:00Z');
  release('stale summary');
  await service.execution;
  expect((await previous()).brief.status).toBe('stale');
  await finish();
  expect((await previous()).brief.status).toBe('completed');
});

it('waits for actual cancellation before closing storage and never writes a canceled result', async () => {
  await save('session.md', 'one');
  let release;
  generator.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  now = new Date('2026-11-18T01:00:00Z');
  await service.refresh();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release('canceled');
  await closing;
  expect(
    await readFile(join(workspace, 'docs/daily-reports/2026-11-17-summary.md')).catch(
      (error) => error.code,
    ),
  ).toBe('ENOENT');
});

it('keeps failed jobs terminal until explicit retry and authorizes retry scope', async () => {
  await save('session.md', 'one');
  generator.mockRejectedValueOnce(new Error('private model detail'));
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  await finish();
  expect(generator).toHaveBeenCalledTimes(1);
  const group = (await previous()).groups[0];
  const routes = createDailyReportRoutes(registry, service);
  const operation = routes[1].operation.execute;
  await expect(
    operation(
      { day: '2026-11-17', id: (await previous()).id, workspaceId: 'ws' },
      { kind: 'agent', agent: { session: { header: { cwd: root } } } },
    ),
  ).rejects.toThrow('DAILY_USER_REQUIRED');
  await operation(
    { day: '2026-11-17', id: (await previous()).id, workspaceId: 'ws' },
    { kind: 'user' },
  );
  await service.execution;
  expect((await previous()).brief.status).toBe('completed');
});

it('rejects traversal and junction escapes without imposing a source-file content quota', async () => {
  await expect(service.committed('ws', '../outside.md')).rejects.toThrow();
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside/private.md'), 'private');
  await symlink(join(root, 'outside'), join(workspace, 'docs/link'), 'junction');
  await expect(service.committed('ws', 'link/private.md')).rejects.toThrow();
  config.dailyReports = { maxFileBytes: 2 };
  await writeFile(join(workspace, 'docs/large.md'), 'large');
  await utimes(join(workspace, 'docs/large.md'), now, now);
  await service.refresh();
  await service.committed('ws', 'large.md');
  expect(
    (await previous()).groups
      .flatMap((group) => group.files)
      .find((file) => file.path === 'large.md').size,
  ).toBe(5);
});

it('deduplicates knowledge releases and keeps cross-requirement pages in shared files', async () => {
  const page = { pageId: 'topics/page', text: 'published' };
  await service.published('ws', page, '', 'release-one');
  await service.published('ws', page, '', 'release-two');
  expect((await previous()).groups[0].files).toHaveLength(1);
  expect((await previous()).groups[0].files[0].sources).toEqual(['knowledge']);
});

it('handles DST calendar arithmetic and does not split multibyte evidence or omit binary files', () => {
  expect(previousDay('2026-03-09')).toBe('2026-03-08');
  expect(previousDay('2024-03-01')).toBe('2024-02-29');
  expect(() => previousDay('2026-02-30')).toThrow('DAILY_INPUT_INVALID');
  expect(requirementGroup('author/2026-11-17-change/nested/file.md')).toBe(
    'author/2026-11-17-change',
  );
  expect(requirementGroup('author/2026-11-17-api-test.log')).toBe('');
  expect(requirementGroup('2026-11-17-notes.md')).toBe('');
  expect(requirementGroup('author\\2026-11-17-change\\2026-11-18-file.log')).toBe(
    'author/2026-11-17-change',
  );
  const body = '中文😀'.repeat(20000);
  const batches = briefBatches([
    { id: 'text', path: 'text.md', version: 'v1', body, contentAvailable: true },
    { id: 'binary', path: 'image.png', version: 'v2', body: null, contentAvailable: false },
  ]);
  expect(
    batches
      .flat()
      .filter((item) => item.id.startsWith('text:'))
      .map((item) => item.body.slice(item.body.indexOf('\n') + 1))
      .join(''),
  ).toBe(body);
  expect(batches.flat().at(-1).body).toContain('"contentAvailable":false');
});

it('paginates every group and file through the shared operation without truncation', async () => {
  for (let index = 0; index < 53; index++) {
    await save(`file-${index}.md`, String(index));
  }
  const execute = createDailyReportRoutes(registry, service)[0].operation.execute;
  const first = (await execute({ day: '2026-11-17' })).value;
  expect(first.groups[0].count).toBe(53);
  expect(first.groups[0].files).toHaveLength(50);
  expect(first.groups[0].nextFileOffset).toBe(50);
  const second = (await execute({ day: '2026-11-17', groupId: first.groups[0].id, fileOffset: 50 }))
    .value;
  expect(second.groups[0].files).toHaveLength(3);
  expect(second.groups[0].nextFileOffset).toBeNull();
  await expect(execute({ fileOffset: -1 })).rejects.toThrow('DAILY_INPUT_INVALID');
});

it('separates knowledge virtual paths from identically named local files', async () => {
  await mkdir(join(workspace, 'docs/wiki/topics'), { recursive: true });
  await save('wiki/topics/page.md', 'local');
  await service.published('ws', { pageId: 'topics/page', text: 'wiki' }, '', 'release');
  expect((await previous()).groups[0].files).toHaveLength(2);
});

it('schedules yesterday correctly across the DST transition in the configured zone', async () => {
  config.general.timeZone = 'America/New_York';
  now = new Date('2026-03-08T06:30:00Z');
  await save('early.md', 'before DST jump');
  now = new Date('2026-03-09T11:59:00Z');
  await finish();
  expect(generator).not.toHaveBeenCalled();
  now = new Date('2026-03-09T12:00:00Z');
  await finish();
  expect(generator.mock.calls[0][0].day).toBe('2026-03-08');
});

it('cancels and awaits the actual model operation when automatic briefs are disabled', async () => {
  await save('session.md', 'one');
  let started = false;
  let canceled = false;
  generator.mockImplementation(
    ({ signal }) =>
      new Promise((resolve) => {
        started = true;
        signal.addEventListener(
          'abort',
          () => {
            canceled = true;
            resolve('canceled');
          },
          { once: true },
        );
      }),
  );
  now = new Date('2026-11-18T01:00:00Z');
  await service.refresh();
  await vi.waitFor(() => expect(started).toBe(true));
  config.dailyReports = { enabled: false };
  await service.refresh();
  expect(canceled).toBe(true);
  expect((await previous()).brief.status).toBe('stale');
  expect(
    await readFile(join(workspace, 'docs/daily-reports/2026-11-17-summary.md')).catch(
      (error) => error.code,
    ),
  ).toBe('ENOENT');
});

it('records binary metadata and retains the file list when model generation fails', async () => {
  await save('image.png', Buffer.from([0, 255, 31]));
  const group = (await previous()).groups[0];
  expect((await read(group))[0]).toMatchObject({ body: null, contentAvailable: false });
  generator.mockRejectedValueOnce(
    Object.assign(new Error('DAILY_INPUT_LIMIT'), { code: 'DAILY_INPUT_LIMIT' }),
  );
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  expect((await previous()).brief).toMatchObject({
    status: 'failed',
    error: 'DAILY_INPUT_LIMIT',
  });
  expect((await previous()).groups[0].files).toHaveLength(1);
});

it('updates an owned brief when late evidence arrives and never includes that brief in its own input', async () => {
  await save('session.md', 'one');
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  now = new Date('2026-11-17T06:00:00Z');
  await save('late.md', 'two');
  now = new Date('2026-11-18T01:00:00Z');
  generator.mockImplementationOnce((input) => consume(input, 'Updated summary'));
  await finish();
  const group = (await previous()).groups[0];
  expect((await previous()).brief.status).toBe('completed');
  expect(group.files).toHaveLength(2);
  expect(await readFile(join(workspace, 'docs', (await previous()).brief.path), 'utf8')).toContain(
    'Updated summary',
  );
  expect((await service.view('2026-11-18')).groups).toHaveLength(0);
});

it('indexes source metadata without copying bodies or applying former storage and file quotas', async () => {
  config.dailyReports = { maxFileBytes: 1, maxStorageBytes: 1, maxFiles: 1 };
  const body = 'original source content '.repeat(10000);
  await save('large.md', body);
  await save('another.md', 'other');
  const files = (await previous()).groups.flatMap((group) => group.files);
  expect(files).toHaveLength(2);
  expect(files.find((file) => file.path === 'large.md').size).toBe(Buffer.byteLength(body));
  expect(
    service.db
      .prepare('PRAGMA table_info(daily_files)')
      .all()
      .map((column) => column.name),
  ).not.toContain('bytes');
  expect(JSON.stringify(service.db.prepare('SELECT * FROM daily_files').all())).not.toContain(
    'original source content',
  );
  expect(await readFile(join(workspace, 'docs/large.md'), 'utf8')).toBe(body);
});

it('removes the retired body column while retaining file references and original files', async () => {
  await save('file.md', 'keep original');
  await service.close();
  const legacy = new DatabaseSync(join(root, 'daily-reports.sqlite'));
  legacy.exec('ALTER TABLE daily_files ADD COLUMN bytes BLOB');
  legacy.prepare('UPDATE daily_files SET bytes=?').run(Buffer.from('retired duplicate'));
  legacy.close();
  service = new DailyReports({
    registry,
    directory: root,
    configLoader: async () => config,
    now: () => now,
    generateBrief: generator,
  });
  expect(
    service.db
      .prepare('PRAGMA table_info(daily_files)')
      .all()
      .map((column) => column.name),
  ).not.toContain('bytes');
  expect((await previous()).groups[0].files[0].path).toBe('file.md');
  expect(await readFile(join(workspace, 'docs/file.md'), 'utf8')).toBe('keep original');
});

it('reports missing originals explicitly and never reconstructs their bodies from a report archive', async () => {
  await save('removed.md', 'private original');
  await rm(join(workspace, 'docs/removed.md'));
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  const group = (await previous()).groups[0];
  expect((await previous()).brief.status).toBe('completed');
  expect((await previous()).brief.reads[0].fileState).toBe('unavailable');
  expect(generator.mock.calls[0][0].observedEvidence[0]).toMatchObject({
    body: null,
    contentAvailable: false,
    fileState: 'unavailable',
  });
});

it('streams a large original in bounded chunks and closes its handle on cancellation', async () => {
  const body = '中文😀'.repeat(20000);
  await save('large.md', body);
  const group = (await previous()).groups[0];
  const chunks = await read(group);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map((chunk) => chunk.body).join('')).toBe(body);
  const controller = new AbortController();
  const reader = service.evidence(group, controller.signal);
  await reader.next();
  controller.abort();
  await expect(reader.next()).rejects.toThrow();
  await writeFile(join(workspace, 'docs/large.md'), 'replaced');
});

it('finishes the single daily brief while an independent output consumer remains busy', async () => {
  await save('shared.md', 'shared');
  await save('author/2026-11-17-change/requirement.md', 'requirement');
  const releases = [];
  service.onBrief = vi.fn(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  now = new Date('2026-11-18T01:00:00Z');
  await finish();
  expect((await previous()).brief.status).toBe('completed');
  expect(service.onBrief).toHaveBeenCalledOnce();
  releases.forEach((release) => release());
});
