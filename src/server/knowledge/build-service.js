import { resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { KnowledgeStore } from './store.js';
import { defaultKnowledgeDatabasePath } from './storage-path.js';
import { hash, readSource, normalizeSourcePath, knowledgeError, inside, MAX_BUILD_FILES } from './source-reader.js';
export const INGESTION_VERSION = 'full-document-v2';
const RUNNING = new Set(['queued', 'running', 'cancelling']);

export class KnowledgeService {
  constructor({ registry, configLoader, readSourceFile = readSource, databasePath = defaultKnowledgeDatabasePath() }) {
    Object.assign(this, { registry, configLoader, readSourceFile, databasePath });
    this.stores = new Map(); this.controllers = new Map(); this.tasks = new Set(); this.locks = new Map(); this.sourceCache = new Map(); this.closed = false;
  }

  database() {
    if (this.closed) throw knowledgeError('知识库服务已关闭', 503);
    if (!this.store) this.store = new KnowledgeStore(this.databasePath);
    return this.store;
  }

  async scope(workspaceId) {
    if (this.closed) throw knowledgeError('知识库服务已关闭', 503);
    const workspace = this.registry.list().find(w => w.id === workspaceId);
    if (!workspace) throw knowledgeError('工作区不存在', 404);
    const config = await this.configLoader();
    const workspaceRoot = await realpath(workspace.path);
    // docsRoot may be configured outside the workspace; selected sources still stay within it.
    const configuredRoot = resolve(workspaceRoot, config.docsDir || 'docs');
    let docsRoot;
    try { docsRoot = await realpath(configuredRoot); }
    catch (error) { if (error.code !== 'ENOENT') throw error; docsRoot = configuredRoot; }
    const identity = JSON.stringify([workspaceId, workspaceRoot, docsRoot]);
    let store = this.stores.get(identity);
    if (!store) {
      store = this.database().scoped(identity, workspace, workspaceRoot, docsRoot);
      this.stores.set(identity, store);
    }
    return { workspace, workspaceId, docsRoot, config, store, identity };
  }

  async withLock(key, callback) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try { return await callback(); }
    finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }

  async searchAll(query = '', limit = 20) {
    const database = this.database(), warnings = [];
    for (const origin of database.scopes()) {
      try {
        const scope = { identity: origin.id, docsRoot: origin.docs_root, store: database.scoped(origin.id, { id: origin.workspace_id, title: origin.workspace_title }, origin.workspace_root, origin.docs_root) };
        await this.refreshSources(scope);
      } catch (error) {
        if (this.closed) throw error;
        warnings.push({ workspaceId: origin.workspace_id, workspaceTitle: origin.workspace_title, message: error.message });
      }
    }
    return { ...database.search(query, limit), warnings };
  }

  async build(scope, input) {
    return this.withLock(scope.workspaceId, async () => {
      if (this.closed) throw knowledgeError('知识库服务已关闭', 503);
      if (!Array.isArray(input.files) || !input.files.length) throw knowledgeError('请先选择文件');
      if (input.files.length > MAX_BUILD_FILES) throw knowledgeError(`每次最多分析 ${MAX_BUILD_FILES} 个文件`, 413);
      if (typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 128) throw knowledgeError('缺少有效的 requestKey');
      const paths = [...new Set(input.files.map(f => normalizeSourcePath(f?.relativePath)))].sort();
      const fingerprint = hash(INGESTION_VERSION);
      const requestFingerprint = hash(JSON.stringify([paths, fingerprint]));
      const existing = scope.store.request(input.requestKey);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) throw knowledgeError('requestKey 已用于另一份文件清单', 409);
        return { job: existing, duplicate: true };
      }
      if ([...this.controllers.values()].some(c => c.workspaceId === scope.workspaceId) || scope.store.jobs().some(j => RUNNING.has(j.status))) throw knowledgeError('该工作区已有分析任务', 409);
      const files = [];
      for (const path of paths) {
        try { const source = await this.readSourceFile(scope.docsRoot, path); files.push({ relativePath: path, sourceHash: source.contentHash, status: 'pending' }); }
        catch (e) { files.push({ relativePath: path, status: 'failed', error: e.message }); }
      }
      const job = { id: randomUUID(), ingestionMode: 'full-document', workspaceId: scope.workspaceId, requestKey: input.requestKey, requestFingerprint, fingerprint, createdAt: new Date().toISOString(), status: 'queued', files };
      scope.store.saveJob(job);
      const controller = new AbortController();
      this.controllers.set(job.id, { controller, workspaceId: scope.workspaceId });
      const task = this.run(scope, job, controller.signal).catch(error => {
        job.status = 'failed'; job.error = error.message;
        for (const file of job.files) if (['pending', 'running'].includes(file.status)) { file.status = 'failed'; file.error = error.message; }
        scope.store.saveJob(job);
      }).finally(() => { this.controllers.delete(job.id); this.tasks.delete(task); });
      this.tasks.add(task);
      return { job: scope.store.job(job.id), duplicate: false };
    });
  }

  async run(scope, job, signal) {
    const save = () => scope.store.saveJob(job);
    job.status = 'running'; save();
    for (const file of job.files) {
      if (file.status === 'failed') continue;
      if (signal.aborted) { file.status = 'cancelled'; save(); continue; }
      file.status = 'running'; save();
      try {
        const source = await this.readSourceFile(scope.docsRoot, file.relativePath);
        if (source.contentHash !== file.sourceHash) { file.status = 'stale'; file.error = '文件已改变，请重新分析'; save(); continue; }
        const previous = scope.store.source(source.relativePath);
        if (previous?.hash === source.contentHash && previous.fingerprint === job.fingerprint && previous.status === 'active') { file.status = 'skipped'; file.reason = '文件内容与解析版本未改变'; save(); continue; }
        signal.throwIfAborted();
        const fresh = await this.readSourceFile(scope.docsRoot, source.relativePath);
        if (fresh.contentHash !== source.contentHash) { file.status = 'stale'; file.error = '分析期间文件已更新，未发布旧内容'; save(); continue; }
        signal.throwIfAborted();
        Object.assign(file, scope.store.publishDocument(source, job.fingerprint));
        file.status = source.text.trim() ? 'completed' : 'skipped';
        if (!source.text.trim()) file.reason = '文件无可检索正文';
      } catch (error) { file.status = signal.aborted ? 'cancelled' : 'failed'; file.error = signal.aborted ? '任务已取消' : error.message; }
      save();
    }
    job.status = signal.aborted ? 'cancelled' : job.files.some(f => ['failed', 'stale'].includes(f.status)) ? 'partial' : 'completed'; save();
  }

  cancel(scope, id) {
    const job = scope.store.job(id);
    if (!job) throw knowledgeError('任务不存在', 404);
    if (RUNNING.has(job.status)) {
      this.controllers.get(id)?.controller.abort(new Error('用户取消'));
      job.status = 'cancelling'; scope.store.saveJob(job);
    }
    return scope.store.job(id);
  }

  async refreshSources(scope) {
    for (const { path, hash: expectedHash, status } of scope.store.sources()) {
      try {
        const resolvedPath = await realpath(resolve(scope.docsRoot, path));
        if (!inside(scope.docsRoot, resolvedPath)) throw knowledgeError('来源路径越界');
        const info = await stat(resolvedPath);
        const signature = `${resolvedPath}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        const key = `${scope.identity}:${path}`;
        let cached = this.sourceCache.get(key);
        if (!cached || cached.signature !== signature) {
          const source = await readSource(scope.docsRoot, path);
          cached = { signature, hash: source.contentHash }; this.sourceCache.set(key, cached);
        }
        const next = cached.hash === expectedHash ? 'active' : 'stale';
        if (next !== status) scope.store.setSourceStatus(path, next);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) scope.store.markMissing(path);
        // An unreadable or redirected source is retained for history, excluded from search.
        else scope.store.setSourceStatus(path, 'unavailable');
      }
    }
  }

  async close() {
    this.closed = true;
    for (const { controller } of this.controllers.values()) controller.abort(new Error('插件卸载'));
    await Promise.allSettled([...this.tasks]);
    this.store?.close();
    this.stores.clear();
  }
}
