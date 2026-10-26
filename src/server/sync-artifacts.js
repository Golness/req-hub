import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from './sync-document-validator.js';

export const SYNC_VERSION = 2;
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const decodeDocument = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

/** Immutable byte artifacts addressed by opaque IDs, never model-supplied paths. */
export class SyncArtifacts {
  constructor(root, { storage, task } = {}) { this.root = resolve(root); this.entries = new Map(); this.storage = storage; this.task = task; }
  async init() { if (this.storage) { this.root = this.storage.attemptRoot(this.task, true); this.realRoot = this.root; } else { await mkdir(this.root, { recursive: true }); this.realRoot = await realpath(this.root); } return this; }
  async put(id, value, namedFile) {
    if (this.entries.has(id)) throw new Error('ARTIFACT_DUPLICATE: ' + id);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    decodeDocument(bytes);
    const file = namedFile || 'artifact-' + hashBytes(Buffer.from(id)).slice(0, 24);
    if (namedFile && !/^sessions\/session-\d+(?:-turn-\d+)?\.md$/.test(namedFile)) throw new Error('ARTIFACT_FILE_NAME');
    if (this.storage) return this.putStored(id, decodeDocument(bytes), bytes, 'text', namedFile);
    const path = join(this.root, file);
    if (namedFile) await mkdir(join(this.root, 'sessions'), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
    const entry = { id, file, bytes: bytes.length, sha256: hashBytes(bytes) };
    this.entries.set(id, entry);
    return entry;
  }
  async read(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('ARTIFACT_DENIED: ' + id);
    if (this.storage) {
      const value = this.storage.readEvidence(this.task, id);
      if (hashBytes(Buffer.from(value)) !== entry.sha256) throw new Error('ARTIFACT_HASH_MISMATCH: ' + id);
      return value;
    }
    const path = join(this.root, entry.file);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('ARTIFACT_SYMLINK');
    const actual = await realpath(path), rel = relative(this.realRoot, actual);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('ARTIFACT_PATH');
    const bytes = await readFile(actual);
    if (hashBytes(bytes) !== entry.sha256) throw new Error('ARTIFACT_HASH_MISMATCH: ' + id);
    return decodeDocument(bytes);
  }
  async manifest(extra = {}) {
    const value = { schemaVersion: SYNC_VERSION, ...extra, artifacts: [...this.entries.values()] };
    await atomicWrite(join(this.root, 'manifest.json'), JSON.stringify(value, null, 2), undefined, this.storage ? () => this.storage.assert(this.task) : undefined);
    return value;
  }
  async putJSON(id, value) {
    if (!this.storage) return this.put(id, JSON.stringify(value));
    return this.putStored(id, JSON.stringify(value), value, 'json');
  }
  async putFragment(id, sourceId, metadata, rendered) {
    if (!this.storage) return this.put(id, rendered);
    return this.putStored(id, rendered, { sourceId, metadata }, 'fragment');
  }
  async putSegments(id, parts, rendered) {
    if (!this.storage) return this.put(id, rendered);
    return this.putStored(id, rendered, { parts }, 'segments');
  }
  putStored(id, rendered, descriptor, kind, namedFile) {
    if (this.entries.has(id)) throw new Error('ARTIFACT_DUPLICATE: ' + id);
    this.storage.putEvidence(this.task, id, descriptor, kind);
    const entry = { id, file: namedFile || id, bytes: Buffer.byteLength(rendered), sha256: hashBytes(Buffer.from(rendered)) };
    this.entries.set(id, entry); return entry;
  }
}
