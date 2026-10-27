import { posix, win32 } from 'node:path';

/** Compare workspace identities by absolute path, never by their display names. */
export function workspacePathKey(value) {
  if (typeof value !== 'string' || !value) return null;
  const path = value.replace(/^\\\\\?\\/, '');
  if (win32.isAbsolute(path) && (/^[a-z]:/i.test(path) || path.startsWith('\\\\') || path.startsWith('//'))) {
    return win32.normalize(path).replace(/[\\/]+$/, '').replaceAll('\\', '/').toLowerCase();
  }
  return posix.isAbsolute(path) ? posix.normalize(path).replace(/\/+$/, '') || '/' : null;
}

export function matchesWorkspacePath(origin, path) {
  const key = workspacePathKey(path);
  return !!key && (origin.paths?.length ? origin.paths : [origin.path]).some(value => workspacePathKey(value) === key);
}
