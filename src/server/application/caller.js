import { realpath } from 'node:fs/promises';
import { matchesWorkspacePath } from '../conversations/workspace-path.js';

/**
 * Validate a caller's actual Agent scope against the registered workspace, never request IDs.
 * @param caller - Trusted adapter context carrying the actual Agent and signal.
 * @param workspace - Workspace entity obtained from the Host registry.
 * @returns Completion after both filesystem identities match; failures deny access.
 */
export async function assertWorkspaceCaller(caller, workspace) {
  caller.signal?.throwIfAborted();
  const cwd = caller.agent?.session?.header?.cwd;
  if (!cwd || !workspace?.path) {
    throw Object.assign(new Error('CALLER_WORKSPACE_MISMATCH'), { status: 403 });
  }
  let origin;
  let target;
  try {
    [origin, target] = await Promise.all([realpath(cwd), realpath(workspace.path)]);
  } catch (cause) {
    caller.signal?.throwIfAborted();
    throw Object.assign(new Error('CALLER_WORKSPACE_MISMATCH'), { status: 403, cause });
  }
  caller.signal?.throwIfAborted();
  if (!matchesWorkspacePath({ path: origin }, target)) {
    throw Object.assign(new Error('CALLER_WORKSPACE_MISMATCH'), { status: 403 });
  }
}
