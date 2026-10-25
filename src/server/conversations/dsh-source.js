import { resolve } from 'node:path';
import { listRelatedSessions } from '../session-selector.js';
import { readSessionSnapshot } from '../session-utils.js';

export function dshSource({ registry, sessionQuery, sessions, instance }) {
  return {
    source: 'dsh', instance,
    async inventory(projectId) {
      // Host workspaces are entities: path/title live on prototype getters.
      // Materialize only the public metadata, never spread service internals.
      const workspaces = registry.list().filter(workspace => !projectId || workspace.id === projectId).map(workspace => ({
        id: workspace.id, path: workspace.path, title: workspace.title, paths: [resolve(workspace.path)],
      }));
      const all = [];
      for (const workspace of workspaces) {
        const rows = await listRelatedSessions(sessions, workspace.path, { limit: Number.MAX_SAFE_INTEGER, sessionQuery, registry, metadataOnly: true, strict: true });
        all.push(...rows.map(row => ({ ...row, workspaceId: workspace.id })));
      }
      return { workspaces, sessions: all, warnings: [] };
    },
    snapshot(session) { return readSessionSnapshot(sessionQuery, session.id, sessions); },
  };
}
