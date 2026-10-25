import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, win32 } from 'node:path';

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Reject escapes, including dangling links and junctions, before file operations. */
export async function safeDocumentPath(root, input, { allowMissing = false } = {}) {
  if (typeof input !== 'string' || !input || input.includes('\0') || isAbsolute(input) || win32.isAbsolute(input)
    || input.split(/[\\/]/).includes('..') || input.includes(':')) throw Object.assign(new Error('path outside docs root'), { status: 403 });
  const base = resolve(root), target = resolve(base, input.replace(/[\\/]/g, '/'));
  const deny = () => { throw Object.assign(new Error('path outside docs root'), { status: 403 }); };
  if (!inside(base, target) || base === target) deny();
  let baseAncestor = base;
  let actualBase;
  while (!actualBase) {
    try { actualBase = resolve(await realpath(baseAncestor), relative(baseAncestor, base)); }
    catch (error) { if (error.code !== 'ENOENT' || !allowMissing || dirname(baseAncestor) === baseAncestor) throw error; await rejectDangling(baseAncestor); baseAncestor = dirname(baseAncestor); }
  }
  let ancestor = target;
  while (true) {
    try {
      // lstat distinguishes missing paths from dangling symlinks.
      await lstat(ancestor);
      const actual = await realpath(ancestor);
      if (!inside(actualBase, actual) && !(allowMissing && inside(actual, actualBase) && ancestor === baseAncestor)) deny();
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing || ancestor === baseAncestor) throw error;
      try { if ((await lstat(ancestor)).isSymbolicLink()) deny(); } catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
      ancestor = dirname(ancestor);
    }
  }
  return target;
}

async function rejectDangling(path) {
  try { if ((await lstat(path)).isSymbolicLink()) throw Object.assign(new Error('path outside docs root'), { status: 403 }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
