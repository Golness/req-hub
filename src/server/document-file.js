import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { safeDocumentPath } from './safe-path.js';
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
/**
 * Describe the observed filesystem identity without reading file contents.
 * @param info - BigInt stat record.
 * @returns Comparable identity and version fields.
 */
export const fileFingerprint = (info) =>
  [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
const fingerprint = fileFingerprint;

/**
 * Inspect a regular source file without reading its body or imposing a content quota.
 * @param root - Authorized real root.
 * @param path - Relative source path.
 * @param signal - Read owner cancellation.
 * @returns File size, modification time and filesystem version.
 */
export async function documentMetadata(root, path, signal) {
  signal.throwIfAborted();
  if (relative(root, await realpath(root)) !== '') {
    throw failure('DOCUMENT_PATH_DENIED', 403);
  }
  const target = await safeDocumentPath(root, path);
  const info = await stat(target, { bigint: true });
  if (!info.isFile()) {
    throw failure('DOCUMENT_PATH_DENIED', 403);
  }
  await safeDocumentPath(root, path);
  signal.throwIfAborted();
  return {
    version: fingerprint(info),
    size: Number(info.size),
    mtime: new Date(Number(info.mtimeMs)).toISOString(),
  };
}

/**
 * Stream complete UTF-8 source text through bounded buffers without persisting a copy.
 * @param root - Authorized real root.
 * @param path - Relative source path.
 * @param signal - Read owner cancellation.
 * @returns Text chunks; invalid text, retargeting and concurrent edits reject.
 */
export async function* readDocumentText(root, path, signal) {
  const before = await documentMetadata(root, path, signal);
  const target = await safeDocumentPath(root, path);
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (fingerprint(opened) !== before.version) {
      throw failure('DOCUMENT_FILE_CHANGED', 409);
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const bytes of handle.createReadStream({ autoClose: false, highWaterMark: 16384 })) {
      signal.throwIfAborted();
      const text = decoder.decode(bytes, { stream: true });
      if (text) {
        yield { text, version: before.version };
      }
    }
    const tail = decoder.decode();
    if (tail) {
      yield { text: tail, version: before.version };
    }
    const after = await documentMetadata(root, path, signal);
    if (
      after.version !== before.version ||
      fingerprint(await handle.stat({ bigint: true })) !== before.version
    ) {
      throw failure('DOCUMENT_FILE_CHANGED', 409);
    }
  } finally {
    await handle.close();
  }
}
/**
 * Read one stable regular file inside an authorized docs root.
 * @param root - Validated docs root.
 * @param path - Relative file path.
 * @param maxBytes - Full original-file byte budget.
 * @param signal - Owner cancellation.
 * @returns Bytes and a filesystem fingerprint; replacement or growth rejects.
 */
export async function readReplicaFile(root, path, maxBytes, signal) {
  signal.throwIfAborted();
  if (relative(root, await realpath(root)) !== '') {
    throw failure('DOCUMENT_PATH_DENIED', 403);
  }
  const target = await safeDocumentPath(root, path);
  const observed = await stat(target, { bigint: true });
  if (!observed.isFile() || observed.size > BigInt(maxBytes)) {
    throw failure('DOCUMENT_FILE_TOO_LARGE');
  }
  const flags = constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0);
  const handle = await open(target, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) {
      throw failure('DOCUMENT_FILE_TOO_LARGE');
    }
    if (fingerprint(observed) !== fingerprint(before)) {
      throw failure('DOCUMENT_FILE_CHANGED', 409);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      total += chunk.length;
      if (total > maxBytes) {
        throw failure('DOCUMENT_FILE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
    await safeDocumentPath(root, path);
    if (relative(root, await realpath(root)) !== '') {
      throw failure('DOCUMENT_PATH_DENIED', 403);
    }
    const after = await handle.stat({ bigint: true });
    const current = await stat(target, { bigint: true });
    if (fingerprint(before) !== fingerprint(after) || fingerprint(after) !== fingerprint(current)) {
      throw failure('DOCUMENT_FILE_CHANGED', 409);
    }
    signal.throwIfAborted();
    return { bytes: Buffer.concat(chunks), fingerprint: fingerprint(after) };
  } finally {
    await handle.close();
  }
}
