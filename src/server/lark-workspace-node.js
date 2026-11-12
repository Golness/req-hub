import { listLarkTargets } from './lark-target-browser.js';
import { inspectLarkTarget, larkTargetCaller } from './lark-target.js';

/**
 * Reuse or create one workspace-named root page in an explicitly selected Wiki space.
 * @param settings - Saved CLI settings and explicit identity.
 * @param spaceId - Selected knowledge space ID; never inferred from a title.
 * @param title - Workspace name resolved by the Host registry.
 * @param execute - Owned, bounded CLI runner.
 * @param signal - Cancellation, checked before every remote action.
 * @param beforeCreate - Revalidate workspace and configuration before the remote write.
 * @returns Verified target and whether this operation created the remote node.
 */
export async function ensureLarkWorkspaceNode(
  settings,
  spaceId,
  title,
  execute,
  signal,
  beforeCreate,
) {
  if (
    typeof spaceId !== 'string' ||
    !/^[0-9]{1,30}$/.test(spaceId) ||
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > 1024
  ) {
    throw new Error('LARK_TARGET_INVALID');
  }
  const call = larkTargetCaller(settings, execute, signal);
  signal.throwIfAborted();
  const auth = await call(['auth', 'status', '--json', '--verify']);
  const identity = auth?.identities?.[settings.identity];
  if (!identity?.available || identity.verified !== true || typeof auth.appId !== 'string') {
    throw new Error('LARK_AUTH_UNVERIFIED');
  }
  const matches = new Map();
  const cursors = new Set();
  let pageToken = '';
  do {
    signal.throwIfAborted();
    const page = await listLarkTargets(
      settings,
      { type: 'wiki', spaceId, pageToken },
      execute,
      signal,
    );
    for (const item of page.items) {
      if (item.title === title) {
        matches.set(item.token, item);
      }
    }
    if (matches.size > 1) {
      throw new Error('LARK_WIKI_NAME_AMBIGUOUS');
    }
    pageToken = page.hasMore ? page.pageToken : '';
    if (pageToken && cursors.has(pageToken)) {
      throw new Error('LARK_RESPONSE_INVALID');
    }
    cursors.add(pageToken);
  } while (pageToken);

  let selected = matches.values().next().value;
  let created = false;
  let writeAttempted = false;
  try {
    if (!selected) {
      await beforeCreate();
      signal.throwIfAborted();
      writeAttempted = true;
      const node = await call([
        'wiki',
        '+node-create',
        '--space-id',
        spaceId,
        '--title',
        title,
        '--node-type',
        'origin',
        '--obj-type',
        'docx',
        '--as',
        settings.identity,
        '--format',
        'json',
      ]);
      if (typeof node?.node_token !== 'string' || !/^[A-Za-z0-9]{1,256}$/.test(node.node_token)) {
        throw new Error('LARK_RESPONSE_INVALID');
      }
      selected = { kind: 'wiki', token: node.node_token, spaceId };
      created = true;
    }
    signal.throwIfAborted();
    const target = await inspectLarkTarget(
      settings,
      { ...selected, rootTitle: title },
      execute,
      signal,
    );
    return { target: { ...target, useDefault: true }, created };
  } catch (error) {
    if (writeAttempted) {
      error.details = { ...error.details, remoteChangePossible: true };
    }
    throw error;
  }
}
