import { msg, messageDescriptor } from './messages.js';
import { open, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { BINARY_EXTENSIONS, MAX_BINARY_BYTES, parseBinary } from './binary-parser.js';

export const SUPPORTED_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.text',
  '.html',
  '.htm',
  '.json',
  ...BINARY_EXTENSIONS,
]);
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_BUILD_FILES = 200;

/** Hash input for stable content identity. */
export const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Create a source error with its HTTP status, preserving message params. */
export const knowledgeError = (message, status = 400) => {
  const descriptor = messageDescriptor(message);
  const code = typeof descriptor === 'string' ? descriptor : descriptor.code;
  const error = new Error(code);
  error.messageCode = code;
  if (typeof descriptor === 'object') {
    error.params = descriptor.params;
  }
  return Object.assign(error, { status });
};

/** Validate and normalize a relative requirement-document path. */
export function normalizeSourcePath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) {
    throw knowledgeError('DOC_SOURCE_PATH_INVALID');
  }
  const path = value.replaceAll('\\', '/');
  const parts = path.split('/');
  if (
    isAbsolute(path) ||
    /^[a-z]:/i.test(path) ||
    parts.some((p) => !p || p === '.' || p === '..' || p.includes(':'))
  ) {
    throw knowledgeError('DOC_SOURCE_PATH_OUT_OF_BOUNDS');
  }
  if (
    parts.length < 3 ||
    parts[0].startsWith('.') ||
    !/^\d{4}-\d{2}-\d{2}-.+/.test(parts[1]) ||
    parts.slice(2, -1).some((p) => p.startsWith('.'))
  ) {
    throw knowledgeError('DOC_SOURCE_NOT_IN_REQUIREMENT_DIR');
  }
  if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw knowledgeError('DOC_SOURCE_UNSUPPORTED_FILE_TYPE');
  }
  return path;
}

/** Check a normalized path against its allowed root without resolving symlinks. */
export function inside(root, path) {
  const rel = relative(root, path);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(rel)
  );
}

/** Read a bounded source after checking its actual filesystem location. */
export async function readSource(docsRoot, input, { metadataOnly = false, signal } = {}) {
  signal?.throwIfAborted();
  const relativePath = normalizeSourcePath(input);
  const extension = extname(relativePath).toLowerCase();
  const binary = BINARY_EXTENSIONS.has(extension);
  const limit = binary ? MAX_BINARY_BYTES : MAX_FILE_BYTES;
  const oversized = () =>
    knowledgeError(msg('DOC_SOURCE_FILE_TOO_LARGE', { v0: binary ? 20 : 2 }), 413);
  const root = await realpath(docsRoot);
  const path = await realpath(resolve(root, relativePath));
  if (!inside(root, path)) {
    throw knowledgeError('DOC_SOURCE_PATH_OUT_OF_BOUNDS');
  }
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw knowledgeError('DOC_SOURCE_NOT_A_FILE');
    }
    if (stat.size > limit) {
      throw oversized();
    }
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    if (offset > limit) {
      throw oversized();
    }
    if (offset === buffer.length) {
      throw knowledgeError('DOC_SOURCE_SIZE_CHANGED_DURING_READ', 409);
    }
    const bytes = buffer.subarray(0, offset);
    const metadata = { relativePath, contentHash: hash(bytes), mtime: stat.mtime.toISOString() };
    if (metadataOnly) {
      return metadata;
    }
    if (binary) {
      return { ...metadata, ...(await parseBinary(bytes, extension, { signal })) };
    }
    if (bytes.includes(0)) {
      throw knowledgeError('DOC_SOURCE_BINARY_CONTENT');
    }
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let text = raw;
    if (/\.html?$/i.test(relativePath)) {
      text = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/(?:p|div|h[1-6]|li|tr|section)>/gi, '\n')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
          const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
          return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : '';
        })
        .replace(
          /&(nbsp|lt|gt|amp|quot|apos);/g,
          (_, name) => ({ nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[name],
        );
    } else if (/\.json$/i.test(relativePath)) {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    }
    return {
      ...metadata,
      coordinate: /\.(html?|json)$/i.test(relativePath) ? 'extracted' : 'source',
      text,
    };
  } finally {
    await file.close();
  }
}
