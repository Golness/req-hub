import { readdir, lstat, realpath, rm, rmdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';

const within = (root, path) => { const rel = relative(root, path); return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'); };

/** Only execution folders under sync-logs/v2 are disposable; published documents live outside it. */
export async function planSyncTaskCleanup(requirementPath, task, protectedAttempts = () => []) {
  const match = /^v2\/([\w.-]+)\/([\w-]+)$/.exec(task.snapshotDir || '');
  if (!match || match[1] !== task.id || ['.','..'].includes(match[1])) throw new Error('SYNC_DELETE_PATH_INVALID');
  const reqRoot = await realpath(requirementPath), root = resolve(reqRoot, 'sync-logs', 'v2'), parent = resolve(root, match[1]);
  if (!within(root, parent)) throw new Error('SYNC_DELETE_PATH_INVALID');
  for (const path of [join(reqRoot,'sync-logs'), root, parent]) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('SYNC_DELETE_SYMLINK'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  const children = await readdir(parent, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  // Capture the list before releasing the execution slot. A subsequent retry gets a new UUID directory.
  const targets = children.filter(entry => /^[a-f0-9-]{36}$/.test(entry.name)).map(entry => resolve(parent, entry.name));
  const selected = resolve(parent, match[2]);
  if (!targets.includes(selected)) targets.push(selected);
  return async () => {
    for (const target of targets) {
      if (!within(parent,target)) throw new Error('SYNC_DELETE_PATH_INVALID');
      const rel = 'v2/' + relative(root,target).replaceAll('\\','/');
      if (protectedAttempts().includes(rel)) continue;
      try {
        // Revalidate parent and target at deletion time, including delayed cleanup retries.
        if ((await lstat(parent)).isSymbolicLink()) throw new Error('SYNC_DELETE_SYMLINK');
        const canonicalRoot = await realpath(root), canonicalParent = await realpath(parent);
        const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
        if (normalize(canonicalRoot) !== normalize(root) || !within(canonicalRoot, canonicalParent)) throw new Error('SYNC_DELETE_PATH_INVALID');
        const actual = await realpath(target);
        if (!within(canonicalParent, actual)) throw new Error('SYNC_DELETE_PATH_INVALID');
        await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Never recursively remove the shared parent; a new attempt may already be using it.
    await rmdir(parent).catch(error => { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error; });
  };
}
