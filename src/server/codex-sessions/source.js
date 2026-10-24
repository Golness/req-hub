import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve, relative, isAbsolute, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexTranscript } from './transcript.js';

export const codexError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export const canonicalPath = value => String(value || '').replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '').replace(/^([A-Z]):/, (_, drive) => drive.toLowerCase() + ':');
const keyPath = path => /^[a-z]:\//i.test(canonicalPath(path)) ? canonicalPath(path).toLowerCase() : canonicalPath(path);
const beneath = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel); };
const projectId = path => 'root:' + createHash('sha256').update(keyPath(path)).digest('hex').slice(0, 24);
const label = path => canonicalPath(path).split('/').at(-1) || path;
const timestamp = value => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value) || 0;
const subagent = source => typeof source === 'object' ? !!source?.subagent : /subagent|sub_agent/i.test(String(source || ''));
const sessionTitle = (...candidates) => candidates.find(value => typeof value === 'string' && value.trim())?.trim();

async function readTitles(home, warnings) {
  const titles = new Map();
  try {
    for (const raw of (await readFile(join(home, 'session_index.jsonl'), 'utf8')).split('\n')) {
      try { const item = JSON.parse(raw); if (item.id) titles.set(item.id, item); } catch { /* Skip a partial index record. */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') warnings.push('Codex 标题索引不可读：' + error.message); }
  return titles;
}

async function safeEntries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function walk(path, out) {
  for (const entry of await safeEntries(path)) {
    if (entry.isDirectory()) await walk(join(path, entry.name), out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(join(path, entry.name));
  }
}

/** Metadata prefix reading and session_index titles follow dsh-codex-migrate's inventory approach. */
async function prefixInfo(path) {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(256 * 1024);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    let meta, root;
    for (const line of bytes.subarray(0, bytesRead).toString('utf8').split('\n')) {
      try {
        const record = JSON.parse(line);
        if (record.type === 'session_meta') meta = record.payload;
        if (record.type === 'turn_context' && record.payload.workspace_roots?.[0]) root ||= record.payload.workspace_roots[0];
      } catch { /* A prefix can end in a partial line. */ }
    }
    if (!meta?.id && !meta?.session_id) throw codexError('CODEX_METADATA_INVALID: 无法读取 Codex 会话标识');
    return { ...meta, root: root || meta.workspace_root || meta.cwd };
  } finally { await file.close(); }
}

export class CodexSource {
  constructor(home) { this.home = resolve(home); }
  async inventory() {
    const entries = await safeEntries(this.home);
    if (!entries.length) return { workspaces: [], sessions: [], warnings: ['未找到本机 Codex 会话目录，请检查 CODEX_HOME 或 ~/.codex。'] };
    const databases = entries.filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name)).sort((a, b) => Number(b.name.match(/\d+/)[0]) - Number(a.name.match(/\d+/)[0]));
    const sessions = [], workspaces = new Map(), warnings = [];
    const titles = await readTitles(this.home, warnings);
    const addWorkspace = (id, title, paths) => {
      const workspace = { id, title, paths: paths.filter(Boolean), path: paths.filter(Boolean).join(' · '), sessionCount: 0 };
      workspaces.set(id, workspace); return workspace;
    };
    if (databases.length) {
      let db;
      try {
        db = new DatabaseSync(join(this.home, databases[0].name), { readOnly: true });
        db.exec('PRAGMA busy_timeout=3000;');
        const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
        if (!['id', 'cwd', 'rollout_path', 'archived'].every(column => columns.has(column))) throw Error('不支持的 threads 表结构');
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        if (tables.has('projects') && tables.has('project_roots')) {
          const roots = db.prepare('SELECT project_id,path FROM project_roots ORDER BY position').all();
          for (const project of db.prepare('SELECT id,name FROM projects').all()) addWorkspace('project:' + project.id, project.name || project.id, roots.filter(root => root.project_id === project.id).map(root => root.path));
        }
        const optional = ['name', 'title', 'source', 'thread_source', 'created_at', 'created_at_ms', 'updated_at', 'updated_at_ms', 'project_id'].filter(column => columns.has(column));
        for (const row of db.prepare(`SELECT id,cwd,rollout_path,${optional.length ? optional.join(',') + ',' : ''}archived FROM threads WHERE archived=0`).all()) {
          if (subagent(row.source) || subagent(row.thread_source)) continue;
          let workspace = row.project_id && workspaces.get('project:' + row.project_id);
          workspace ||= [...workspaces.values()].filter(project => project.paths.some(root => keyPath(row.cwd) === keyPath(root) || keyPath(row.cwd).startsWith(keyPath(root) + '/'))).sort((a, b) => Math.max(...b.paths.map(root => root.length)) - Math.max(...a.paths.map(root => root.length)))[0];
          if (!workspace) workspace = workspaces.get(projectId(row.cwd)) || addWorkspace(projectId(row.cwd), label(row.cwd) || '无工作区', [row.cwd]);
          const rolloutPath = canonicalPath(row.rollout_path);
          const sourcePath = isAbsolute(rolloutPath) ? rolloutPath : resolve(this.home, rolloutPath);
          if (!beneath(resolve(this.home, 'sessions'), resolve(sourcePath))) continue;
          sessions.push({ nativeId: row.id, id: 'codex:' + row.id, workspaceId: workspace.id, sourcePath,
            // Desktop names are separate from title, which can contain the initial user prompt.
            title: sessionTitle(row.name, titles.get(row.id)?.thread_name, row.title) || row.id, cwd: row.cwd, createdAt: timestamp(row.created_at_ms || row.created_at), updatedAt: timestamp(row.updated_at_ms || row.updated_at) });
          workspace.sessionCount++;
        }
      } catch (error) { throw codexError('CODEX_DATABASE_READ_FAILED: 无法读取 Codex 会话目录：' + error.message, 503); }
      finally { db?.close(); }
    } else {
      const files = []; await walk(join(this.home, 'sessions'), files);
      for (const file of files) {
        try {
          const meta = await prefixInfo(file);
          if (meta.archived || subagent(meta.thread_source) || subagent(meta.source)) continue;
          const nativeId = meta.session_id || meta.id;
          const workspace = workspaces.get(projectId(meta.root)) || addWorkspace(projectId(meta.root), label(meta.root) || '无工作区', [meta.root]);
          const details = await stat(file), title = titles.get(nativeId);
          sessions.push({ nativeId, id: 'codex:' + nativeId, workspaceId: workspace.id, sourcePath: file, title: sessionTitle(title?.thread_name) || nativeId,
            cwd: meta.cwd || meta.root, createdAt: timestamp(meta.timestamp), updatedAt: timestamp(title?.updated_at) || details.mtimeMs });
          workspace.sessionCount++;
        } catch (error) { warnings.push(`${basename(file)}：${error.message}`); }
      }
    }
    return { workspaces: [...workspaces.values()].sort((a, b) => a.title.localeCompare(b.title)), sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), warnings };
  }

  async snapshot(session) {
    const root = await realpath(join(this.home, 'sessions'));
    const path = await realpath(session.sourcePath);
    if (!beneath(root, path)) throw codexError('CODEX_SOURCE_INVALID: 会话文件不在 Codex 活跃会话目录内');
    const before = await stat(path), parser = createCodexTranscript(session.id);
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let metaId, archived = false, malformed = 0;
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { malformed++; continue; }
        if (record.type === 'session_meta') { metaId = record.payload?.session_id || record.payload?.id; archived ||= !!record.payload?.archived; }
        parser.push(record);
      }
    } finally { lines.close(); stream.destroy(); }
    const after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw codexError('CODEX_SESSION_CHANGING: 会话正在写入，请稍后刷新', 409);
    if (malformed) throw codexError('CODEX_SESSION_INVALID: 会话 JSONL 包含损坏或尚未写完的记录，请稍后刷新', 409);
    if (metaId !== session.nativeId || archived) throw codexError('CODEX_SOURCE_INVALID: 会话标识不符或已归档', 409);
    return parser.finish();
  }
}
