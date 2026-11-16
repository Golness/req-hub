import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { safeDocumentPath } from './safe-path.js';
import { larkCliError } from './lark-errors.js';

const TOKEN = /^[A-Za-z0-9]{1,256}$/;
const SPACE = /^[0-9]{1,30}$/;
const MAX_CONTENT_BYTES = 2000000;
const MAX_TOTAL_BYTES = 8000000;
const MAX_SEGMENTS = 8;
const MAX_NAME_LENGTH = 255;
const MAX_DOCUMENTS = 40;

/**
 * Throw a stable, credential-free Lark error code.
 * @param code - Public LARK_* code.
 * @param details - Optional bounded diagnostic fields.
 * @returns Never returns.
 */
function fail(code, details) {
  const error = new Error(code);
  if (details) {
    error.details = details;
  }
  throw error;
}

/**
 * Validate one remote path segment without allowing host-side traversal.
 * @param value - Folder, requirement directory or Markdown file name.
 * @returns The unchanged segment.
 */
function segment(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.length > MAX_NAME_LENGTH ||
    /[\\/\r\n\x00]/.test(value)
  ) {
    fail('LARK_SYNC_PATH_INVALID');
  }
  return value;
}

/** Publish Markdown under a stable `.md` name. */
function documentName(value) {
  const name = segment(value);
  return /\.(md|markdown)$/i.test(name) ? name : name.replace(/\.[^.]+$/, '') + '.md';
}

/** Reject empty or oversized bodies before any remote call. */
function documentContent(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BYTES
  ) {
    fail('LARK_SYNC_CONTENT_INVALID');
  }
  return value;
}

/**
 * Resolve one workspace binding and build an authenticated, directory-cached
 * publisher. A batch shares one identity check and one listing per parent, so
 * pushing a whole Wiki release does not repeat the same remote lookups.
 * @param input - Registry, saved config, CLI settings, runner and cancellation.
 * @returns A publisher exposing publish(documents).
 */
export async function createLarkDocumentPublisher({
  registry,
  config,
  settings,
  workspaceId,
  execute,
  signal = new AbortController().signal,
}) {
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256) {
    fail('LARK_WORKSPACE_INVALID');
  }
  const workspace = registry.list().find((item) => item.id === workspaceId);
  if (!workspace) {
    fail('LARK_WORKSPACE_INVALID');
  }
  const root = await realpath(workspace.path);
  const binding = config?.larkTargets?.[workspaceId];
  if (!binding || binding.workspaceRoot !== root) {
    fail('LARK_TARGET_NOT_BOUND');
  }
  if (!['folder', 'wiki'].includes(binding.kind) || !TOKEN.test(binding.token || '')) {
    fail('LARK_TARGET_INVALID');
  }
  if (binding.kind === 'wiki' && !SPACE.test(binding.spaceId || '')) {
    fail('LARK_TARGET_INVALID');
  }

  const prefix = settings.profile ? ['--profile', settings.profile] : [];
  const call = async (args, input) => {
    let result;
    try {
      result = JSON.parse(await execute(settings, [...prefix, ...args], signal, input));
    } catch (error) {
      if (/^LARK_[A-Z_]+$/.test(error.message)) {
        throw error;
      }
      fail('LARK_RESPONSE_INVALID');
    }
    if (result?.ok === false) {
      throw larkCliError(result, settings.identity);
    }
    return result?.data || result;
  };
  let authenticated = false;
  const ensureAuth = async () => {
    if (authenticated) {
      return;
    }
    signal.throwIfAborted();
    const auth = await call(['auth', 'status', '--json', '--verify']);
    const identity = auth?.identities?.[settings.identity];
    if (!identity?.available || identity.verified !== true || typeof auth.appId !== 'string') {
      fail('LARK_AUTH_UNVERIFIED');
    }
    authenticated = true;
  };

  const listingCache = new Map();
  const directoryCache = new Map();
  /** List every direct child under a parent, following all pages. */
  const list = async (token) => {
    if (listingCache.has(token)) {
      return listingCache.get(token);
    }
    const items = [];
    const cursors = new Set();
    let pageToken = '';
    do {
      signal.throwIfAborted();
      const field = binding.kind === 'folder' ? 'files' : 'nodes';
      const args =
        binding.kind === 'folder'
          ? ['drive', 'files', 'list', '--folder-token', token, '--page-size', '200']
          : [
              'wiki',
              '+node-list',
              '--space-id',
              binding.spaceId,
              '--parent-node-token',
              token,
              '--page-size',
              '50',
            ];
      if (pageToken) {
        args.push('--page-token', pageToken);
      }
      args.push('--as', settings.identity, '--format', 'json');
      const data = await call(args);
      if (!Array.isArray(data?.[field])) {
        fail('LARK_RESPONSE_INVALID');
      }
      for (const item of data[field]) {
        const title = binding.kind === 'folder' ? item?.name : item?.title;
        const child = binding.kind === 'folder' ? item?.token : item?.node_token;
        if (typeof title !== 'string' || !title || !TOKEN.test(child || '')) {
          continue;
        }
        const isFolder =
          binding.kind === 'folder' ? item?.type === 'folder' : item?.obj_type !== 'file';
        const fileToken =
          binding.kind === 'folder' || !TOKEN.test(item?.obj_token || '') ? child : item.obj_token;
        items.push({ title, token: child, fileToken, isFolder });
      }
      pageToken = data.has_more === true ? data.page_token : '';
      if (
        pageToken &&
        (typeof pageToken !== 'string' || pageToken.length > 4096 || cursors.has(pageToken))
      ) {
        fail('LARK_RESPONSE_INVALID');
      }
      if (pageToken) {
        cursors.add(pageToken);
      }
    } while (pageToken);
    listingCache.set(token, items);
    return items;
  };

  const ensureDirectory = async (parent, title, key) => {
    if (directoryCache.has(key)) {
      return { token: directoryCache.get(key), created: false };
    }
    const matches = (await list(parent.token)).filter(
      (item) => item.isFolder && item.title === title,
    );
    if (matches.length > 1) {
      fail('LARK_SYNC_NAME_AMBIGUOUS', { title });
    }
    let token;
    let created = false;
    if (matches.length === 1) {
      token = matches[0].token;
    } else {
      signal.throwIfAborted();
      const data =
        binding.kind === 'folder'
          ? await call([
              'drive',
              '+create-folder',
              '--folder-token',
              parent.token,
              '--name',
              title,
              '--as',
              settings.identity,
              '--format',
              'json',
            ])
          : await call([
              'wiki',
              '+node-create',
              '--space-id',
              binding.spaceId,
              '--parent-node-token',
              parent.token,
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
      token =
        binding.kind === 'folder'
          ? data?.token || data?.folder_token
          : data?.node_token || data?.node?.node_token;
      if (!TOKEN.test(token || '')) {
        fail('LARK_RESPONSE_INVALID');
      }
      created = true;
    }
    directoryCache.set(key, token);
    return { token, created };
  };

  /**
   * Publish Markdown documents. Remote layout is
   * <bound parent>/<segments...>/<name>.md; every directory level is checked
   * for an exact-name match before creation, and a same-named file is
   * overwritten instead of duplicated.
   * @param documents - [{segments, name, content}].
   * @returns {results, directoriesCreated} with one result per document.
   */
  const publish = async (documents) => {
    if (!Array.isArray(documents) || !documents.length || documents.length > MAX_DOCUMENTS) {
      fail('LARK_SYNC_DOCUMENTS_INVALID');
    }
    let totalBytes = 0;
    const prepared = documents.map((document) => {
      const segments = (Array.isArray(document?.segments) ? document.segments : []).map(segment);
      if (segments.length + 1 > MAX_SEGMENTS) {
        fail('LARK_SYNC_PATH_TOO_DEEP');
      }
      const name = documentName(document?.name);
      const content = documentContent(document?.content);
      totalBytes += Buffer.byteLength(content, 'utf8');
      return { segments, name, content };
    });
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail('LARK_SYNC_CONTENT_INVALID');
    }
    await ensureAuth();
    const results = [];
    let directoriesCreated = 0;
    for (const document of prepared) {
      signal.throwIfAborted();
      let parent = { token: binding.token };
      let createdForDocument = 0;
      for (let index = 0; index < document.segments.length; index++) {
        const key = [binding.token, ...document.segments.slice(0, index + 1)].join('/');
        const next = await ensureDirectory(parent, document.segments[index], key);
        parent = { token: next.token };
        if (next.created) {
          directoriesCreated++;
          createdForDocument++;
        }
      }
      const matches = (await list(parent.token)).filter(
        (item) => !item.isFolder && item.title === document.name,
      );
      if (matches.length > 1) {
        fail('LARK_SYNC_NAME_AMBIGUOUS', { title: document.name });
      }
      const existing = matches[0];
      signal.throwIfAborted();
      const parentFlag = binding.kind === 'folder' ? '--folder-token' : '--wiki-token';
      const data = existing
        ? await call(
            [
              'markdown',
              '+overwrite',
              '--file-token',
              existing.fileToken,
              '--name',
              document.name,
              '--content',
              '-',
              '--as',
              settings.identity,
              '--format',
              'json',
            ],
            document.content,
          )
        : await call(
            [
              'markdown',
              '+create',
              parentFlag,
              parent.token,
              '--name',
              document.name,
              '--content',
              '-',
              '--as',
              settings.identity,
              '--format',
              'json',
            ],
            document.content,
          );
      const fileToken = data?.file_token || data?.token || existing?.fileToken || '';
      const url =
        typeof data?.url === 'string' && data.url.startsWith('https://') && data.url.length <= 2048
          ? data.url
          : '';
      const token = TOKEN.test(fileToken) ? fileToken : '';
      if (!existing && token) {
        // A later document in the same batch must overwrite this file rather
        // than create a duplicate with the same remote name.
        listingCache.get(parent.token)?.push({
          title: document.name,
          token,
          fileToken: token,
          isFolder: false,
        });
      }
      results.push({
        action: existing ? 'updated' : 'created',
        path: [...document.segments, document.name].join(' / '),
        name: document.name,
        url,
        fileToken: token,
        directoriesCreated: createdForDocument,
      });
    }
    return { results, directoriesCreated };
  };
  return { publish };
}

/**
 * Publish arbitrary Markdown documents (for example a compiled Wiki release)
 * into one bound workspace, reusing authentication and directory lookups.
 * @param input - Publisher input plus documents.
 * @returns {results, directoriesCreated}.
 */
export async function pushLarkDocuments(input) {
  const publisher = await createLarkDocumentPublisher(input);
  return publisher.publish(input.documents);
}

/**
 * Synchronize one saved document into the workspace's bound Lark parent.
 * The remote layout is <bound parent>/<docsDir>/<requirement dirs>/<file>.md.
 * @param input - Workspace, path, saved config, CLI settings and owned runner.
 * @returns {action, path, name, url, fileToken, directoriesCreated}.
 */
export async function syncLarkFile({
  registry,
  config,
  settings,
  workspaceId,
  path,
  execute,
  signal,
}) {
  // Read the saved file from disk instead of trusting a client-supplied body.
  const docsDir = typeof config?.docsDir === 'string' && config.docsDir ? config.docsDir : 'docs';
  const workspace = registry.list().find((item) => item.id === workspaceId);
  if (!workspace) {
    fail('LARK_WORKSPACE_INVALID');
  }
  const docsRoot = resolve(workspace.path, docsDir);
  if (typeof path !== 'string' || !path) {
    fail('LARK_SYNC_PATH_INVALID');
  }
  if (docsRoot !== resolve(workspace.path)) {
    await safeDocumentPath(workspace.path, docsDir);
  }
  let fullPath;
  try {
    fullPath = await safeDocumentPath(docsRoot, path);
  } catch {
    fail('LARK_SYNC_PATH_INVALID');
  }
  const rel = relative(docsRoot, fullPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    fail('LARK_SYNC_PATH_INVALID');
  }
  let text;
  try {
    const info = await stat(fullPath);
    if (!info.isFile() || info.size > MAX_CONTENT_BYTES) {
      fail('LARK_SYNC_CONTENT_INVALID');
    }
    text = await readFile(fullPath, 'utf8');
  } catch (error) {
    if (/^LARK_[A-Z_]+$/.test(error.message)) {
      throw error;
    }
    fail('LARK_SYNC_READ_FAILED');
  }
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const localName = parts.pop() || '';
  const segments = [...docsDir.split(/[\\/]/).filter(Boolean), ...parts].map(segment);
  const name = documentName(localName);
  const { results, directoriesCreated } = await pushLarkDocuments({
    registry,
    config,
    settings,
    workspaceId,
    execute,
    signal,
    documents: [{ segments, name, content: text }],
  });
  return { ...results[0], directoriesCreated };
}
