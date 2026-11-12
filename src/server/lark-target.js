import { createHash } from 'node:crypto';
import { larkCliError } from './lark-errors.js';

/**
 * Parse a publication parent without fetching a user-provided host.
 * @param value - Official folder or Wiki node URL.
 * @returns The canonical URL, parent type and case-sensitive token.
 */
export function parseLarkTarget(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) {
      throw new Error();
    }
    const url = new URL(value.trim());
    const official = ['feishu.cn', 'larksuite.com', 'larkoffice.com', 'doubao.com'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith('.' + domain),
    );
    const match = url.pathname.match(/^\/(wiki|(?:drive\/)?folder)\/([A-Za-z0-9]+)\/?$/);
    if (
      !official ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !match ||
      match[2].length > 256
    ) {
      throw new Error();
    }
    return {
      kind: match[1] === 'wiki' ? 'wiki' : 'folder',
      token: match[2],
      url: url.origin + url.pathname.replace(/\/$/, ''),
    };
  } catch {
    throw new Error('LARK_TARGET_INVALID');
  }
}

/**
 * Identify one saved binding for optimistic configuration updates.
 * @param binding - Existing binding, if any.
 * @returns A content revision or null for an unbound workspace.
 */
export function larkTargetRevision(binding) {
  return binding ? createHash('sha256').update(JSON.stringify(binding)).digest('hex') : null;
}

/**
 * Read bounded CLI JSON through the operation-owned runner.
 * @param settings - Validated connection settings.
 * @param execute - Owned CLI runner.
 * @param signal - Operation cancellation.
 * @returns A caller that unwraps successful CLI responses without exposing stderr.
 */
export function larkTargetCaller(settings, execute, signal) {
  const prefix = settings.profile ? ['--profile', settings.profile] : [];
  return async (args) => {
    let result;
    try {
      result = JSON.parse(await execute(settings, [...prefix, ...args], signal));
    } catch (error) {
      if (/^LARK_[A-Z_]+$/.test(error.message)) {
        throw error;
      }
      throw new Error('LARK_RESPONSE_INVALID');
    }
    if (result?.ok === false) {
      const failure = larkCliError(result, settings.identity);
      if (failure.message === 'LARK_CHECK_FAILED') {
        failure.message = 'LARK_TARGET_ACCESS_FAILED';
      }
      throw failure;
    }
    return result?.data || result;
  };
}

/**
 * Resolve a parent under the saved CLI identity using read operations only.
 * @param settings - Validated CLI connection.
 * @param value - Parent URL or structured selection; remote metadata is always revalidated.
 * @param execute - Owned, bounded CLI process runner.
 * @param signal - Operation cancellation.
 * @returns Verified parent and account metadata; creation permission is not implied.
 */
export async function inspectLarkTarget(settings, value, execute, signal) {
  let target;
  if (typeof value === 'string') {
    target = parseLarkTarget(value);
  } else {
    if (
      !value ||
      !['folder', 'wiki'].includes(value.kind) ||
      typeof value.token !== 'string' ||
      !/^[A-Za-z0-9]{1,256}$/.test(value.token)
    ) {
      throw new Error('LARK_TARGET_INVALID');
    }
    target = { kind: value.kind, token: value.token };
  }
  const call = larkTargetCaller(settings, execute, signal);
  const auth = await call(['auth', 'status', '--json', '--verify']);
  const identity = auth?.identities?.[settings.identity];
  if (!identity?.available || identity.verified !== true || typeof auth.appId !== 'string') {
    throw new Error('LARK_AUTH_UNVERIFIED');
  }
  let metadata;
  if (target.kind === 'wiki') {
    const data = await call([
      'wiki',
      '+node-get',
      '--node-token',
      target.token,
      '--as',
      settings.identity,
      '--format',
      'json',
    ]);
    const node = data?.node || data;
    if (
      node?.node_token !== target.token ||
      typeof node.space_id !== 'string' ||
      typeof node.obj_token !== 'string' ||
      typeof node.obj_type !== 'string'
    ) {
      throw new Error('LARK_RESPONSE_INVALID');
    }
    if (
      value?.rootTitle !== undefined &&
      (node.title !== value.rootTitle || node.parent_node_token)
    ) {
      throw new Error('LARK_TARGET_CONFLICT');
    }
    if (value?.spaceId && value.spaceId !== node.space_id) {
      throw new Error('LARK_TARGET_INVALID');
    }
    if (!target.url) {
      const inspected = await call([
        'drive',
        '+inspect',
        '--url',
        target.token,
        '--type',
        'wiki',
        '--as',
        settings.identity,
        '--format',
        'json',
      ]);
      if (inspected?.wiki_node?.node_token !== target.token || typeof inspected.url !== 'string') {
        throw new Error('LARK_RESPONSE_INVALID');
      }
      const canonical = parseLarkTarget(new URL(inspected.url).origin + '/wiki/' + target.token);
      target.url = canonical.url;
    }
    metadata = {
      spaceId: node.space_id,
      objToken: node.obj_token,
      objType: node.obj_type,
      title: node.title || target.token,
    };
  } else {
    const folder = await call([
      'drive',
      '+inspect',
      '--url',
      target.token,
      '--type',
      'folder',
      '--as',
      settings.identity,
      '--format',
      'json',
    ]);
    if (folder?.type !== 'folder' || folder.token !== target.token) {
      throw new Error('LARK_RESPONSE_INVALID');
    }
    if (!target.url) {
      const canonical = parseLarkTarget(folder.url);
      if (canonical.kind !== 'folder' || canonical.token !== target.token) {
        throw new Error('LARK_RESPONSE_INVALID');
      }
      target.url = canonical.url;
    }
    // Listing one item proves readability without crawling or modifying the folder.
    const listing = await call([
      'drive',
      'files',
      'list',
      '--folder-token',
      target.token,
      '--page-size',
      '1',
      '--as',
      settings.identity,
      '--format',
      'json',
    ]);
    if (!Array.isArray(listing?.files)) {
      throw new Error('LARK_RESPONSE_INVALID');
    }
    metadata = {
      spaceId: '',
      objToken: '',
      objType: 'folder',
      title: folder.title || target.token,
    };
  }
  if (typeof metadata.title !== 'string' || metadata.title.length > 1024) {
    throw new Error('LARK_RESPONSE_INVALID');
  }
  return {
    ...target,
    ...metadata,
    appId: auth.appId,
    accountId: identity.openId || auth.appId,
    profile: settings.profile,
    identity: settings.identity,
    checkedAt: new Date().toISOString(),
  };
}
