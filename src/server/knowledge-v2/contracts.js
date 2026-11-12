import { createHash } from 'node:crypto';

/** File-backed knowledge schema; JSON holds manifests only, Markdown is the content truth. */
export const SCHEMA_VERSION = 1;
export const NORMALIZER_VERSION = 'kb-text-v1';
export const COMPILER_VERSION = 'kb-compile-v1';

export const SUPPORTED_EXTENSIONS = ['.md', '.markdown', '.txt', '.text', '.html', '.htm'];
export const PAGE_TYPES = ['source', 'entity', 'concept', 'topic'];

export const LIMITS = {
  sourceBytes: 2 * 1024 * 1024,
  batchFiles: 100,
  scopeSources: 500,
  scopeRawBytes: 200 * 1024 * 1024,
  scopePages: 500,
  pageBytes: 64 * 1024,
  changedPages: 20,
  releaseBytes: 64 * 1024 * 1024,
  outputReserveTokens: 8000,
  retainedJobs: 100,
  jsonControlBytes: 8 * 1024 * 1024,
  searchHits: 8,
  searchNeighbors: 4,
  maxSessionsPerImport: 20,
};

const RETRYABLE = new Set([
  'KB_STORAGE_BUSY',
  'KB_MODEL_TIMEOUT',
  'KB_MODEL_UNAVAILABLE',
  'KB_PROVIDER_UNAVAILABLE',
]);

/**
 * Hash a raw string or JSON-serialized value for identity and version checks.
 * @param value - The input value to encode.
 * @returns The SHA-256 hexadecimal digest.
 */
export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

/** @returns The current time in ISO 8601 format. */
export const now = () => new Date().toISOString();

/**
 * Throw a stable domain error with structured status and details.
 * @param code - Stable KB_* domain error code.
 * @param [status] - HTTP status for the domain failure.
 * @param [details] - Structured diagnostic fields.
 * @returns Never returns.
 */
export function fail(code, status = 400, details = {}) {
  throw Object.assign(new Error(code), { code, status, details });
}

/**
 * Project any failure onto the public {code, details, retryable} contract.
 * @param error - The caught failure.
 * @returns The structured public error payload.
 */
export function publicError(error) {
  const code =
    error?.code || (/^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'KB_INTERNAL');
  return {
    code,
    details: error?.details && typeof error.details === 'object' ? error.details : {},
    retryable: RETRYABLE.has(code),
  };
}

/**
 * Reject a value whose complete JSON encoding exceeds the byte budget.
 * @param value - The input value to validate.
 * @param bytes - Maximum serialized UTF-8 bytes.
 * @returns The original value when it fits.
 */
export function bounded(value, bytes) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes) {
    fail('KB_BUDGET_EXCEEDED', 413, { limitBytes: bytes });
  }
  return value;
}

/**
 * Derive the page type from its logical path prefix.
 * @param pageId - Logical page path such as entities/order-status.
 * @returns The page type, or undefined for an unknown prefix.
 */
export function pageType(pageId) {
  const prefix = String(pageId).split('/')[0];
  return { sources: 'source', entities: 'entity', concepts: 'concept', topics: 'topic' }[prefix];
}

/** Validate a logical page path; Host-owned aggregates are not model-writable. */
export function validPageId(pageId) {
  return (
    typeof pageId === 'string' &&
    /^(sources|entities|concepts|topics)\/[a-z0-9][a-z0-9-]{0,120}$/.test(pageId) &&
    pageType(pageId) !== undefined
  );
}

/**
 * Slugify a model-proposed title into a stable logical path segment.
 * @param title - Proposed page title.
 * @returns A lowercase ASCII slug; Han titles fall back to a digest segment.
 */
export function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'p-' + digest(title).slice(0, 12);
}

/**
 * Serialize Host-owned frontmatter. Only the fixed knowledge fields are emitted.
 * @param meta - {id, type, title, sources:[{id,revision}], updatedAt}.
 * @param body - Markdown body without frontmatter.
 * @returns The complete page text.
 */
export function serializePage(meta, body) {
  const lines = [
    '---',
    `id: ${meta.id}`,
    `type: ${meta.type}`,
    `title: ${JSON.stringify(meta.title)}`,
    'sources:',
    ...meta.sources.map((source) => `  - id: ${source.id}\n    revision: ${source.revision}`),
    `updatedAt: '${meta.updatedAt}'`,
    '---',
    '',
  ];
  return lines.join('\n') + body;
}

/**
 * Parse Host-written frontmatter; unknown shapes fail instead of guessing.
 * @param text - Complete page text.
 * @returns {meta, body} with the structured frontmatter and Markdown body.
 */
export function parsePage(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    fail('KB_PAGE_FORMAT_INVALID', 500);
  }
  const meta = { sources: [] };
  let current;
  for (const line of match[1].split('\n')) {
    const scalar = /^([a-zA-Z]+): (.*)$/.exec(line);
    if (scalar) {
      const [, key, value] = scalar;
      if (key === 'title') {
        meta.title = JSON.parse(value);
      } else if (key === 'updatedAt') {
        meta.updatedAt = value.replace(/^'|'$/g, '');
      } else {
        meta[key] = value;
      }
      current = undefined;
      continue;
    }
    const item = /^  - id: (.+)$/.exec(line);
    if (item) {
      current = { id: item[1] };
      meta.sources.push(current);
      continue;
    }
    const revision = /^    revision: (.+)$/.exec(line);
    if (revision && current) {
      current.revision = revision[1];
      continue;
    }
    if (line === 'sources:') {
      continue;
    }
    fail('KB_PAGE_FORMAT_INVALID', 500, { line });
  }
  if (!meta.id || !meta.type || typeof meta.title !== 'string') {
    fail('KB_PAGE_FORMAT_INVALID', 500);
  }
  return { meta, body: text.slice(match[0].length) };
}

/**
 * Extract [[wikilink]] targets from a Markdown body.
 * @param body - Markdown text.
 * @returns Unique logical page targets in first-seen order.
 */
export function extractWikilinks(body) {
  const targets = new Set();
  for (const match of body.matchAll(/\[\[([^\[\]\n]+)\]\]/g)) {
    targets.add(match[1].trim());
  }
  return [...targets];
}
