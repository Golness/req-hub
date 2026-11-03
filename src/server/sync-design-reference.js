import { open, readdir, realpath } from 'node:fs/promises';
import { extname, relative } from 'node:path';
import { safeDocumentPath } from './safe-path.js';
import { hashBytes } from './sync-artifacts.js';
import { BINARY_EXTENSIONS, MAX_BINARY_BYTES, parseBinary } from './knowledge/binary-parser.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function failure(code, status = 400) {
  return Object.assign(new Error(code), { status });
}

/**
 * List regular files within one authorized requirement directory, without following links.
 * @param root - Host-resolved requirement directory.
 * @param query - Case-insensitive relative-path filter.
 * @returns All matching paths; oversized inventories fail explicitly.
 */
export async function listDesignReferences(root, query = '') {
  const files = [];
  let entriesRead = 0;
  const visit = async (directory = '') => {
    const path = directory ? await safeDocumentPath(root, directory) : root;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entriesRead > 10000) {
        throw failure('SYNC_REFERENCE_LIST_TOO_LARGE', 413);
      }
      const name = directory ? directory + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        await visit(name);
      } else if (entry.isFile()) {
        await safeDocumentPath(root, name);
        files.push(name);
      }
    }
  };
  await visit();
  const matches = files.filter((path) => path.toLowerCase().includes(query.toLowerCase())).sort();
  if (Buffer.byteLength(JSON.stringify(matches)) > 1024 * 1024) {
    throw failure('SYNC_REFERENCE_LIST_TOO_LARGE', 413);
  }
  return matches;
}

/**
 * Freeze exact published requirement bytes for the quick-sync continuation.
 * @param bytes - Successfully published requirement content.
 * @param syncId - Optional originating document attempt.
 * @returns Immutable reference content and source identity for technical analysis.
 */
export function publishedRequirementReference(bytes, syncId) {
  return {
    path: 'requirement.md',
    sourceHash: hashBytes(bytes),
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ...(syncId ? { syncId } : {}),
  };
}

/**
 * Freeze a selected file after checking its scope, size and encoding.
 * @param root - Host-resolved requirement directory.
 * @param path - Explicitly selected path relative to that directory.
 * @param signal - Cancellation shared with the owning sync sequence.
 * @returns Full reference text and its original byte hash; no truncation is permitted.
 */
export async function freezeDesignReference(root, path, signal) {
  signal?.throwIfAborted();
  let target;
  try {
    const base = await realpath(root);
    target = await realpath(await safeDocumentPath(base, path));
    await safeDocumentPath(base, relative(base, target));
  } catch {
    throw failure('SYNC_REFERENCE_INVALID');
  }
  const extension = extname(path).toLowerCase();
  const binary = BINARY_EXTENSIONS.has(extension);
  const limit = binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES;
  const file = await open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw failure('SYNC_REFERENCE_INVALID');
    }
    if (stat.size > limit) {
      throw failure('SYNC_REFERENCE_TOO_LARGE', 413);
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== stat.size) {
      throw failure('SYNC_REFERENCE_CHANGED', 409);
    }
    const after = await file.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw failure('SYNC_REFERENCE_CHANGED', 409);
    }
    const bytes = buffer.subarray(0, offset);
    let text;
    if (binary) {
      text = (await parseBinary(bytes, extension, { signal })).text;
    } else {
      try {
        if (bytes.includes(0)) {
          throw new Error('BINARY_CONTENT');
        }
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw failure('SYNC_REFERENCE_UNSUPPORTED');
      }
    }
    signal?.throwIfAborted();
    return { path: path.replaceAll('\\', '/'), sourceHash: hashBytes(bytes), text };
  } finally {
    await file.close();
  }
}
