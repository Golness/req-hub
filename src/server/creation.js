import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseBranchName } from './utils.js';
import { buildTree } from './tree.js';
import { safeDocumentPath } from './safe-path.js';
import { withDocumentLock } from './sync-document-validator.js';

const exec = promisify(execFile);
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { status }); };
const git = async (workspace, args, signal) => (await exec('git', args, { cwd: workspace.path, signal, timeout: 60000, maxBuffer: 1_000_000, windowsHide: true })).stdout.trim();
async function repositoryState(workspace, signal) {
  const repositoryRoot = await git(workspace, ['rev-parse', '--show-toplevel'], signal);
  const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
  const ownsRepository = canonical(await realpath(repositoryRoot)) === canonical(await realpath(workspace.path));
  const branch = await git(workspace, ['branch', '--show-current'], signal);
  const head = await git(workspace, ['rev-parse', 'HEAD'], signal);
  const dirty = !!await git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'], signal);
  let inProgress = false;
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const path = await git(workspace, ['rev-parse', '--git-path', name], signal);
    if (await stat(resolve(workspace.path, path)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) inProgress = true;
  }
  return { branch, head, dirty, inProgress, canUpdateMain: ownsRepository && ['main', 'master'].includes(branch) && !dirty && !inProgress };
}
export async function creationStatus(workspace, config, signal) {
  let state;
  try { state = await repositoryState(workspace, signal); }
  catch (error) { if (signal?.aborted) throw error; if (error.code !== 128) throw error; return { branch: null, canUpdateMain: false, existingRequirement: null }; }
  const parsed = parseBranchName(state.branch);
  let existingRequirement = null;
  if (parsed?.developer && parsed.date) {
    const docsDir = config.docsDir || 'docs', root = resolve(workspace.path, docsDir);
    if (root !== resolve(workspace.path)) await safeDocumentPath(workspace.path, docsDir, { allowMissing: true });
    const tree = await buildTree(root);
    const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    for (const developer of tree.developers) if (same(developer.name, parsed.developer)) {
      const req = developer.requirements.find(item => same(item.id, parsed.requirementId));
      if (req) { await safeDocumentPath(root, req.path); existingRequirement = { ...req, developer: developer.name }; break; }
    }
  }
  return { ...state, existingRequirement };
}
export async function updateMain(workspace, expectedHead, signal, expectedBranch) {
  if (typeof expectedHead !== 'string' || !/^[0-9a-f]{40,64}$/.test(expectedHead)) fail('CREATE_INVALID_INPUT', 400);
  return withDocumentLock(join(workspace.path, '.reqhub-git-operation'), async () => {
    const before = await repositoryState(workspace, signal);
    if (!before.canUpdateMain || before.head !== expectedHead || expectedBranch !== undefined && before.branch !== expectedBranch) fail('CREATE_MAIN_CHANGED');
    const remotes = (await git(workspace, ['remote'], signal)).split('\n').filter(Boolean);
    let configured;
    try { configured = await git(workspace, ['config', '--get', `branch.${before.branch}.remote`], signal); }
    catch (error) { if (error.code !== 1) throw error; }
    const remote = configured && configured !== '.' ? configured : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
    if (!remote || !remotes.includes(remote) || remote.startsWith('-')) fail('CREATE_MAIN_REMOTE_MISSING');
    try { await git(workspace, ['fetch', '--no-tags', '--', remote, `refs/heads/${before.branch}`], signal); }
    catch (error) { if (signal?.aborted) throw error; fail('CREATE_MAIN_FETCH_FAILED', 502); }
    const fetched = await git(workspace, ['rev-parse', 'FETCH_HEAD'], signal);
    const current = await repositoryState(workspace, signal);
    if (!current.canUpdateMain || current.branch !== before.branch || current.head !== before.head) fail('CREATE_MAIN_CHANGED');
    signal?.throwIfAborted();
    try { await git(workspace, ['merge', '--ff-only', '--no-edit', fetched], signal); }
    catch (error) { if (signal?.aborted) throw error; fail('CREATE_MAIN_MERGE_FAILED'); }
    const head = await git(workspace, ['rev-parse', 'HEAD'], signal);
    return { success: true, branch: before.branch, remote, head, updated: head !== before.head };
  });
}
