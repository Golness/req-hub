import { contentTemplates } from '../content-templates.js';
import { mkdir, readdir, readFile, rm, rename, cp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  digest,
  fail,
  now,
  serializePage,
  parsePage,
  extractWikilinks,
  LIMITS,
  SCHEMA_VERSION,
  COMPILER_VERSION,
} from './contracts.js';
import { writeJsonAtomic, writeTextAtomic } from './scope.js';

/**
 * Create a staging area, copying the base generation for incremental work.
 * @param store - The scope store.
 * @param jobId - Owning job identity.
 * @param [baseGenerationId] - Current generation to copy for ingest.
 * @returns The staging root path.
 */
export async function prepareStaging(store, jobId, baseGenerationId) {
  const staging = store.path('staging', jobId);
  await mkdir(join(staging, 'wiki'), { recursive: true });
  if (baseGenerationId) {
    await cp(store.path('releases', baseGenerationId, 'wiki'), join(staging, 'wiki'), {
      recursive: true,
    });
  }
  return staging;
}

/**
 * Write one validated page into staging with Host-owned frontmatter.
 * @param staging - Staging root from prepareStaging.
 * @param page - {pageId, type, title, body, sources}.
 * @returns The page content hash.
 */
export async function writeStagingPage(staging, page) {
  const text = serializePage(
    {
      id: page.pageId,
      type: page.type,
      title: page.title,
      sources: page.sources,
      updatedAt: now(),
    },
    page.body,
  );
  if (Buffer.byteLength(text, 'utf8') > LIMITS.pageBytes) {
    fail('KB_PAGE_TOO_LARGE', 413, { pageId: page.pageId, limitBytes: LIMITS.pageBytes });
  }
  const file = join(staging, 'wiki', page.pageId + '.md');
  await writeTextAtomic(file, text);
  return digest(text);
}

/**
 * Read every page under a wiki root (staging or a published release) into a catalog.
 * Host aggregates index/overview/log are excluded; they carry no frontmatter.
 * @param wikiRoot - Directory containing the page tree.
 * @returns [{pageId, meta, body, text, hash, links}] sorted by pageId.
 */
export async function readWikiPages(wikiRoot) {
  const pages = [];
  const walk = async (dir, prefix) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target, prefix + entry.name + '/');
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const pageId = prefix + entry.name.slice(0, -3);
        if (['index', 'overview', 'log'].includes(pageId)) {
          continue;
        }
        const text = await readFile(target, 'utf8');
        const { meta, body } = parsePage(text);
        if (meta.id !== pageId) {
          fail('KB_PAGE_FORMAT_INVALID', 500, { pageId });
        }
        pages.push({
          pageId,
          meta,
          body,
          text,
          hash: digest(text),
          links: extractWikilinks(body),
        });
      }
    }
  };
  await walk(wikiRoot, '');
  return pages.sort((a, b) => a.pageId.localeCompare(b.pageId));
}

/** Read every staging page into a parsed catalog. */
export async function readStagingPages(staging) {
  return readWikiPages(join(staging, 'wiki'));
}

/** Build the Host-owned index catalog; the model never writes this file. */
export function buildIndex(pages, generationId) {
  const wiki = contentTemplates().wiki;
  const groups = [
    ['sources', wiki.groups.summary],
    ['entities', wiki.groups.entity],
    ['concepts', wiki.groups.concept],
    ['topics', wiki.groups.topic],
  ];
  const lines = [
    wiki.indexTitle,
    '',
    wiki.publishedVersion(generationId),
    '',
    wiki.overviewLink,
    '',
  ];
  for (const [type, label] of groups) {
    const items = pages.filter((page) => page.meta.type === type);
    if (!items.length) {
      continue;
    }
    lines.push(`## ${label}`, '');
    for (const page of items) {
      lines.push(`- [[${page.pageId}|${page.meta.title}]]`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Append one Host-owned log entry, bounding the retained history. */
export async function appendLog(staging, baseGeneration, store, entry) {
  let prior = '';
  if (baseGeneration) {
    prior = await readFile(store.path('releases', baseGeneration, 'wiki', 'log.md'), 'utf8').catch(
      () => '',
    );
  }
  const lines = (prior ? prior.split('\n').filter((line) => line.startsWith('- ')) : []).slice(
    -999,
  );
  lines.push(`- ${entry}`);
  await writeTextAtomic(
    join(staging, 'wiki', 'log.md'),
    contentTemplates().wiki.changelogTitle + lines.join('\n') + '\n',
  );
}

/**
 * Validate the complete staged generation and write its manifest.
 * @param store - The scope store.
 * @param staging - Staging root.
 * @param input - {jobId, baseGeneration, rulesHash, sourceRevisions, operation, overview}.
 * @returns {generationId, pages, manifest} ready for the atomic switch.
 */
export async function finalizeStaging(store, staging, input) {
  const pages = await readStagingPages(staging);
  if (pages.length > LIMITS.scopePages) {
    fail('KB_SCOPE_PAGES_EXCEEDED', 413, { limit: LIMITS.scopePages });
  }
  const manifestSources = await store.sources();
  const active = new Map(
    manifestSources.sources
      .filter((source) => source.status !== 'excluded')
      .map((source) => [source.id, source]),
  );
  for (const source of active.values()) {
    if (!pages.some((page) => page.pageId === `sources/${source.id}`)) {
      fail('KB_SOURCE_SUMMARY_MISSING', 400, { sourceId: source.id });
    }
  }
  for (const page of pages) {
    for (const ref of page.meta.sources) {
      const source = active.get(ref.id);
      if (!source || source.revision !== ref.revision) {
        fail('KB_MODEL_OUTPUT_INVALID', 400, {
          reason: 'unknown source revision',
          pageId: page.pageId,
          sourceId: ref.id,
        });
      }
    }
  }
  const generationId = 'gen-' + randomUUID();
  await writeTextAtomic(join(staging, 'wiki', 'index.md'), buildIndex(pages, generationId));
  const wiki = contentTemplates().wiki;
  await writeTextAtomic(
    join(staging, 'wiki', 'overview.md'),
    `${wiki.overviewTitle}\n\n${input.overview || wiki.overviewEmpty}\n`,
  );
  await appendLog(
    staging,
    input.baseGeneration,
    store,
    `${now()} | ${input.operation} | sources:${Object.keys(input.sourceRevisions).join(',') || '-'} | published | ${generationId}`,
  );
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    id: generationId,
    jobId: input.jobId,
    baseGeneration: input.baseGeneration || null,
    rulesHash: input.rulesHash,
    sourceRevisions: input.sourceRevisions,
    fingerprints: Object.fromEntries(
      [...active.values()].map((source) => [
        source.id,
        digest([
          source.revision,
          source.normalizedHash,
          source.normalizerVersion,
          input.rulesHash,
          COMPILER_VERSION,
        ]),
      ]),
    ),
    pageHashes: Object.fromEntries(pages.map((page) => [page.pageId, page.hash])),
    operation: input.operation,
    compilerVersion: COMPILER_VERSION,
    createdAt: now(),
  };
  const files = await releaseFiles(staging);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > LIMITS.releaseBytes) {
    fail('KB_RELEASE_TOO_LARGE', 413, { limitBytes: LIMITS.releaseBytes });
  }
  await writeJsonAtomic(join(staging, 'manifest.json'), manifest);
  return { generationId, pages, manifest };
}

async function releaseFiles(staging) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile()) {
        out.push({ path: target, bytes: (await stat(target)).size });
      }
    }
  };
  await walk(staging);
  return out;
}

/**
 * Recheck versions and atomically switch current.json to the staged generation.
 * The commit point is the pointer rename; a cancel before it blocks publication.
 * @param store - The scope store.
 * @param staging - Staging root.
 * @param input - {generationId, jobId, epoch, rulesHash, sourceRevisions, baseGeneration, signal}.
 * @returns Completion after the switch and reclamation.
 */
export async function publishRelease(store, staging, input) {
  const { signal } = input;
  signal?.throwIfAborted();
  const meta = await store.meta();
  const rules = await store.rules();
  const manifest = await store.sources();
  const pointer = await store.current();
  const active = new Map(
    manifest.sources
      .filter((source) => source.status !== 'excluded')
      .map((source) => [source.id, source.revision]),
  );
  const stale =
    meta.epoch !== input.epoch ||
    rules.rulesHash !== input.rulesHash ||
    (pointer.generationId || null) !== (input.baseGeneration || null) ||
    Object.keys(input.sourceRevisions).length !== active.size ||
    Object.entries(input.sourceRevisions).some(([id, revision]) => active.get(id) !== revision);
  if (stale) {
    fail('KB_STALE', 409, { reason: 'inputs changed before publish' });
  }
  signal?.throwIfAborted();
  const releaseDir = store.path('releases', input.generationId);
  await rename(staging, releaseDir);
  try {
    await writeJsonAtomic(store.path('current.json'), { generationId: input.generationId });
  } catch (error) {
    // Windows file occupancy can block the pointer rename; the old pointer stays.
    fail('KB_STORAGE_BUSY', 503, { reason: error.message });
  }
  await reclaim(store, input.generationId, pointer.generationId);
}

/** Remove unreferenced generations, staging areas and obsolete raw revisions. */
export async function reclaim(store, currentId, previousId) {
  const keep = new Set([currentId, previousId].filter(Boolean));
  for (const entry of await readdir(store.path('releases'), { withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.isDirectory() && !keep.has(entry.name)) {
      await rm(join(store.path('releases'), entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of await readdir(store.path('staging'), { withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.isDirectory()) {
      await rm(join(store.path('staging'), entry.name), { recursive: true, force: true });
    }
  }
  const manifest = await store.sources();
  const active = new Map(manifest.sources.map((source) => [source.id, source]));
  const rawRoot = store.path('raw', 'sources');
  for (const entry of await readdir(rawRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) {
      continue;
    }
    const source = active.get(entry.name);
    const dir = join(rawRoot, entry.name);
    if (!source || source.status === 'excluded') {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    for (const revision of await readdir(dir, { withFileTypes: true })) {
      if (revision.isDirectory() && revision.name !== source.revision) {
        await rm(join(dir, revision.name), { recursive: true, force: true });
      }
    }
  }
}

/** Remove leftover staging areas from a previous process at startup. */
export async function cleanStaging(store) {
  for (const entry of await readdir(store.path('staging'), { withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.isDirectory()) {
      await rm(join(store.path('staging'), entry.name), { recursive: true, force: true });
    }
  }
}
