import { msg } from './messages.js';
/** Read-only Git comparison shared by the selector and sync preflight. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { filterSyncCodeDiff, isSyncCodeFile } from './sync-code-files.js';
import { syncSignal } from './sync-cancellation.js';
const exec = promisify(execFile);
const git = async (cwd, ...args) =>
  (
    await exec('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      signal: syncSignal(),
    })
  ).stdout.trimEnd();

/**
 * List local branches only when the selected workspace owns the repository root.
 * @param cwd - Authorized workspace directory; parent repositories are rejected.
 * @returns Local branch names without changing the checkout or index.
 */
export async function listSyncBranches(cwd) {
  let root;
  try {
    root = await realpath(await git(cwd, 'rev-parse', '--show-toplevel'));
  } catch (error) {
    // A registered workspace may be a plain folder (or a removed checkout).
    // Report a stable code instead of leaking git's stderr into the daily report.
    if (error?.killed || error?.code === 'ABORT_ERR') {
      throw error;
    }
    throw Object.assign(new Error('SYNC_WORKSPACE_NOT_REPOSITORY'), { cause: error });
  }
  const workspaceRoot = await realpath(cwd);
  const canonical = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
  if (canonical(root) !== canonical(workspaceRoot)) {
    throw new Error('SYNC_WORKSPACE_REPOSITORY_MISMATCH');
  }
  const output = await git(cwd, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads');
  return output.split('\n').filter(Boolean);
}

/**
 * Resolve a local Git ref to a fixed commit.
 * @param cwd - Working directory for the operation.
 * @param ref - Local Git ref to resolve.
 * @returns The resolved commit identity; invalid refs reject.
 */
export async function resolveSyncRef(cwd, ref) {
  if (typeof ref !== 'string' || !ref.trim() || ref.startsWith('-') || /[\s\x00]/.test(ref)) {
    throw new Error('SYNC_BRANCH_REQUIRED');
  }
  return git(cwd, 'rev-parse', '--verify', `${ref}^{commit}`).catch(() => {
    throw msg('SYNC_BRANCH_NOT_FOUND', { v0: ref });
  });
}

/**
 * Select the first existing conventional local base branch.
 * @param cwd - Working directory for the operation.
 * @returns main, master, or null when neither exists.
 */
export async function defaultSyncBaseBranch(cwd) {
  for (const name of ['main', 'master']) {
    try {
      await git(cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`);
      return name;
    } catch (error) {
      // Try the next conventional base branch when this local ref does not exist.
    }
  }
  return null;
}

/**
 * List commits between the frozen base and target branch.
 * @param cwd - Working directory for the operation.
 * @param branchName - Target local branch name.
 * @param baseBranch - Confirmed base branch name.
 * @returns Commit selection metadata in repository order.
 */
export async function listSyncCommits(cwd, branchName, baseBranch) {
  const branchTip = await resolveSyncRef(cwd, `refs/heads/${branchName}`);
  const baseline = await resolveSyncRef(cwd, baseBranch);
  const output = await git(
    cwd,
    'log',
    '--reverse',
    '--topo-order',
    '--format=%H%x00%P%x00%s%x00%an%x00%aI%x00',
    `${baseline}..${branchTip}`,
    '--',
  );
  const fields = output.split('\0');
  const commits = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const hash = fields[i].trim();
    if (!hash) {
      continue;
    }
    const parents = fields[i + 1].split(' ').filter(Boolean);
    commits.push({
      hash,
      shortHash: hash.slice(0, 8),
      parent: parents[0] || null,
      merge: parents.length > 1,
      subject: fields[i + 2],
      author: fields[i + 3],
      date: fields[i + 4],
    });
  }
  const workingDiff = filterSyncCodeDiff(
    await git(cwd, 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--'),
  );
  const stagedDiff = filterSyncCodeDiff(
    await git(cwd, 'diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv', '--'),
  );
  const untracked = (await git(cwd, 'ls-files', '--others', '--exclude-standard', '-z'))
    .split('\0')
    .filter(isSyncCodeFile);
  return {
    branchName,
    baseBranch,
    baseline,
    branchTip,
    commits,
    hasUncommitted: !!(workingDiff || stagedDiff || untracked.length),
  };
}
