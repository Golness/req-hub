import { readFile, stat, lstat, readdir, mkdir } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { safeDocumentPath } from '../safe-path.js';
import {
  digest,
  fail,
  now,
  SUPPORTED_EXTENSIONS,
  LIMITS,
  NORMALIZER_VERSION,
} from './contracts.js';
import { decodeUtf8, normalizeText } from './normalize.js';
import { writeTextAtomic, writeJsonAtomic } from './scope.js';

const revisionNumber = (revision) => Number(String(revision).replace(/^rev-/, '')) || 0;

/**
 * Stable source identity: authorized root plus normalized path, or session origin.
 * @param scopeId - Owning scope identity.
 * @param kind - file or session.
 * @param origin - {relativePath} or {provider, instance, sessionId}.
 * @returns The Host-generated source ID.
 */
export function sourceIdentity(scopeId, kind, origin) {
  if (kind === 'file') {
    let key = origin.relativePath.replace(/\\/g, '/');
    if (process.platform === 'win32') {
      key = key.toLowerCase();
    }
    return 'src-' + digest(['file', scopeId, key]).slice(0, 16);
  }
  return (
    'src-' + digest(['session', origin.provider, origin.instance, origin.sessionId]).slice(0, 16)
  );
}

async function readBoundedFile(file, limit) {
  const info = await stat(file);
  if (!info.isFile()) {
    fail('KB_NOT_A_FILE', 400);
  }
  if (info.size > limit) {
    fail('KB_FILE_TOO_LARGE', 413, { limitBytes: limit, size: info.size });
  }
  const bytes = await readFile(file);
  const after = await stat(file);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
    fail('KB_SOURCE_CHANGED', 409);
  }
  return { bytes, mtime: info.mtime.toISOString() };
}

async function collectDirectory(store, dir, base, out, signal) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted();
    if (entry.isSymbolicLink()) {
      continue;
    }
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectDirectory(store, target, base, out, signal);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
      out.push({ relativePath: relative(base, target).replace(/\\/g, '/') });
    }
    if (out.length > LIMITS.batchFiles) {
      fail('KB_BATCH_TOO_LARGE', 413, { limit: LIMITS.batchFiles });
    }
  }
}

/**
 * Persist one immutable snapshot and update the manifest entry.
 * Caller holds the scope write lock and has validated capacity headroom.
 */
async function saveSnapshot(store, manifest, input, signal) {
  const { kind, origin, title, text, extension, provenance } = input;
  const id = sourceIdentity(store.scope.scopeId, kind, origin);
  const existing = manifest.sources.find((source) => source.id === id);
  const rawHash = digest(text);
  if (existing && existing.status === 'saved' && existing.rawHash === rawHash) {
    if (title && title !== existing.title) {
      existing.title = title;
      existing.updatedAt = now();
    }
    return { status: 'skipped', sourceId: id, revision: existing.revision, reason: 'unchanged' };
  }
  const revision = 'rev-' + (existing ? revisionNumber(existing.revision) + 1 : 1);
  const dir = store.path('raw', 'sources', id, revision);
  await mkdir(dir, { recursive: true });
  signal?.throwIfAborted();
  const rawPath = join(dir, 'original' + extension);
  await writeTextAtomic(rawPath, text);
  let contentPath = rawPath;
  let content = text;
  let normalizedHash = rawHash;
  if (extension === '.html' || extension === '.htm') {
    const normalized = normalizeText(extension, text);
    content = normalized.content;
    normalizedHash = digest(content);
    contentPath = join(dir, 'content.md');
    await writeTextAtomic(contentPath, content);
  }
  const provenanceRecord = {
    kind,
    origin,
    rawHash,
    normalizedHash,
    normalizerVersion: NORMALIZER_VERSION,
    importedAt: now(),
    ...provenance,
  };
  await writeJsonAtomic(join(dir, 'provenance.json'), provenanceRecord);
  signal?.throwIfAborted();
  const bytes =
    Buffer.byteLength(text, 'utf8') + Buffer.byteLength(JSON.stringify(provenanceRecord), 'utf8');
  const record = {
    id,
    kind,
    origin,
    title: title || origin.relativePath || origin.sessionId || id,
    revision,
    rawHash,
    normalizedHash,
    normalizerVersion: NORMALIZER_VERSION,
    rawPath: relative(store.dir, rawPath).replace(/\\/g, '/'),
    contentPath: relative(store.dir, contentPath).replace(/\\/g, '/'),
    status: 'saved',
    bytes,
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
  if (existing) {
    Object.assign(existing, record);
  } else {
    manifest.sources.push(record);
  }
  return { status: 'saved', sourceId: id, revision };
}

function checkCapacity(manifest, addedBytes, addedCount) {
  const active = manifest.sources.filter((source) => source.status !== 'excluded');
  if (active.length + addedCount > LIMITS.scopeSources) {
    fail('KB_SCOPE_FULL', 413, { limit: LIMITS.scopeSources });
  }
  const total = active.reduce((sum, source) => sum + (source.bytes || 0), 0) + addedBytes;
  if (total > LIMITS.scopeRawBytes) {
    fail('KB_SCOPE_BYTES_EXCEEDED', 413, { limitBytes: LIMITS.scopeRawBytes });
  }
}

/**
 * Import whitelisted text files as immutable snapshots, one result per item.
 * @param store - The scope store owning the write lock.
 * @param input - {files:[{relativePath}], signal}; directories expand recursively.
 * @returns {results, saved, skipped, failed} with per-item outcomes.
 */
export async function importFiles(store, { files, signal }) {
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.batchFiles) {
    fail('KB_IMPORT_INVALID', 400, { limit: LIMITS.batchFiles });
  }
  return store.run(async () => {
    const manifest = await store.sources();
    const targets = [];
    for (const item of files) {
      signal?.throwIfAborted();
      if (!item || typeof item.relativePath !== 'string' || !item.relativePath) {
        fail('KB_IMPORT_INVALID', 400);
      }
      let target;
      try {
        target = await safeDocumentPath(store.scope.docsRoot, item.relativePath);
      } catch {
        targets.push({ relativePath: item.relativePath, denied: true });
        continue;
      }
      const info = await lstat(target).catch(() => null);
      if (info?.isDirectory()) {
        await collectDirectory(store, target, store.scope.docsRoot, targets, signal);
      } else {
        targets.push({ relativePath: item.relativePath.replace(/\\/g, '/') });
      }
    }
    const unique = [...new Map(targets.map((item) => [item.relativePath, item])).values()];
    if (unique.length > LIMITS.batchFiles) {
      fail('KB_BATCH_TOO_LARGE', 413, { limit: LIMITS.batchFiles });
    }
    const results = [];
    for (const item of unique) {
      signal?.throwIfAborted();
      const result = { relativePath: item.relativePath };
      results.push(result);
      if (item.denied) {
        Object.assign(result, { status: 'failed', code: 'KB_PATH_DENIED' });
        continue;
      }
      const extension = extname(item.relativePath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(extension)) {
        Object.assign(result, { status: 'skipped', code: 'KB_UNSUPPORTED_TYPE' });
        continue;
      }
      try {
        const target = await safeDocumentPath(store.scope.docsRoot, item.relativePath);
        const { bytes, mtime } = await readBoundedFile(target, LIMITS.sourceBytes);
        const text = decodeUtf8(bytes);
        const normalized = normalizeText(extension, text);
        const id = sourceIdentity(store.scope.scopeId, 'file', {
          relativePath: item.relativePath,
        });
        const existing = manifest.sources.find((source) => source.id === id);
        const incoming = Buffer.byteLength(text, 'utf8') + 512;
        checkCapacity(
          manifest,
          existing ? incoming - (existing.bytes || 0) : incoming,
          existing ? 0 : 1,
        );
        const saved = await saveSnapshot(
          store,
          manifest,
          {
            kind: 'file',
            origin: { relativePath: item.relativePath },
            title: normalized.title || item.relativePath.split('/').pop(),
            text,
            extension,
            provenance: { mtime },
          },
          signal,
        );
        Object.assign(result, saved);
      } catch (error) {
        Object.assign(result, {
          status: 'failed',
          code: error.code || 'KB_IMPORT_FAILED',
          details: error.details,
        });
      }
    }
    signal?.throwIfAborted();
    await store.writeSources(manifest);
    return {
      results,
      saved: results.filter((item) => item.status === 'saved').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      failed: results.filter((item) => item.status === 'failed').length,
    };
  });
}

/**
 * Save one exported session Markdown through the same snapshot pipeline.
 * @param store - The scope store owning the write lock.
 * @param input - {origin, title, markdown, provenance, signal}.
 * @returns The per-source save outcome.
 */
export async function importSessionMarkdown(
  store,
  { origin, title, markdown, provenance, signal },
) {
  return store.run(async () => {
    const manifest = await store.sources();
    if (Buffer.byteLength(markdown, 'utf8') > LIMITS.sourceBytes) {
      fail('KB_FILE_TOO_LARGE', 413, { limitBytes: LIMITS.sourceBytes });
    }
    const id = sourceIdentity(store.scope.scopeId, 'session', origin);
    const existing = manifest.sources.find((source) => source.id === id);
    const incoming = Buffer.byteLength(markdown, 'utf8') + 4096;
    checkCapacity(
      manifest,
      existing ? incoming - (existing.bytes || 0) : incoming,
      existing ? 0 : 1,
    );
    const result = await saveSnapshot(
      store,
      manifest,
      {
        kind: 'session',
        origin,
        title,
        text: markdown,
        extension: '.md',
        provenance,
      },
      signal,
    );
    signal?.throwIfAborted();
    await store.writeSources(manifest);
    return result;
  });
}

/**
 * List sources with optional filters and pagination.
 * @param store - The scope store.
 * @param [options] - {query, kind, status, offset, limit}.
 * @returns {items, total, offset, limit}; each item carries a compiled flag
 * reflecting whether the current release covers its exact revision.
 */
export async function listSources(store, { query, kind, status, offset = 0, limit = 50 } = {}) {
  const manifest = await store.sources();
  let items = manifest.sources.filter((source) => source.status !== 'excluded');
  if (kind) {
    items = items.filter((source) => source.kind === kind);
  }
  if (status) {
    items = items.filter((source) => source.status === status);
  }
  if (query) {
    const needle = query.toLowerCase();
    items = items.filter(
      (source) =>
        source.title.toLowerCase().includes(needle) ||
        (source.origin.relativePath || '').toLowerCase().includes(needle),
    );
  }
  items.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const total = items.length;
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.min(200, Math.max(1, Number(limit) || 50));
  const pointer = await store.current();
  const release = pointer.generationId
    ? await readReleaseManifest(store, pointer.generationId)
    : undefined;
  const revisions = release?.sourceRevisions || {};
  const page = items
    .slice(start, start + size)
    .map((source) => ({ ...source, compiled: revisions[source.id] === source.revision }));
  return { items: page, total, offset: start, limit: size };
}

/**
 * Read one saved snapshot with its provenance.
 * @param store - The scope store.
 * @param id - Host-generated source ID.
 * @returns {source, content, provenance}; unknown IDs reject.
 */
export async function getSource(store, id) {
  const manifest = await store.sources();
  const source = manifest.sources.find((item) => item.id === id && item.status !== 'excluded');
  if (!source) {
    fail('KB_SOURCE_MISSING', 404, { sourceId: id });
  }
  const [content, provenance] = await Promise.all([
    readFile(store.path(source.contentPath), 'utf8'),
    readFile(store.path('raw', 'sources', id, source.revision, 'provenance.json'), 'utf8').then(
      (text) => JSON.parse(text),
    ),
  ]);
  return { source, content, provenance };
}

const compileJobTime = (job) => String(job.finishedAt || job.createdAt || '');

/**
 * Select compile jobs that target one current source revision. Rebuilds include
 * every source in their revision snapshot; ingest jobs only include sourceIds.
 */
function targetsSourceRevision(job, id, revision) {
  if (job.sourceRevisions?.[id] !== revision) {
    return false;
  }
  return job.kind === 'rebuild' || (job.kind === 'ingest' && job.sourceIds?.includes(id));
}

/**
 * Compare an imported file snapshot with its current external file without writing a revision.
 * @param store - Owning scope store.
 * @param source - Manifest source record.
 * @returns True when the current file is missing, unreadable or has a different raw hash.
 */
export async function sourceIsStale(store, source) {
  if (source.kind !== 'file') {
    return false;
  }
  try {
    const target = await safeDocumentPath(store.scope.docsRoot, source.origin.relativePath);
    const { bytes } = await readBoundedFile(target, LIMITS.sourceBytes);
    return digest(decodeUtf8(bytes)) !== source.rawHash;
  } catch {
    return true;
  }
}

/**
 * Resolve one external file's knowledge state for the file viewer.
 * @param store - The scope store.
 * @param relativePath - Workspace-relative document path.
 * @returns {state, sourceId?, revision?, jobId?, error?} where state is
 *   missing/saved/stale/compiling/failed/compiled.
 */
export async function stateByPath(store, relativePath) {
  const id = sourceIdentity(store.scope.scopeId, 'file', { relativePath });
  const manifest = await store.sources();
  const source = manifest.sources.find((item) => item.id === id && item.status !== 'excluded');
  if (!source) {
    return { state: 'missing' };
  }
  const [pointer, jobManifest] = await Promise.all([store.current(), store.jobs()]);
  const jobs = jobManifest.jobs
    .filter((job) => targetsSourceRevision(job, id, source.revision))
    .sort((a, b) => compileJobTime(b).localeCompare(compileJobTime(a)));
  const activeJob = jobs.find((job) => ['queued', 'running', 'cancelling'].includes(job.status));
  if (activeJob) {
    return {
      state: 'compiling',
      sourceId: id,
      revision: source.revision,
      jobId: activeJob.id,
    };
  }
  const release = pointer.generationId
    ? await readReleaseManifest(store, pointer.generationId)
    : null;
  const compiled = release?.sourceRevisions?.[id] === source.revision;
  const failedJob = jobs.find((job) => job.status === 'failed');
  if (failedJob && (!compiled || compileJobTime(failedJob) > String(release.createdAt || ''))) {
    return {
      state: 'failed',
      sourceId: id,
      revision: source.revision,
      jobId: failedJob.id,
      error: failedJob.error,
    };
  }
  if (compiled) {
    return { state: 'compiled', sourceId: id, revision: source.revision };
  }
  try {
    const target = await safeDocumentPath(store.scope.docsRoot, relativePath);
    const { bytes } = await readBoundedFile(target, LIMITS.sourceBytes);
    if (digest(decodeUtf8(bytes)) !== source.rawHash) {
      return { state: 'stale', sourceId: id, revision: source.revision };
    }
  } catch {
    // An unreadable external file still has a saved snapshot; report it as saved.
  }
  return { state: 'saved', sourceId: id, revision: source.revision };
}

/**
 * Read a release manifest; a missing generation returns undefined.
 * @param store - The scope store.
 * @param generationId - Published generation identity.
 * @returns The manifest, or undefined when absent.
 */
export async function readReleaseManifest(store, generationId) {
  const file = store.path('releases', generationId, 'manifest.json');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    fail('KB_STORAGE_CORRUPT', 500, { generationId });
  }
}

/**
 * Mark one source excluded; physical reclamation follows a successful rebuild.
 * Caller enforces user-only authorization and queues the rebuild job.
 * @param store - The scope store.
 * @param id - Host-generated source ID.
 * @returns The removed source record.
 */
export async function excludeSource(store, id) {
  return store.run(async () => {
    const manifest = await store.sources();
    const source = manifest.sources.find((item) => item.id === id);
    if (!source || source.status === 'excluded') {
      fail('KB_SOURCE_MISSING', 404, { sourceId: id });
    }
    source.status = 'excluded';
    source.updatedAt = now();
    const meta = await store.meta();
    meta.epoch += 1;
    await writeJsonAtomic(store.path('scope.json'), meta);
    await store.writeSources(manifest);
    return source;
  });
}
