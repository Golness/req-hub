import { json, readBody } from '../utils.js';
import { conversationError, hash } from '../conversations/store.js';
import { withDocumentLock } from '../sync-document-validator.js';
import { describeTurns, matchingTurn, importConversationBatch, MAX_IMPORT_BYTES } from '../knowledge/conversation-import.js';
import { matchesWorkspacePath } from '../conversations/workspace-path.js';

/** Source workspace is provenance, never a destination knowledge namespace. */
export function createConversationKnowledgeRoutes(registry, library, adapters, knowledge) {
  if (!knowledge) return [];
  const available = async workspace => {
    await library.ready();
    const db = await library.store.database(), ids = new Set();
    for (const row of db.prepare('SELECT scope FROM scope_access WHERE owner=?').all(library.owner)) ids.add(row.scope);
    const result = [];
    for (const id of ids) {
      const scope = db.prepare('SELECT * FROM scopes WHERE id=?').get(id);
      if (!scope || !adapters.some(adapter => adapter.source === scope.source && adapter.instance === scope.instance)) continue;
      const origin = JSON.parse(scope.payload);
      if (workspace && scope.source !== 'codex' && !matchesWorkspacePath(origin, workspace.path)) continue;
      for (const entry of await library.store.list(id)) {
        if (workspace && scope.source === 'codex' && !matchesWorkspacePath({ path: entry.cwd }, workspace.path)) continue;
        const versions = await library.store.versions(entry.conversationId);
        if (!versions.length) continue;
        result.push({ ...entry, source: scope.source, snapshotVersion: entry.snapshotVersion || versions[0].version, sourceScopeId: id,
          sourceWorkspaceId: scope.project, sourceWorkspaceTitle: origin.title || scope.project, sourceWorkspacePaths: origin.paths || [origin.path].filter(Boolean), sourceInstanceId: hash(scope.instance) });
      }
    }
    return result;
  };
  return ['options', 'detail', 'import'].map(action => ({
    kind: 'exact', path: '/req-hub/conversations-knowledge-' + action,
    async handler(req, res) {
      if (req.method !== (action === 'import' ? 'POST' : 'GET')) return json(res, { error: 'METHOD_NOT_ALLOWED' }, 405);
      try {
        let input;
        try { input = req.method === 'POST' ? JSON.parse(await readBody(req)) : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams); }
        catch { throw conversationError('KNOWLEDGE_SELECTION_INVALID', 400); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw conversationError('KNOWLEDGE_SELECTION_INVALID', 400);
        const workspace = input.workspaceId ? registry.list().find(item => item.id === input.workspaceId) : null;
        if (input.workspaceId && !workspace) throw conversationError('WORKSPACE_MISSING', 404);
        if (workspace && action !== 'options' && input.targetWorkspaceId !== workspace.id) throw conversationError('KNOWLEDGE_TARGET_REQUIRED', 400);
        const entries = await available(workspace);
        if (action === 'options') return json(res, workspace
          ? { sessions: entries, workspace: { id: workspace.id, title: workspace.title || workspace.id, path: workspace.path } }
          : { sessions: entries, targets: registry.list().map(workspace => ({ id: workspace.id, title: workspace.title || workspace.id, path: workspace.path })) });
        const target = registry.list().find(workspace => workspace.id === input.targetWorkspaceId);
        if (!target) throw conversationError('KNOWLEDGE_TARGET_REQUIRED', 400);
        const scope = await knowledge.scope(target.id);
        if (action === 'detail') {
          const entry = entries.find(item => item.conversationId === input.id);
          if (!entry) throw conversationError('SESSION_MISSING', 404);
          const snapshot = await library.store.project(entry.conversationId, input.version || entry.snapshotVersion);
          const imported = scope.store.db.prepare('SELECT payload FROM conversation_imports WHERE scope_id=? AND conversation_id=?').get(scope.identity, entry.conversationId);
          const prior = imported ? JSON.parse(imported.payload).turns : [];
          const turns = describeTurns(snapshot).map(item => {
            let existing, ambiguous = false;
            try { existing = matchingTurn(prior, item); } catch { ambiguous = true; }
            const conflict = ambiguous || existing && entry.source === 'codex' && item.key.startsWith('number:') && existing.anchor !== item.anchor;
            return { ...item, importable: !conflict, knowledgeState: conflict ? 'conflict' : !existing ? 'new' : existing.hash === item.hash && existing.key === item.key ? 'same' : 'changed' };
          });
          return json(res, { entry, version: snapshot.version, versions: await library.store.versions(entry.conversationId), turns });
        }
        if (!Array.isArray(input.selections) || !input.selections.length || input.selections.length > 100) throw conversationError('KNOWLEDGE_SELECTION_INVALID', 400);
        if (new Set(input.selections.map(item => item?.id)).size !== input.selections.length) throw conversationError('KNOWLEDGE_SELECTION_INVALID', 400);
        const result = await withDocumentLock(library.store.path, () => knowledge.withLock(target.id, async () => {
          if (knowledge.closed || library.closed) throw conversationError('SESSION_SERVICE_CLOSED', 503);
          const selections = []; let bytes = 0, turnCount = 0;
          for (const selected of input.selections) {
            const entry = entries.find(item => item.conversationId === selected?.id);
            if (!entry || typeof selected.version !== 'string' || !Array.isArray(selected.turnKeys) || !selected.turnKeys.length || new Set(selected.turnKeys).size !== selected.turnKeys.length) throw conversationError('KNOWLEDGE_SELECTION_INVALID', 400);
            const snapshot = await library.store.projectLocked(entry.conversationId, selected.version);
            const turns = describeTurns(snapshot).filter(turn => selected.turnKeys.includes(turn.key));
            if (turns.length !== selected.turnKeys.length || turns.some(item => !item.turn.messages.length)) throw conversationError('KNOWLEDGE_SELECTION_INVALID', 400);
            bytes += Buffer.byteLength(JSON.stringify(turns), 'utf8'); turnCount += turns.length;
            if (bytes > MAX_IMPORT_BYTES || turnCount > 1000) throw conversationError('KNOWLEDGE_IMPORT_TOO_LARGE', 413);
            selections.push({ id: entry.conversationId, title: entry.title, version: snapshot.version, turns,
              origin: { source: entry.source, sourceInstanceId: entry.sourceInstanceId, nativeSessionId: entry.id, sourceWorkspaceId: entry.sourceWorkspaceId, sourceWorkspaceTitle: entry.sourceWorkspaceTitle, sourceWorkspacePaths: entry.sourceWorkspacePaths } });
          }
          if (knowledge.closed || library.closed) throw conversationError('SESSION_SERVICE_CLOSED', 503);
          return importConversationBatch(scope.store, selections);
        }));
        json(res, { ...result, targetWorkspaceId: target.id, targetScopeId: scope.identity });
      } catch (error) { json(res, { error: error.message }, error.statusCode || error.status || 500); }
    },
  }));
}
