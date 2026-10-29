import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bounded, digest, fail } from './contracts.js';

const git = promisify(execFile);
const pathKey = value => process.platform === 'win32' ? value.toLowerCase().replaceAll('\\', '/') : value;
export async function codeSnapshot(root, signal) {
  const options = { cwd: root, signal, maxBuffer: 1_000_000, windowsHide: true };
  const head = (await git('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
  const dirty = (await git('git', ['status', '--porcelain', '--untracked-files=normal'], options)).stdout.trim();
  return { head, dirty: !!dirty };
}
/** Code queries use policy-mediated MCP calls; manual CLI indexing is owned by index-runner. */
export class CodeProvider {
  constructor(ctx) { this.ctx = ctx; }
  async call(server, raw, args, signal, agent) {
    const name = `mcp__${server}__${raw}`;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(server) || !this.ctx.tools?.get?.(name, agent) || !this.ctx.tools?.execute) fail('ENHANCEMENT_CODE_PROVIDER_UNAVAILABLE', 503);
    const result = await this.ctx.tools.execute({ callId: randomUUID(), name, arguments: args, signal, ...(agent ? { agent } : {}) });
    signal.throwIfAborted();
    if (result.isError) fail('ENHANCEMENT_CODE_PROVIDER_UNAVAILABLE', 503, {
      tool: name, hostCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(result.error?.info?.code || '') ? result.error.info.code : 'MCP_CALL_FAILED',
    });
    const payload = bounded(result.value, 1_000_000);
    if (!payload || !Array.isArray(payload.content)) fail('ENHANCEMENT_PROVIDER_SCHEMA', 422);
    if (payload.structuredContent !== undefined) return payload.structuredContent;
    const text = payload.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    // GitNexus appends a human-facing next-step hint after its JSON body.
    const json = text.split(/\n---\s*\n/)[0].trim();
    try { return JSON.parse(json); } catch { fail('ENHANCEMENT_PROVIDER_SCHEMA', 422); }
  }
  async repositories(server, signal, agent) {
    const repos = []; let offset = 0, total;
    for (let page = 0; page < 1000; page++) {
      signal.throwIfAborted();
      const response = await this.call(server, 'list_repos', offset ? { offset } : {}, signal, agent);
      const entries = Array.isArray(response) ? response : response?.repositories;
      if (!Array.isArray(entries) || entries.some(repo => !repo || typeof repo.name !== 'string' || typeof repo.path !== 'string')) fail('ENHANCEMENT_PROVIDER_SCHEMA', 422, { phase: 'repositories' });
      repos.push(...entries);
      if (repos.length > 1000) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
      bounded(repos, 1_000_000);
      // Older MCP servers return the entire registry as an array.
      if (Array.isArray(response)) {
        if (offset) fail('ENHANCEMENT_PROVIDER_SCHEMA', 422);
        return repos;
      }
      const pagination = response.pagination;
      if (!pagination || typeof pagination.hasMore !== 'boolean' || !Number.isSafeInteger(pagination.total) || pagination.total < 0 ||
          pagination.offset !== offset || pagination.returned !== entries.length ||
          total !== undefined && total !== pagination.total || offset + entries.length > pagination.total) fail('ENHANCEMENT_PROVIDER_SCHEMA', 422, { phase: 'pagination' });
      total = pagination.total;
      if (total > 1000) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
      if (!pagination.hasMore) {
        if (offset + entries.length !== total) fail('ENHANCEMENT_PROVIDER_SCHEMA', 422, { phase: 'pagination' });
        return repos;
      }
      if (!entries.length || !Number.isSafeInteger(pagination.nextOffset) || pagination.nextOffset !== offset + entries.length || pagination.nextOffset >= total) fail('ENHANCEMENT_PROVIDER_SCHEMA', 422, { phase: 'pagination' });
      offset = pagination.nextOffset;
    }
    fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
  }
  async refresh(scope, graph, settings, signal, agent, progress) {
    try {
      progress({ stage: 'mcp_status' });
      const before = await codeSnapshot(scope.workspace.path, signal);
      const repos = await this.repositories(settings.gitnexusServer, signal, agent);
      let repo;
      for (const item of repos) {
        if (typeof item.path !== 'string') continue;
        const resolved = await realpath(item.path).catch(() => null);
        if (resolved && pathKey(resolved) === pathKey(await realpath(scope.workspace.path))) repo = item;
      }
      if (!repo) { graph.code = { status: 'not_indexed' }; return; }
      graph.code = { status: 'ready', indexedAt: repo.indexedAt, lastCommit: repo.lastCommit, snapshot: before, provider: settings.gitnexusServer };
      if (!repo.lastCommit || before.dirty || repo.lastCommit !== before.head || Number(repo.staleness?.commitsBehind || 0) > 0) { graph.code.status = 'stale'; return; }
      const paths = [...new Set(graph.references.filter(ref => ref.kind !== 'example').map(ref => ref.path))];
      if (paths.length > settings.maxCodeQueries) graph.code.status = 'partial';
      for (const [index, path] of paths.slice(0, settings.maxCodeQueries).entries()) {
        signal.throwIfAborted(); progress({ stage: 'mcp_query', completed: index, total: Math.min(paths.length, settings.maxCodeQueries) });
        if (isAbsolute(path) || path.split('/').includes('..')) continue;
        const root = await realpath(scope.workspace.path), file = await realpath(new URL(path, 'file:///' + root.replaceAll('\\', '/') + '/')).catch(() => null);
        if (!file) continue;
        const rel = relative(root, file); if (rel.startsWith('..') || isAbsolute(rel)) continue;
        const data = await this.call(settings.gitnexusServer, 'impact', { target: path, direction: 'downstream', maxDepth: 1, repo: repo.name }, signal, agent);
        if (data.status === 'ambiguous') { graph.code.status = 'partial'; continue; }
        if (!data.byDepth || typeof data.byDepth !== 'object') fail('ENHANCEMENT_PROVIDER_SCHEMA', 422);
        const hits = Object.values(data.byDepth).flat();
        for (const hit of hits) {
          if (!hit || typeof hit.filePath !== 'string' || hit.filePath.startsWith('/') || hit.filePath.includes('..') || /[A-Za-z]:/.test(hit.filePath)) continue;
          const targets = graph.references.filter(ref => ref.path === hit.filePath.replaceAll('\\', '/') && ref.kind !== 'example');
          for (const a of graph.references.filter(ref => ref.path === path)) for (const b of targets) {
            if (a.entityId === b.entityId) continue;
            const key = digest([scope.identity, a.entityId, b.entityId, 'code_related']);
            if (graph.relations.some(r => r.key === key)) continue;
            graph.relations.push({ id: key, key, sourceId: a.entityId, targetId: b.entityId, type: 'code_related', validity: 'valid', reviewState: 'candidate',
              basisHash: digest([a, b, repo.lastCommit, repo.indexedAt]), evidence: [{ referenceIds: [a.id, b.id], codePaths: [path, b.path], provider: settings.gitnexusServer, snapshot: before.head, indexedAt: repo.indexedAt, relationType: hit.relationType, confidence: hit.confidence, coverage: 'impact_candidate' }] });
            if (graph.relations.length > settings.maxEdges) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
          }
        }
      }
      if (JSON.stringify(await codeSnapshot(scope.workspace.path, signal)) !== JSON.stringify(before)) graph.code.status = 'stale';
      if (graph.code.status === 'stale') for (const relation of graph.relations.filter(r => r.type === 'code_related')) relation.validity = 'stale';
    } catch (error) {
      if (signal.aborted) throw error;
      graph.relations = graph.relations.filter(r => r.type !== 'code_related');
      graph.code = { status: 'unavailable', error: { code: /^ENHANCEMENT_/.test(error.message) ? error.message : 'ENHANCEMENT_CODE_PROVIDER_UNAVAILABLE', details: error.details || {} } };
    }
  }
}
