'use strict';
const { ROUTE } = require('../constants.js');

const paths = Object.freeze(
  Object.fromEntries(
    [
      'config',
      'create-status',
      'update-main',
      'create-dir',
      'tree',
      'git-branch',
      'session-info',
      'session-turns',
      'sessions',
      'file-tree',
      'read',
      'write',
      'workspaces',
      'prompt-registry',
      'llm-config',
      'skills',
      'skill-content',
      'logs',
      'logs/meta',
      'logs/clear',
      'stats',
      'open-in-explorer',
      'task-reports',
      'sync-active',
      'sync-branch-info',
      'sync-branches',
      'sync-reference-files',
      'sync-design-references',
      'sync-history',
      'sync-detail',
      'sync-overview',
      'sync-file',
      'sync-commits',
      'sync-abort',
      'sync-storage',
      'sync-delete',
      'sync-retry',
      'sync-version-diff',
      'quick-sync-status',
      'phased-sync',
      'writing/options',
      'writing/knowledge',
      'lark/file-sync',
      'conversations-refresh',
    ].map((name) => [name, '/' + name]),
  ),
);

const namespaces = Object.freeze({
  'knowledge-v2': '/knowledge-v2',
  'knowledge/enhancements': '/knowledge/enhancements',
  writing: '/writing',
  writingAssets: '/writing/assets',
  codex: '/codex',
  conversations: '/conversations-',
  lark: '/lark',
  larkTarget: '/lark/target-',
});

/**
 * Encode a named Host endpoint. Views supply parameters, never an origin or arbitrary URL.
 * @param name - Fixed endpoint or namespace name.
 * @param query - Optional parameter record, URLSearchParams or already encoded query.
 * @param suffix - Namespace-local operation or resource ID, optionally carrying a query.
 * @returns A same-origin ReqHub URL suitable for requests and isolated file previews.
 */
function endpoint(name, query, suffix = '') {
  let path = Object.hasOwn(paths, name) ? paths[name] : undefined;
  let embedded;
  if (!path) {
    const prefix = Object.hasOwn(namespaces, name) ? namespaces[name] : undefined;
    if (!prefix || typeof suffix !== 'string') {
      throw new Error('API_ENDPOINT_INVALID');
    }
    const index = suffix.indexOf('?');
    const tail = index === -1 ? suffix : suffix.slice(0, index);
    embedded = index === -1 ? undefined : suffix.slice(index + 1);
    if (!/^\/?[a-zA-Z0-9_./-]*$/.test(tail) || tail.includes('..')) {
      throw new Error('API_ENDPOINT_INVALID');
    }
    path = prefix + (prefix.endsWith('-') || !tail ? '' : '/') + tail.replace(/^\//, '');
  }
  const encode = (value) => {
    if (typeof value === 'string') {
      return value.replace(/^[?&]/, '');
    }
    if (value instanceof URLSearchParams) {
      return value.toString();
    }
    return new URLSearchParams(
      Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null),
    ).toString();
  };
  const parts = [embedded, query].filter((value) => value !== undefined && value !== null);
  if (embedded !== undefined && query && typeof query === 'object') {
    const parameters = new URLSearchParams(embedded);
    for (const [key, value] of new URLSearchParams(encode(query))) {
      parameters.set(key, value);
    }
    return ROUTE + path + '?' + parameters;
  }
  return ROUTE + path + (parts.length ? '?' + parts.map(encode).filter(Boolean).join('&') : '');
}

/** @param value - A request URL. @returns Whether it belongs to a declared ReqHub endpoint. */
function isEndpoint(value) {
  if (typeof value !== 'string' || !value.startsWith(ROUTE + '/')) {
    return false;
  }
  const path = value.slice(ROUTE.length).split('?')[0];
  if (/[\\#]/.test(value) || /%(?:2e|2f|5c)/i.test(path) || path.includes('..')) {
    return false;
  }
  return (
    Object.values(paths).includes(path) ||
    Object.values(namespaces).some(
      (prefix) => path.startsWith(prefix.endsWith('-') ? prefix : prefix + '/') || path === prefix,
    )
  );
}

module.exports = { endpoint, isEndpoint };
