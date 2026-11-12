import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safeDocumentPath } from '../safe-path.js';
import { digest, fail, now, bounded, SCHEMA_VERSION, LIMITS } from './contracts.js';

export const DEFAULT_PURPOSE = `# Knowledge purpose
Describe what this knowledge base is for and which questions it should answer.
Keep this file short and specific. It is read by every compile task.`;

export const DEFAULT_SCHEMA = `# Wiki structure rules
Page types: source (one summary per material), entity, concept, topic.
Use logical page paths: sources/<sourceId>, entities/<slug>, concepts/<slug>, topics/<slug>.
Link related pages with [[logical-page-path]].
Cite material as [label](source:<sourceId>@<revision>#L<start>-L<end>) with real line numbers.
Keep facts, conditions, and uncertainty. Record conflicts with both sources.
Write maintenance rules in English. Final page content uses the configured generation language.`;

/**
 * Locate the profile-owned knowledge-v2 data root, mirroring config storage.
 * @param [options] - Optional profile directory supplied by the Host launcher.
 * @returns The absolute data root for this profile.
 */
export function knowledgeV2Root({ profileDir } = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile =
    profileDir ||
    process.env.DSH_PROFILE_DIR ||
    (process.env.DSH_PROFILE ? join(home, 'profiles', process.env.DSH_PROFILE) : home);
  return join(profile, 'req-hub', 'knowledge-v2');
}

/**
 * Resolve one authorized workspace scope from Host-validated identity.
 * @param options - {root, workspace, docsDir}; workspace comes from the registry.
 * @returns {scopeId, dir, workspace, workspaceId, workspaceRoot, docsRoot} with real paths.
 */
export async function resolveScope({ root, workspace, docsDir }) {
  if (!workspace?.id || typeof workspace.path !== 'string') {
    fail('KB_WORKSPACE_INVALID', 400);
  }
  let workspaceRoot;
  try {
    workspaceRoot = await realpath(workspace.path);
  } catch {
    fail('KB_WORKSPACE_MISSING', 404, { workspaceId: workspace.id });
  }
  const docsRelative = docsDir || 'docs';
  const docsRoot = resolve(workspaceRoot, docsRelative);
  if (docsRoot !== workspaceRoot) {
    try {
      await safeDocumentPath(workspaceRoot, docsRelative, { allowMissing: true });
    } catch {
      fail('KB_PATH_DENIED', 403, { docsDir: docsRelative });
    }
  }
  const scopeId = digest([root, workspace.id, workspaceRoot, docsRoot]);
  return {
    scopeId,
    dir: join(root, 'scopes', scopeId),
    workspace,
    workspaceId: workspace.id,
    workspaceRoot,
    docsRoot,
  };
}

/**
 * Read a JSON manifest; a missing file may return the supplied fallback.
 * @param file - Absolute manifest path.
 * @param [fallback] - Value for a missing file; omit to reject missing files.
 * @returns The parsed manifest.
 */
export async function readJson(file, fallback) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) {
      return structuredClone(fallback);
    }
    fail('KB_STORAGE_READ_FAILED', 500, { file: file.split(/[\\/]/).pop() });
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('KB_STORAGE_CORRUPT', 500, { file: file.split(/[\\/]/).pop() });
  }
}

/**
 * Atomically replace a JSON manifest through a same-directory temporary file.
 * @param file - Absolute manifest path.
 * @param value - Serializable manifest content.
 * @returns Completion after the rename commits.
 */
export async function writeJsonAtomic(file, value) {
  bounded(value, LIMITS.jsonControlBytes);
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, file);
}

/**
 * Atomically replace a text file through a same-directory temporary file.
 * @param file - Absolute file path.
 * @param text - Complete UTF-8 content.
 * @returns Completion after the rename commits.
 */
export async function writeTextAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, file);
}

/**
 * One scope's file store and serial write lock. All manifest writes and source
 * mutations run through run(); readers never block on the lock.
 */
export class ScopeStore {
  /**
   * @param scope - Resolved scope identity from resolveScope.
   */
  constructor(scope) {
    this.scope = scope;
    this.dir = scope.dir;
    this.pending = Promise.resolve();
    this.closed = false;
  }
  path(...parts) {
    return join(this.dir, ...parts);
  }
  /**
   * Serialize one write transaction; failures do not poison later writes.
   * @param fn - Async transaction receiving no arguments.
   * @returns The transaction result.
   */
  run(fn) {
    if (this.closed) {
      fail('KB_STORAGE_BUSY', 503);
    }
    const result = this.pending.then(() => {
      if (this.closed) {
        fail('KB_STORAGE_BUSY', 503);
      }
      return fn();
    });
    this.pending = result.catch(() => {});
    return result;
  }
  /** Create missing control files without overwriting existing user content. */
  async init() {
    await mkdir(this.path('raw', 'sources'), { recursive: true });
    await mkdir(this.path('releases'), { recursive: true });
    await mkdir(this.path('staging'), { recursive: true });
    const metaFile = this.path('scope.json');
    const meta = await readJson(metaFile, null);
    if (!meta) {
      await writeJsonAtomic(metaFile, {
        schemaVersion: SCHEMA_VERSION,
        workspaceId: this.scope.workspaceId,
        workspaceRoot: this.scope.workspaceRoot,
        docsRoot: this.scope.docsRoot,
        epoch: 0,
        language: 'auto',
        createdAt: now(),
      });
    } else if (meta.schemaVersion !== SCHEMA_VERSION) {
      fail('KB_FORMAT_UNSUPPORTED', 503);
    }
    const ensure = async (name, create) => {
      try {
        await readFile(this.path(name), 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        await create();
      }
    };
    await ensure('purpose.md', () => writeTextAtomic(this.path('purpose.md'), DEFAULT_PURPOSE));
    await ensure('schema.md', () => writeTextAtomic(this.path('schema.md'), DEFAULT_SCHEMA));
    await ensure('sources.json', () =>
      writeJsonAtomic(this.path('sources.json'), { schemaVersion: SCHEMA_VERSION, sources: [] }),
    );
    await ensure('current.json', () =>
      writeJsonAtomic(this.path('current.json'), { generationId: null }),
    );
    await ensure('jobs.json', () => writeJsonAtomic(this.path('jobs.json'), { jobs: [] }));
  }
  async meta() {
    return readJson(this.path('scope.json'));
  }
  async sources() {
    const manifest = await readJson(this.path('sources.json'));
    if (manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.sources)) {
      fail('KB_STORAGE_CORRUPT', 500, { file: 'sources.json' });
    }
    return manifest;
  }
  async writeSources(manifest) {
    await writeJsonAtomic(this.path('sources.json'), manifest);
  }
  async current() {
    const pointer = await readJson(this.path('current.json'));
    if (typeof pointer.generationId !== 'string' && pointer.generationId !== null) {
      fail('KB_STORAGE_CORRUPT', 500, { file: 'current.json' });
    }
    return pointer;
  }
  async jobs() {
    const manifest = await readJson(this.path('jobs.json'), { jobs: [] });
    if (!Array.isArray(manifest.jobs)) {
      fail('KB_STORAGE_CORRUPT', 500, { file: 'jobs.json' });
    }
    return manifest;
  }
  async writeJobs(manifest) {
    await writeJsonAtomic(this.path('jobs.json'), manifest);
  }
  /** Read purpose/schema/language as the compile rules snapshot. */
  async rules() {
    const [purpose, schema, meta] = await Promise.all([
      readFile(this.path('purpose.md'), 'utf8'),
      readFile(this.path('schema.md'), 'utf8'),
      this.meta(),
    ]);
    return {
      purpose,
      schema,
      language: meta.language || 'auto',
      rulesHash: digest([purpose, schema, meta.language || 'auto']),
      epoch: meta.epoch,
    };
  }
  /**
   * Save user-maintained rules and bump the scope epoch (user-only action).
   * @param input - {purpose?, schema?, language?} with bounded text fields;
   *   null restores a text field to its default.
   * @returns The new rules snapshot.
   */
  async saveRules(input) {
    return this.run(async () => {
      const meta = await this.meta();
      for (const [key, file, fallback] of [
        ['purpose', 'purpose.md', DEFAULT_PURPOSE],
        ['schema', 'schema.md', DEFAULT_SCHEMA],
      ]) {
        if (input[key] !== undefined) {
          const value = input[key] === null ? fallback : input[key];
          if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024) {
            fail('KB_RULES_INVALID', 400, { field: key });
          }
          await writeTextAtomic(this.path(file), value);
        }
      }
      if (input.language !== undefined) {
        if (!['auto', 'zh', 'en'].includes(input.language)) {
          fail('KB_RULES_INVALID', 400, { field: 'language' });
        }
        meta.language = input.language;
      }
      meta.epoch += 1;
      await writeJsonAtomic(this.path('scope.json'), meta);
      return this.rules();
    });
  }
  close() {
    this.closed = true;
    return this.pending;
  }
}
