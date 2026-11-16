import { msg, messageDescriptor } from '../messages.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexTranscript } from './transcript.js';

/**
 * Create a Codex source error with an HTTP status, preserving message params.
 * @param message - Bare stable code or `{ code, params }` descriptor.
 * @param [statusCode] - HTTP status for the domain failure.
 * @returns An Error carrying statusCode.
 */
export const codexError = (message, statusCode = 400) => {
  const descriptor = messageDescriptor(message);
  const code = typeof descriptor === 'string' ? descriptor : descriptor.code;
  const error = new Error(code);
  error.messageCode = code;
  if (typeof descriptor === 'object') {
    error.params = descriptor.params;
  }
  return Object.assign(error, { statusCode });
};
/**
 * Normalize path spelling without resolving the filesystem or validating access.
 * @param value - Source path with optional Windows extended-length prefix.
 * @returns The path with normalized separators and Windows drive spelling.
 */
export const canonicalPath = (value) =>
  String(value || '')
    .replace(/^\\\\\?\\/, '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .replace(/^([A-Z]):/, (_, drive) => drive.toLowerCase() + ':');
const keyPath = (path) =>
  /^[a-z]:\//i.test(canonicalPath(path)) ? canonicalPath(path).toLowerCase() : canonicalPath(path);
const beneath = (root, path) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
};
const projectId = (path) =>
  'root:' + createHash('sha256').update(keyPath(path)).digest('hex').slice(0, 24);
const label = (path) => canonicalPath(path).split('/').at(-1) || path;
const timestamp = (value) => {
  if (typeof value === 'number') {
    if (value < 1e12) {
      return value * 1000;
    } else {
      return value;
    }
  } else {
    return Date.parse(value) || 0;
  }
};
const subagent = (source) =>
  typeof source === 'object'
    ? !!source?.subagent
    : /subagent|sub_agent/i.test(String(source || ''));
const sessionTitle = (...candidates) =>
  candidates.find((value) => typeof value === 'string' && value.trim())?.trim();

async function readTitles(home, warnings) {
  const titles = new Map();
  try {
    for (const raw of (await readFile(join(home, 'session_index.jsonl'), 'utf8')).split('\n')) {
      try {
        const item = JSON.parse(raw);
        if (item.id) {
          titles.set(item.id, item);
        }
      } catch (error) {
        // Skip an incomplete record in the optional title index.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.push(msg('LOG_CODEX_TITLE_INDEX_UNREADABLE', { v0: error.message }));
    }
  }
  return titles;
}

async function safeEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
async function walk(path, out, signal) {
  for (const entry of await safeEntries(path)) {
    signal?.throwIfAborted();
    if (entry.isDirectory()) {
      await walk(join(path, entry.name), out, signal);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(join(path, entry.name));
    }
  }
}

/** Metadata prefix reading and session_index titles follow dsh-codex-migrate's inventory approach. */
async function prefixInfo(path) {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(256 * 1024);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    let meta;
    let root;
    for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const record = JSON.parse(line);
        if (record.type === 'session_meta') {
          meta = record.payload;
        }
        if (record.type === 'turn_context' && record.payload.workspace_roots?.[0]) {
          root ||= record.payload.workspace_roots[0];
        }
      } catch (error) {
        // The bounded metadata prefix may end in a partial JSON line.
      }
    }
    if (!meta?.id && !meta?.session_id) {
      throw codexError('CODEX_METADATA_INVALID');
    }
    return { ...meta, root: root || meta.workspace_root || meta.cwd };
  } finally {
    await file.close();
  }
}

/** Read Codex source files without modifying source sessions. */
export class CodexSource {
  constructor(home) {
    this.home = resolve(home);
  }
  async inventory({ signal } = {}) {
    signal?.throwIfAborted();
    const entries = await safeEntries(this.home);
    if (!entries.length) {
      return {
        workspaces: [],
        sessions: [],
        warnings: ['ERR_CODEX_SESSION_DIR_NOT_FOUND'],
      };
    }
    const databases = entries
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
      .sort((a, b) => Number(b.name.match(/\d+/)[0]) - Number(a.name.match(/\d+/)[0]));
    const sessions = [];
    const workspaces = new Map();
    const warnings = [];
    const titles = await readTitles(this.home, warnings);
    const addWorkspace = (id, title, paths) => {
      const workspace = {
        id,
        title,
        paths: paths.filter(Boolean),
        path: paths.filter(Boolean).join(' · '),
        sessionCount: 0,
      };
      workspaces.set(id, workspace);
      return workspace;
    };
    if (databases.length) {
      let db;
      try {
        db = new DatabaseSync(join(this.home, databases[0].name), { readOnly: true });
        db.exec('PRAGMA busy_timeout=3000;');
        const columns = new Set(
          db
            .prepare('PRAGMA table_info(threads)')
            .all()
            .map((column) => column.name),
        );
        if (!['id', 'cwd', 'rollout_path', 'archived'].every((column) => columns.has(column))) {
          throw Error('ERR_CODEX_THREADS_SCHEMA_UNSUPPORTED');
        }
        const tables = new Set(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((row) => row.name),
        );
        if (tables.has('projects') && tables.has('project_roots')) {
          const roots = db
            .prepare('SELECT project_id,path FROM project_roots ORDER BY position')
            .all();
          for (const project of db.prepare('SELECT id,name FROM projects').all()) {
            addWorkspace(
              'project:' + project.id,
              project.name || project.id,
              roots.filter((root) => root.project_id === project.id).map((root) => root.path),
            );
          }
        }
        const optional = [
          'name',
          'title',
          'source',
          'thread_source',
          'created_at',
          'created_at_ms',
          'updated_at',
          'updated_at_ms',
          'project_id',
        ].filter((column) => columns.has(column));
        for (const row of db
          .prepare(
            `SELECT id,cwd,rollout_path,${optional.length ? optional.join(',') + ',' : ''}archived FROM threads WHERE archived=0`,
          )
          .all()) {
          signal?.throwIfAborted();
          if (subagent(row.source) || subagent(row.thread_source)) {
            continue;
          }
          let workspace = row.project_id && workspaces.get('project:' + row.project_id);
          workspace ||= [...workspaces.values()]
            .filter((project) =>
              project.paths.some(
                (root) =>
                  keyPath(row.cwd) === keyPath(root) ||
                  keyPath(row.cwd).startsWith(keyPath(root) + '/'),
              ),
            )
            .sort(
              (a, b) =>
                Math.max(...b.paths.map((root) => root.length)) -
                Math.max(...a.paths.map((root) => root.length)),
            )[0];
          if (!workspace) {
            workspace =
              workspaces.get(projectId(row.cwd)) ||
              addWorkspace(projectId(row.cwd), label(row.cwd) || 'STATUS_NO_WORKSPACE', [row.cwd]);
          }
          const rolloutPath = canonicalPath(row.rollout_path);
          const sourcePath = isAbsolute(rolloutPath)
            ? rolloutPath
            : resolve(this.home, rolloutPath);
          if (!beneath(resolve(this.home, 'sessions'), resolve(sourcePath))) {
            continue;
          }
          sessions.push({
            nativeId: row.id,
            id: 'codex:' + row.id,
            workspaceId: workspace.id,
            sourcePath,
            // Desktop names are separate from title, which can contain the initial user prompt.
            title: sessionTitle(row.name, titles.get(row.id)?.thread_name, row.title) || row.id,
            cwd: row.cwd,
            createdAt: timestamp(row.created_at_ms || row.created_at),
            updatedAt: timestamp(row.updated_at_ms || row.updated_at),
          });
          workspace.sessionCount++;
        }
      } catch (error) {
        signal?.throwIfAborted();
        throw codexError(msg('CODEX_DATABASE_READ_FAILED', { v0: error.message }), 503);
      } finally {
        db?.close();
      }
    } else {
      const files = [];
      await walk(join(this.home, 'sessions'), files, signal);
      for (const file of files) {
        signal?.throwIfAborted();
        try {
          const meta = await prefixInfo(file);
          if (meta.archived || subagent(meta.thread_source) || subagent(meta.source)) {
            continue;
          }
          const nativeId = meta.session_id || meta.id;
          const workspace =
            workspaces.get(projectId(meta.root)) ||
            addWorkspace(projectId(meta.root), label(meta.root) || 'STATUS_NO_WORKSPACE', [
              meta.root,
            ]);
          const details = await stat(file);
          const title = titles.get(nativeId);
          sessions.push({
            nativeId,
            id: 'codex:' + nativeId,
            workspaceId: workspace.id,
            sourcePath: file,
            title: sessionTitle(title?.thread_name) || nativeId,
            cwd: meta.cwd || meta.root,
            createdAt: timestamp(meta.timestamp),
            updatedAt: timestamp(title?.updated_at) || details.mtimeMs,
          });
          workspace.sessionCount++;
        } catch (error) {
          warnings.push(`${basename(file)}：${error.message}`);
        }
      }
    }
    signal?.throwIfAborted();
    return {
      workspaces: [...workspaces.values()].sort((a, b) => a.title.localeCompare(b.title)),
      sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
      warnings,
    };
  }

  async snapshot(session, { signal } = {}) {
    signal?.throwIfAborted();
    const root = await realpath(join(this.home, 'sessions'));
    const path = await realpath(session.sourcePath);
    if (!beneath(root, path)) {
      throw codexError('CODEX_SOURCE_INVALID');
    }
    const before = await stat(path);
    const parser = createCodexTranscript(session.id);
    const stream = createReadStream(path, { encoding: 'utf8', signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let metaId;
    let archived = false;
    let malformed = 0;
    try {
      for await (const line of lines) {
        signal?.throwIfAborted();
        if (!line.trim()) {
          continue;
        }
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        if (record.type === 'session_meta') {
          metaId = record.payload?.session_id || record.payload?.id;
          archived ||= !!record.payload?.archived;
        }
        parser.push(record);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    signal?.throwIfAborted();
    const after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw codexError('CODEX_SESSION_CHANGING', 409);
    }
    if (malformed) {
      throw codexError('CODEX_SESSION_INVALID', 409);
    }
    if (metaId !== session.nativeId || archived) {
      throw codexError('CODEX_SOURCE_INVALID_ARCHIVED', 409);
    }
    return parser.finish();
  }
}
