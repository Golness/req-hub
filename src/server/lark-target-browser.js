import { larkTargetCaller } from './lark-target.js';

/**
 * Read one page of direct children without flattening or recursively crawling a tree.
 * @param settings - Saved CLI connection and explicit user or bot identity.
 * @param input - Folder/Wiki type, parent token, space ID and upstream page cursor.
 * @param execute - Owned CLI runner with cancellation and output limits.
 * @param signal - Operation cancellation.
 * @returns Direct selectable children and the untouched next-page cursor.
 */
export async function listLarkTargets(settings, input, execute, signal) {
  const { type, spaceId = '', parentToken = '', pageToken = '' } = input;
  if (
    !['folder', 'wiki'].includes(type) ||
    typeof spaceId !== 'string' ||
    !/^[0-9]{0,30}$/.test(spaceId) ||
    typeof parentToken !== 'string' ||
    !/^[A-Za-z0-9]{0,256}$/.test(parentToken) ||
    typeof pageToken !== 'string' ||
    pageToken.length > 4096 ||
    /[\r\n\x00]/.test(pageToken) ||
    (type === 'folder' && spaceId) ||
    (type === 'wiki' && parentToken && !spaceId)
  ) {
    throw new Error('LARK_TARGET_INVALID');
  }
  const call = larkTargetCaller(settings, execute, signal);
  let args;
  let field;
  if (type === 'folder') {
    args = [
      'drive',
      'files',
      'list',
      '--page-size',
      '50',
      ...(parentToken ? ['--folder-token', parentToken] : []),
    ];
    field = 'files';
  } else if (!spaceId) {
    args = ['wiki', '+space-list', '--page-size', '50'];
    field = 'spaces';
  } else {
    args = [
      'wiki',
      '+node-list',
      '--space-id',
      spaceId,
      '--page-size',
      '50',
      ...(parentToken ? ['--parent-node-token', parentToken] : []),
    ];
    field = 'nodes';
  }
  if (pageToken) {
    args.push('--page-token', pageToken);
  }
  args.push('--as', settings.identity, '--format', 'json');
  const data = await call(args);
  if (
    !Array.isArray(data?.[field]) ||
    (data.has_more !== undefined && typeof data.has_more !== 'boolean') ||
    (data.has_more &&
      (typeof data.page_token !== 'string' || !data.page_token || data.page_token === pageToken))
  ) {
    throw new Error('LARK_RESPONSE_INVALID');
  }
  const source =
    field === 'files' ? data.files.filter((item) => item.type === 'folder') : data[field];
  const items = source.map((item) => {
    const kind = field === 'spaces' ? 'space' : type;
    let token = item.token;
    if (field === 'spaces') {
      token = item.space_id;
    } else if (field === 'nodes') {
      token = item.node_token;
    }
    const title = field === 'nodes' ? item.title : item.name;
    if (
      typeof token !== 'string' ||
      !/^[A-Za-z0-9]{1,256}$/.test(token) ||
      typeof title !== 'string' ||
      !title ||
      title.length > 1024 ||
      (kind === 'space' && !/^[0-9]{1,30}$/.test(token))
    ) {
      throw new Error('LARK_RESPONSE_INVALID');
    }
    return { kind, token, title, spaceId: kind === 'space' ? token : spaceId };
  });
  return {
    items,
    hasMore: data.has_more === true,
    pageToken: data.has_more ? data.page_token : '',
  };
}
