import { lstat, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/**
 * Explicit retirement, never an import or format compatibility layer.
 * @param globalHome - Global plugin storage home.
 * @returns Completion after retirement cleanup.
 */
export async function removeRetiredCodexStore(globalHome) {
  const base = resolve(globalHome, 'req-hub');
  const target = resolve(base, 'codex');
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error('RETIRED_STORE_SYMLINK');
    }
    const actualBase = await realpath(base);
    const actual = await realpath(target);
    const normalize = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);
    if (normalize(actual) !== normalize(join(actualBase, 'codex'))) {
      throw new Error('RETIRED_STORE_PATH');
    }
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}
