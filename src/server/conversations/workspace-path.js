import { posix, win32 } from 'node:path';

/**
 * Compare workspace identities by absolute path, never by their display names.
 * @param value - The input value to validate or encode.
 * @returns A normalized path key, or null for an invalid or relative path.
 */
export function workspacePathKey(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  const path = value.replace(/^\\\\\?\\/, '');
  if (
    win32.isAbsolute(path) &&
    (/^[a-z]:/i.test(path) || path.startsWith('\\\\') || path.startsWith('//'))
  ) {
    return win32
      .normalize(path)
      .replace(/[\\/]+$/, '')
      .replaceAll('\\', '/')
      .toLowerCase();
  }
  return posix.isAbsolute(path) ? posix.normalize(path).replace(/\/+$/, '') || '/' : null;
}

/**
 * Match a source workspace against its known absolute paths.
 * @param origin - Source workspace metadata and known paths.
 * @param path - Path resolved within the owning scope.
 * @returns Whether any recorded path identifies the workspace.
 */
export function matchesWorkspacePath(origin, path) {
  const key = workspacePathKey(path);
  return (
    !!key &&
    (origin.paths?.length ? origin.paths : [origin.path]).some(
      (value) => workspacePathKey(value) === key,
    )
  );
}
