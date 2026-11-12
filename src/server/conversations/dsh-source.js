import { resolve } from 'node:path';
import { listRelatedSessions } from '../session-selector.js';
import { readSessionSnapshot } from '../session-utils.js';

/**
 * Adapt Host workspaces and sessions to the conversation source interface.
 * @param options - Workspace, session and source-instance services.
 * @returns A source adapter with inventory and snapshot operations.
 */
export function dshSource({ registry, sessionQuery, sessions, instance }) {
  return {
    source: 'dsh',
    instance,
    async inventory(projectId, { signal } = {}) {
      signal?.throwIfAborted();
      // Host workspaces are entities: path/title live on prototype getters.
      // Materialize only the public metadata, never spread service internals.
      const workspaces = registry
        .list()
        .filter((workspace) => !projectId || workspace.id === projectId)
        .map((workspace) => ({
          id: workspace.id,
          path: workspace.path,
          title: workspace.title,
          paths: [resolve(workspace.path)],
        }));
      const all = [];
      const seen = new Set();
      const warnings = [];
      // Nested roots share Host sessions. Global acquisition assigns each to the deepest root.
      const ordered = [...workspaces].sort((a, b) => b.paths[0].length - a.paths[0].length);
      for (const workspace of ordered) {
        signal?.throwIfAborted();
        let rows;
        try {
          rows = await listRelatedSessions(sessions, workspace.path, {
            limit: Number.MAX_SAFE_INTEGER,
            sessionQuery,
            registry,
            metadataOnly: true,
            strict: true,
            signal,
          });
        } catch (error) {
          signal?.throwIfAborted();
          // A workspace with unreadable sessions must not hide sessions owned
          // by other workspaces during a background cross-workspace batch.
          warnings.push(`${workspace.id}: ${error?.message || error}`);
          continue;
        }
        for (const row of rows) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            all.push({ ...row, workspaceId: workspace.id });
          }
        }
      }
      return { workspaces, sessions: all, warnings };
    },
    async snapshot(session, { signal } = {}) {
      signal?.throwIfAborted();
      if (registry.archivedSessionIds?.includes(session.id)) {
        throw new Error('SESSION_ARCHIVED');
      }
      const snapshot = await readSessionSnapshot(sessionQuery, session.id, sessions);
      signal?.throwIfAborted();
      if (registry.archivedSessionIds?.includes(session.id)) {
        throw new Error('SESSION_ARCHIVED');
      }
      return snapshot;
    },
  };
}
