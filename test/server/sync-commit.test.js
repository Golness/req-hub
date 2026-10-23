import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prepareCommitSync as prepareRaw, beginCommitSync as beginRaw } from '../../src/server/sync-engine.js';
import { completeSync, getSyncHistory, updateSyncProgress, abortSync, setAbortController, deleteAbortController } from '../../src/server/sync-state.js';

const prepareCommitSync=(cwd,id,type,history=[],options={})=>prepareRaw(cwd,id,type,history,{baseBranch:'main',...options});
const beginCommitSync=(cwd,dir,fields)=>beginRaw(cwd,dir,{baseBranch:'main',...fields});
let repo, base, first, second;
const requirementId = '2026-10-19-sync-test';
const branch = `feature/dev/${requirementId}`;
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = async text => {
  await writeFile(join(repo, 'code.js'), text);
  git('add', 'code.js'); git('commit', '-m', text);
  return git('rev-parse', 'HEAD');
};
const success = (commitHash, docType = 'requirement') => ({ schemaVersion:2, branchName:branch, id: `${docType}-${commitHash}`, docType, commitHash, status: 'completed' });
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'req-hub-sync-'));
  git('init', '-b', 'main'); git('config', 'user.name', 'Sync Test'); git('config', 'user.email', 'sync@example.test');
  base = await commit('base'); git('switch', '-c', branch);
  first = await commit('first'); second = await commit('second');
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

describe('commit-based sync', () => {
  it.each(['requirement', 'design'])('uses local unpushed %s branch tip, includes all working-tree layers, and freezes content', async docType => {
    await writeFile(join(repo, 'code.js'), 'STAGED');
    git('add', 'code.js');
    await writeFile(join(repo, 'code.js'), 'DIRTY');
    await writeFile(join(repo, 'untracked.js'), 'UNTRACKED');
    const result = await prepareCommitSync(repo, requirementId, docType, [success(first, docType)]);
    expect(result.commitHash).toBe(second);
    expect(result.baselineCommit).toBe(first);
    expect(result.commits.map(commit => commit.hash)).toEqual([second]);
    expect(result.codeDiff).toContain('+second');
    expect(result.codeDiff).toContain('+STAGED');
    expect(result.codeDiff).toContain('+DIRTY');
    expect(result.codeDiff).toContain('+UNTRACKED');
    expect(result.uncommittedChanges.hasChanges).toBe(true);
    await commit('third');
    expect(result.commitHash).toBe(second);
    expect(result.codeDiff).not.toContain('+third');
  });
  it('does not report a clean working tree as modified', async () => {
    expect((await prepareCommitSync(repo, requirementId, 'requirement', [])).uncommittedChanges.hasChanges).toBe(false);
  });
  it('keeps the same-commit skip rule even when the working tree is modified', async () => {
    await writeFile(join(repo, 'code.js'), 'DIRTY');
    expect((await prepareCommitSync(repo, requirementId, 'requirement', [success(second)])).skipped).toBe(true);
  });
  it('excludes sync logs and Git-ignored files from working-tree inputs', async () => {
    await mkdir(join(repo, 'docs', 'req', 'sync-logs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'req', 'sync-logs', 'input-code.diff'), 'SYNC_LOG');
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
    git('add', '.gitignore'); git('commit', '-m', 'ignore');
    await writeFile(join(repo, 'ignored.txt'), 'IGNORED');
    const result = await prepareCommitSync(repo, requirementId, 'requirement', []);
    expect(result.uncommittedChanges.hasChanges).toBe(false);
    expect(result.codeDiff).not.toMatch(/SYNC_LOG|IGNORED/);
  });
  it('rejects uncommitted changes belonging to a different checked-out branch', async () => {
    git('switch', 'main');
    await writeFile(join(repo, 'code.js'), 'OTHER_BRANCH');
    await expect(prepareCommitSync(repo, requirementId, 'requirement', [])).rejects.toThrow('切换到需求分支');
  });
  it.each(['requirement', 'design'])('skips equal and older %s commits', async docType => {
    expect((await prepareCommitSync(repo, requirementId, docType, [success(second, docType)])).skipped).toBe(true);
    git('reset', '--hard', first);
    expect((await prepareCommitSync(repo, requirementId, docType, [success(second, docType)])).skipped).toBe(true);
  });
  it('keeps document type baselines independent and retries failures', async () => {
    const history = [success(second, 'design'), { ...success(second), status: 'failed' }];
    expect((await prepareCommitSync(repo, requirementId, 'requirement', history)).skipped).not.toBe(true);
  });
  it('rejects divergent or unavailable historical commits', async () => {
    git('reset', '--hard', base); await commit('diverged');
    await expect(prepareCommitSync(repo, requirementId, 'requirement', [success(second)])).rejects.toThrow('分叉');
    await expect(prepareCommitSync(repo, requirementId, 'requirement', [success('a'.repeat(40))])).rejects.toThrow('不可用');
  });
  it('reads the requirement branch even when another branch is checked out', async () => {
    git('switch', 'main');
    expect((await prepareCommitSync(repo, requirementId, 'requirement', [])).commitHash).toBe(second);
  });
  it('refuses to expand the range when the configured base branch does not exist', async () => {
    git('branch', '-m', 'main', 'trunk');
    await expect(prepareCommitSync(repo, requirementId, 'requirement', [])).rejects.toThrow('BASE_BRANCH_NOT_FOUND');
  });
  it('uses the newest ancestor even if history is unordered', async () => {
    const third = await commit('third');
    const result = await prepareCommitSync(repo, requirementId, 'requirement', [success(first), success(second)]);
    expect(result.baselineCommit).toBe(second); expect(result.commitHash).toBe(third);
  });
  it('reserves concurrently, persists commit identity and timeline, and skips after success', async () => {
    const reqDir = join(repo, 'docs', requirementId); await mkdir(reqDir, { recursive: true });
    const fields = { workspaceId: randomUUID(), requirementId, docType: 'requirement', docTypeName: '需求文档' };
    const results = await Promise.all([beginCommitSync(repo, reqDir, fields), beginCommitSync(repo, reqDir, fields)]);
    expect(results.filter(result => result.active)).toHaveLength(1);
    const task = results.find(result => !result.active).sync;
    expect(task.id).toContain(`requirement-${second}`);
    await updateSyncProgress(task.id, { status: 'completed' }); await completeSync(task.id);
    const disk = JSON.parse(await readFile(join(reqDir, 'sync-logs', 'v2', '.sync-state.json'), 'utf8'));
    expect(disk.history[0].commitHash).toBe(second);
    expect(disk.timeline[0]).toMatchObject({ commitHash: second, status: 'completed', type: 'sync' });
    expect((await beginCommitSync(repo, reqDir, fields)).skipped).toBe(true);
  });
  it('blocks retries until an aborted engine settles, then reuses commit ID with a fresh snapshot directory', async () => {
    const reqDir = join(repo, 'docs', requirementId); await mkdir(reqDir, { recursive: true });
    const fields = { workspaceId: randomUUID(), requirementId, docType: 'design' };
    const firstRun = await beginCommitSync(repo, reqDir, fields);
    setAbortController(fields.workspaceId, requirementId, new AbortController(), firstRun.sync.id);
    await abortSync(firstRun.sync.id, fields.workspaceId, requirementId);
    await expect(beginCommitSync(repo, reqDir, fields)).rejects.toThrow('正在终止');
    deleteAbortController(fields.workspaceId, requirementId);
    const retry = await beginCommitSync(repo, reqDir, fields);
    expect(retry.sync.id).toBe(firstRun.sync.id);
    expect(retry.sync.snapshotDir).not.toBe(firstRun.sync.snapshotDir);
    await updateSyncProgress(retry.sync.id, { status: 'completed' }); await completeSync(retry.sync.id);
    expect(await getSyncHistory(fields.workspaceId, requirementId)).toHaveLength(1);
  });
});


it.each(['requirement', 'design'])('filters non-code inputs from all %s sync layers', async docType => {
  await writeFile(join(repo, 'README.md'), 'COMMITTED_DOCUMENT');
  await writeFile(join(repo, 'settings.json'), 'COMMITTED_CONFIGURATION');
  await mkdir(join(repo, 'tests'));
  await writeFile(join(repo, 'tests', 'helper.js'), 'COMMITTED_TEST');
  await mkdir(join(repo, 'dist'));
  await writeFile(join(repo, 'dist', 'bundle.js'), 'GENERATED_BUNDLE');
  git('add', '.'); git('commit', '-m', 'mixed inputs');
  await writeFile(join(repo, 'README.md'), 'STAGED_DOCUMENT'); git('add', 'README.md');
  await writeFile(join(repo, 'README.md'), 'UNSTAGED_DOCUMENT');
  await writeFile(join(repo, 'guide.txt'), 'UNTRACKED_DOCUMENT');
  await writeFile(join(repo, 'tests', 'helper.js'), 'STAGED_TEST'); git('add', 'tests/helper.js');
  await writeFile(join(repo, 'tests', 'helper.js'), 'UNSTAGED_TEST');
  await writeFile(join(repo, 'fresh.test.ts'), 'UNTRACKED_TEST');
  await writeFile(join(repo, 'fresh.ts'), 'SOURCE_UNTRACKED');
  const result = await prepareCommitSync(repo, requirementId, docType, [success(first, docType)]);
  expect(result.codeDiff).toContain('+second');
  expect(result.codeDiff).toContain('+SOURCE_UNTRACKED');
  expect(result.codeDiff).not.toMatch(/DOCUMENT|CONFIGURATION|GENERATED_BUNDLE|README|settings.json|guide.txt|_TEST/);
  expect(result.uncommittedChanges.staged).toBe('');
  expect(result.uncommittedChanges.unstaged).toBe('');
  expect(result.uncommittedChanges.untracked).toEqual(['fresh.ts']);
});
