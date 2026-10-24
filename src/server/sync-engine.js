/** Commit-based document sync: branch resolution, code inputs, and task reservation. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import taskModel from '../shared/sync-task.cjs';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { hashBytes, decodeDocument } from './sync-artifacts.js';
import { filterSyncCodeDiff, isSyncCodeFile, parseSyncCodeDiff } from './sync-code-files.js';
import { parseBranchName } from './utils.js';
import { loadState, getActiveSync, getSyncHistory, setActiveSync, getAbortController, completeSync, removeSyncTask } from './sync-state.js';
import { defaultSyncBaseBranch, listSyncCommits } from './sync-branches.js';

const execFileAsync = promisify(execFile);
const reservations = new Map();
const git = async (cwd, ...args) => (await execFileAsync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
})).stdout.trimEnd();

async function isAncestor(cwd, older, newer) {
  try {
    await git(cwd, 'merge-base', '--is-ancestor', older, newer);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw new Error('历史同步 commit 不可用，无法安全判断同步基准');
  }
}

/** Capture each working-tree layer without changing the index or working files. */
async function readWorkingChanges(cwd) {
  const paths = ['--', '.', ':(exclude)**/sync-logs/**'];
  const staged = await git(cwd, 'diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv', ...paths);
  const unstaged = await git(cwd, 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', ...paths);
  const untracked = (await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z', ...paths)).split('\0').filter(Boolean);
  const patches = [];
  for (const file of untracked.filter(isSyncCodeFile)) {
    try {
      patches.push(await git(cwd, 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file));
    } catch (error) {
      // A nonempty --no-index diff exits with 1, including for binary files.
      if (error.code !== 1 || typeof error.stdout !== 'string') throw error;
      patches.push(error.stdout.trimEnd());
    }
  }
  return { staged: filterSyncCodeDiff(staged), unstaged: filterSyncCodeDiff(unstaged), untracked: untracked.filter(isSyncCodeFile), untrackedDiff: filterSyncCodeDiff(patches.filter(Boolean).join('\n\n')),
    hasChanges: !!(staged || unstaged || untracked.length) };
}

/** Resolve the same local requirement branch for display and synchronization. */
export async function findBranchByRequirement(cwd, requirementId, currentBranch) {
  const current = currentBranch ?? await git(cwd, 'branch', '--show-current');
  const branches = (await git(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).split('\n');
  const matches = branches.filter(branch => branch === requirementId || parseBranchName(branch)?.requirementId === requirementId);
  const branchName = matches.includes(current) ? current : matches.length === 1 ? matches[0] : null;
  if (!branchName) throw new Error(matches.length ? '存在多个需求分支，请切换到目标需求分支' : '未找到需求对应的本地 Git 分支');
  return branchName;
}

/** Freeze a local requirement branch tip. Git ancestry, never timestamps, orders versions. */
export async function prepareCommitSync(cwd, requirementId, docType, history, options = {}) {
  if (!['requirement', 'design'].includes(docType)) throw new Error('不支持的文档类型');
  const current = await git(cwd, 'branch', '--show-current');
  const branchName = await findBranchByRequirement(cwd, requirementId, current);
  const commitHash = await git(cwd, 'rev-parse', '--verify', `refs/heads/${branchName}^{commit}`);
  const selectionMode = options.commitHashes !== undefined;
  const sessionSnapshots = options.sessionSnapshots || [];
  const successes = history.filter(item => item.schemaVersion === 2 && item.branchName === branchName && item.docType === docType && taskModel.hasPublishedDocument(item) && item.commitHash && !item.selectionMode);
  let baseline = null;
  for (const item of selectionMode || sessionSnapshots.length ? [] : successes) {
    if (await isAncestor(cwd, commitHash, item.commitHash)) {
      return { skipped: true, commitHash, branchName, message: '当前 commit 已同步，或早于历史成功同步版本' };
    }
    if (!(await isAncestor(cwd, item.commitHash, commitHash))) {
      throw new Error('当前提交与历史同步提交已分叉，请先处理分支历史');
    }
    if (!baseline || await isAncestor(cwd, baseline, item.commitHash)) baseline = item.commitHash;
  }
  if (!baseline) {
    const ref = options.baseBranch?.trim() || await defaultSyncBaseBranch(cwd);
    if (!ref || ref.startsWith('-') || /[\s\x00]/.test(ref)) throw new Error('BASE_BRANCH_REQUIRED: 请配置同步基准分支');
    const sha = await git(cwd, 'rev-parse', '--verify', ref + '^{commit}').catch(() => { throw new Error('BASE_BRANCH_NOT_FOUND: ' + ref); });
    const bases = (await git(cwd, 'merge-base', '--all', sha, commitHash).catch(() => '')).split('\n').filter(Boolean);
    if (bases.length !== 1) throw new Error('BASE_ANCESTOR_AMBIGUOUS: 必须具有唯一最近共同祖先');
    baseline = bases[0];
  }
  const range = baseline ? `${baseline}..${commitHash}` : commitHash;
  const hashes = (await git(cwd, 'rev-list', '--reverse', range)).split('\n').filter(Boolean);
  let commits = await Promise.all(hashes.map(async hash => {
    const fields = (await git(cwd, 'show', '-s', '--format=%H%n%s%n%an%n%aI', hash)).split('\n');
    return { hash: fields[0], subject: fields[1], author: fields[2], date: fields[3] };
  }));
  let committedDiff;
  let selectionKey = null, comparison = null;
  const selectedChanges = new Map();
  if (selectionMode) {
    if (!Array.isArray(options.commitHashes) || options.commitHashes.length > 10000 || options.commitHashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{40,64}$/.test(hash))) throw new Error('COMMIT_SELECTION_INVALID: 提交清单无效');
    const ref = options.baseBranch?.trim() || await defaultSyncBaseBranch(cwd);
    comparison = await listSyncCommits(cwd, branchName, ref);
    if (comparison.branchTip !== commitHash || options.branchTip && options.branchTip !== commitHash || options.baseCommit && options.baseCommit !== comparison.baseline) throw new Error('COMMIT_LIST_CHANGED: 分支已更新，请刷新 commit 列表后重新选择');
    const chosen = new Set(options.commitHashes);
    if ([...chosen].some(hash => !comparison.commits.some(commit => commit.hash === hash))) throw new Error('COMMIT_OUT_OF_RANGE: 所选 commit 不在目标分支相对基准分支的差异中');
    commits = comparison.commits.filter(commit => chosen.has(commit.hash));
    const diffs = [];
    for (const commit of commits) {
      const parent = commit.parent;
      const diff = filterSyncCodeDiff(parent
        ? await git(cwd, 'diff', '--no-renames', '--no-textconv', '--no-ext-diff', parent, commit.hash, '--')
        : await git(cwd, 'show', '--format=', '--root', '--no-renames', '--no-textconv', '--no-ext-diff', commit.hash, '--'));
      if (diff) diffs.push(diff);
      for (const { file } of parseSyncCodeDiff(diff)) {
        if (!selectedChanges.has(file)) selectedChanges.set(file, []);
        selectedChanges.get(file).push({ commitHash: commit.hash, parent });
      }
    }
    committedDiff = diffs.join('\n\n');
  } else committedDiff = filterSyncCodeDiff(await git(cwd, 'diff', '--no-renames', '--no-textconv', '--no-ext-diff', baseline, commitHash, '--'));
  const indexBefore = await git(cwd, 'ls-files', '--stage', '-z');
  const uncommittedChanges = await readWorkingChanges(cwd);
  if (options.includeWorkingChanges !== false && uncommittedChanges.hasChanges && current !== branchName) {
    throw new Error('当前工作分支存在未提交改动，请切换到需求分支后同步');
  }
  const includeWorkingChanges = options.includeWorkingChanges !== false;
  const codeDiff = [
    committedDiff && `# 已提交的变更\n\n${committedDiff}`,
    includeWorkingChanges && uncommittedChanges.staged && `# 已暂存但未提交的变更\n\n${uncommittedChanges.staged}`,
    includeWorkingChanges && uncommittedChanges.unstaged && `# 未暂存的变更\n\n${uncommittedChanges.unstaged}`,
    includeWorkingChanges && uncommittedChanges.untrackedDiff && `# 未跟踪的新文件\n\n${uncommittedChanges.untrackedDiff}`,
  ].filter(Boolean).join('\n\n');
  const sourceSnapshots = [];
  const casePaths = new Map();
  for (const file of new Set(parseSyncCodeDiff(codeDiff).map(item => item.file))) {
    const lower = file.toLowerCase();
    if (casePaths.has(lower) && casePaths.get(lower) !== file) throw new Error('SOURCE_CASE_COLLISION');
    casePaths.set(lower, file);
    const at = async sha => {
      if (!sha) return null;
      const object = await git(cwd, 'ls-tree', '-z', sha, '--', file);
      if (!object) return null;
      if (!object.startsWith('100')) throw new Error('SOURCE_NOT_REGULAR: ' + file);
      return decodeDocument((await execFileAsync('git', ['show', sha + ':' + file], { cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 })).stdout);
    };
    if (selectionMode) {
      const changes = [];
      for (const change of selectedChanges.get(file) || []) changes.push({ ...change, base: await at(change.parent), target: await at(change.commitHash) });
      const workingFile = includeWorkingChanges && parseSyncCodeDiff([uncommittedChanges.staged, uncommittedChanges.unstaged, uncommittedChanges.untrackedDiff].join('\n\n')).some(item => item.file === file);
      let working = null;
      if (workingFile && current === branchName) {
        try { if (!(await lstat(join(cwd, file))).isFile()) throw new Error('SOURCE_NOT_REGULAR: ' + file); working = decodeDocument(await readFile(join(cwd, file))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      sourceSnapshots.push({ file, commitChanges: changes, ...(workingFile ? { working } : {}) });
      continue;
    }
    const base = await at(baseline), target = await at(commitHash);
    let final = target;
    if (current === branchName) {
      try {
        if (!(await lstat(join(cwd, file))).isFile()) throw new Error('SOURCE_NOT_REGULAR: ' + file);
        final = decodeDocument(await readFile(join(cwd, file)));
      }
      catch (e) { if (e.code === 'ENOENT') final = null; else throw e; }
    }
    sourceSnapshots.push({ file, base, target, final });
  }
  if ((await git(cwd, 'rev-parse', branchName)) !== commitHash || (await git(cwd, 'ls-files', '--stage', '-z')) !== indexBefore) throw new Error('INPUT_CHANGED: Git 状态在捕获期间变化');
  if (JSON.stringify(await readWorkingChanges(cwd)) !== JSON.stringify(uncommittedChanges)) throw new Error('INPUT_CHANGED: 工作区在捕获期间变化');
  if (selectionMode || sessionSnapshots.length) {
    const identity = [comparison?.baseline || baseline, commits.map(commit => commit.hash), includeWorkingChanges, includeWorkingChanges ? uncommittedChanges : null];
    if (sessionSnapshots.length) identity.push(sessionSnapshots);
    selectionKey = hashBytes(Buffer.from(JSON.stringify(identity)));
    if (history.some(item => item.schemaVersion === 2 && taskModel.hasPublishedDocument(item) && item.branchName === branchName && item.docType === docType && item.selectionKey === selectionKey)) return { skipped: true, commitHash, branchName, message: '所选 commit 和未提交改动已同步' };
  }
  return { schemaVersion: 2, commitHash, branchName, baselineCommit: baseline, commits, committedDiff,
    uncommittedChanges: includeWorkingChanges ? uncommittedChanges : { staged: '', unstaged: '', untracked: [], untrackedDiff: '', hasChanges: false },
    codeDiff, sourceSnapshots, selectionMode, selectionKey };
}

/** Serialize preflight + reservation so two requests cannot both pass the history gate. */
function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || new Error('同步已取消')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export async function beginCommitSync(cwd, reqDir, fields, { signal } = {}) {
  const key = `${fields.workspaceId}:${fields.requirementId}`;
  const previous = reservations.get(key) || Promise.resolve();
  let release;
  const lock = new Promise(resolve => { release = resolve; });
  reservations.set(key, lock);
  let created;
  try {
    await abortable(previous, signal);
    signal?.throwIfAborted();
    await loadState(fields.workspaceId, fields.requirementId, reqDir);
    if (getAbortController(fields.workspaceId, fields.requirementId)?.controller.signal.aborted) {
      throw new Error('上一个同步任务正在终止，请稍后重试');
    }
    const active = await getActiveSync(fields.workspaceId, fields.requirementId);
    if (taskModel.isSyncActive(active)) return { active: true, sync: active };
    if (active) await completeSync(active.id, fields.workspaceId, fields.requirementId);
    const prepared = await abortable(prepareCommitSync(cwd, fields.requirementId, fields.docType,
      await getSyncHistory(fields.workspaceId, fields.requirementId), { baseBranch: fields.baseBranch, commitHashes: fields.commitHashes, branchTip: fields.branchTip, baseCommit: fields.baseCommit, includeWorkingChanges: fields.includeWorkingChanges, sessionSnapshots: fields.sessionSnapshots }), signal);
    if (prepared.skipped) return prepared;
    const id = `${fields.docType}-${prepared.commitHash}-${hashBytes(Buffer.from(prepared.branchName)).slice(0, 12)}${prepared.selectionKey ? '-' + prepared.selectionKey.slice(0, 16) : ''}`;
    const sync = { ...fields, schemaVersion: 2, id, commitHash: prepared.commitHash, branchName: prepared.branchName,
      hasUncommitted: prepared.uncommittedChanges.hasChanges,
      selectionMode: prepared.selectionMode, selectionKey: prepared.selectionKey,
      selectedCommitHashes: prepared.selectionMode ? prepared.commits.map(commit => commit.hash) : undefined,
      baselineCommit: prepared.baselineCommit, snapshotDir: `v2/${id}/${randomUUID()}`,
      startedAt: Date.now(), status: 'running' };
    signal?.throwIfAborted(); created = sync;
    await setActiveSync(sync, reqDir);
    signal?.throwIfAborted();
    return { ...prepared, sync };
  } catch (error) {
    if (created && signal?.aborted) await removeSyncTask(created);
    throw error;
  } finally {
    release();
    if (reservations.get(key) === lock) reservations.delete(key);
  }
}

