import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const MAX_DOCUMENT_BYTES = 2000000;
const MAX_WIKI_PAGES = 40;
const GENERATION = /^[A-Za-z0-9_-]{1,128}$/;

/** Configuration problems are diagnostics, not failures of the daily run. */
export const LARK_PUSH_SKIPPED = new Set([
  'LARK_TARGET_NOT_BOUND',
  'LARK_TARGET_INVALID',
  'LARK_AUTH_UNVERIFIED',
  'LARK_CONFIG_INVALID',
  'LARK_CLI_NOT_FOUND',
  'LARK_LOGIN_REQUIRED',
]);

/**
 * Map an arbitrary failure to a stable, credential-free code and report status.
 * @param error - Failure raised by the CLI publisher.
 * @returns {code, status}.
 */
export function larkPushFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const code = /^LARK_[A-Z_]+$/.test(message)
    ? message
    : typeof error?.code === 'string' && /^LARK_[A-Z_]+$/.test(error.code)
      ? error.code
      : 'LARK_PUSH_FAILED';
  return { code, status: LARK_PUSH_SKIPPED.has(code) ? 'skipped' : 'failed' };
}

const docsSegments = (config) => {
  const docsDir = typeof config?.docsDir === 'string' && config.docsDir ? config.docsDir : 'docs';
  return docsDir.split(/[\\/]/).filter(Boolean);
};

const report = (onItem, key, item) => onItem(key, { kind: 'lark', source: 'lark', ...item });

/**
 * Push the two documents produced by a scheduled quick-sync branch.
 * Only saved, non-empty files on disk are published; the remote path mirrors
 * <docsDir>/<requirement dirs>/<name>.md, so an unchanged name is overwritten.
 * @param input - Lark service, config, workspace, requirement directory and report callback.
 * @returns Counts of published, skipped and failed documents.
 */
export async function pushSyncArtifacts({
  lark,
  config,
  workspaceId,
  docsRoot,
  directory,
  keyPrefix,
  signal,
  onItem = () => {},
}) {
  const relativeDir = relative(docsRoot, directory);
  if (!relativeDir || relativeDir.startsWith('..') || relativeDir.split(sep).includes('..')) {
    report(onItem, `lark:${keyPrefix}:path`, {
      status: 'skipped',
      reason: 'LARK_SYNC_PATH_INVALID',
    });
    return { pushed: 0, skipped: 1, failed: 0 };
  }
  const segments = [...docsSegments(config), ...relativeDir.split(/[\\/]/).filter(Boolean)];
  const documents = [];
  for (const name of ['requirement.md', 'design.md']) {
    try {
      const info = await stat(join(directory, name));
      if (!info.isFile() || !info.size || info.size > MAX_DOCUMENT_BYTES) {
        continue;
      }
      const content = await readFile(join(directory, name), 'utf8');
      if (!content.trim()) {
        continue;
      }
      documents.push({ segments, name, content });
    } catch {
      // A branch may only produce one of the two documents.
    }
  }
  if (!documents.length) {
    report(onItem, `lark:${keyPrefix}:documents`, {
      status: 'skipped',
      reason: 'LARK_PUSH_NO_DOCUMENTS',
    });
    return { pushed: 0, skipped: 1, failed: 0 };
  }
  try {
    const { results } = await lark.pushDocuments({ workspaceId, documents, signal });
    for (const result of results) {
      report(onItem, `lark:${keyPrefix}:${result.name}`, {
        status: 'completed',
        title: result.path,
        path: result.path,
        action: result.action,
        url: result.url,
        fileToken: result.fileToken,
      });
    }
    return { pushed: results.length, skipped: 0, failed: 0 };
  } catch (error) {
    const failure = larkPushFailure(error);
    report(onItem, `lark:${keyPrefix}:documents`, {
      status: failure.status,
      title: documents.map((item) => item.name).join('、'),
      ...(failure.status === 'skipped' ? { reason: failure.code } : { error: failure.code }),
    });
    return {
      pushed: 0,
      skipped: failure.status === 'skipped' ? 1 : 0,
      failed: failure.status === 'failed' ? 1 : 0,
    };
  }
}

/**
 * Collect the Markdown pages of the currently published Wiki generation.
 * @param root - releases/{generationId}/wiki directory.
 * @returns [{segments, name, content}] in a stable order.
 */
async function wikiDocuments(root, baseSegments) {
  const found = [];
  const walk = async (directory, parts) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= MAX_WIKI_PAGES) {
        return;
      }
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), [...parts, entry.name]);
      } else if (/\.(md|markdown)$/i.test(entry.name)) {
        const info = await stat(join(directory, entry.name));
        if (!info.isFile() || !info.size || info.size > MAX_DOCUMENT_BYTES) {
          continue;
        }
        const content = await readFile(join(directory, entry.name), 'utf8');
        if (!content.trim()) {
          continue;
        }
        found.push({
          segments: [...baseSegments, ...parts],
          name: entry.name,
          content,
        });
      }
    }
  };
  await walk(root, []);
  // Index and overview are the entry points; keep them first in the report.
  found.sort((a, b) => {
    const rank = (name) => (name === 'index.md' ? 0 : name === 'overview.md' ? 1 : 2);
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  });
  return found;
}

/**
 * Push the compiled Wiki release of one workspace. A compile queued by the
 * same daily run is awaited (bounded by the caller) before reading current.json.
 * @param input - Lark service, config, scope store and report callback.
 * @returns Counts plus the published generation identity.
 */
export async function pushKnowledgeArtifacts({
  lark,
  config,
  store,
  workspaceId,
  signal,
  waitForCompile = async () => {},
  onItem = () => {},
}) {
  const keyPrefix = `wiki:${workspaceId}`;
  await waitForCompile();
  let current;
  try {
    current = JSON.parse(await readFile(store.path('current.json'), 'utf8'));
  } catch {
    report(onItem, `lark:${keyPrefix}:release`, {
      status: 'skipped',
      reason: 'LARK_PUSH_NO_WIKI',
    });
    return { pushed: 0, skipped: 1, failed: 0, generationId: null };
  }
  const generationId = current?.generationId;
  if (typeof generationId !== 'string' || !GENERATION.test(generationId)) {
    report(onItem, `lark:${keyPrefix}:release`, {
      status: 'skipped',
      reason: 'LARK_PUSH_NO_WIKI',
    });
    return { pushed: 0, skipped: 1, failed: 0, generationId: null };
  }
  const baseSegments = [...docsSegments(config), 'knowledge-v2'];
  let documents;
  try {
    documents = await wikiDocuments(store.path('releases', generationId, 'wiki'), baseSegments);
  } catch {
    documents = [];
  }
  if (!documents.length) {
    report(onItem, `lark:${keyPrefix}:release`, {
      status: 'skipped',
      reason: 'LARK_PUSH_NO_WIKI',
      generationId,
    });
    return { pushed: 0, skipped: 1, failed: 0, generationId };
  }
  try {
    const { results } = await lark.pushDocuments({ workspaceId, documents, signal });
    for (const result of results) {
      report(onItem, `lark:${keyPrefix}:${result.path}`, {
        status: 'completed',
        title: result.path,
        path: result.path,
        action: result.action,
        url: result.url,
        fileToken: result.fileToken,
        generationId,
      });
    }
    return { pushed: results.length, skipped: 0, failed: 0, generationId };
  } catch (error) {
    const failure = larkPushFailure(error);
    report(onItem, `lark:${keyPrefix}:release`, {
      status: failure.status,
      title: `Wiki ${generationId}`,
      generationId,
      ...(failure.status === 'skipped' ? { reason: failure.code } : { error: failure.code }),
    });
    return {
      pushed: 0,
      skipped: failure.status === 'skipped' ? 1 : 0,
      failed: failure.status === 'failed' ? 1 : 0,
      generationId,
    };
  }
}
