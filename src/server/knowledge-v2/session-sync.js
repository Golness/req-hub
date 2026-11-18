import { realpath } from 'node:fs/promises';
import { describeTurns, sessionMessages } from './session-export.js';
import { messageDescriptor } from '../messages.js';

const MAX_SESSIONS_PER_RUN = 20;

const pathKey = (value) =>
  process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;

/** Freeze and import sessions for an explicit workspace, independently of page or Agent state. */
export class SessionSync {
  constructor({ application, conversations }) {
    this.application = application;
    this.conversations = conversations;
  }

  /**
   * Import at most 20 visible sessions whose real paths match the destination workspace.
   * @param store - Resolved V2 scope store for the target workspace.
   * @param options - Cancellation and per-session progress callbacks.
   * @returns Saved, skipped and failed counts; successful imports survive partial failures.
   */
  async run(store, { signal, report = () => {}, onItem = () => {} }) {
    const { library, adapters } = this.conversations || {};
    const counts = { sessions: 0, saved: 0, skipped: 0, failed: 0 };
    const sourceIds = new Set();
    if (!library || !adapters?.length) {
      return { ...counts, sourceIds: [] };
    }
    const warn = (diagnostic) => {
      const text = String(diagnostic).slice(0, 4000);
      report({
        source: 'session-sync',
        sessionId: null,
        code: 'KB_SESSION_IMPORT_WARNING',
        diagnostic: text,
      });
      onItem({ kind: 'session', source: 'session-sync', status: 'warning', error: text });
    };
    let destination;
    try {
      destination = await realpath(store.scope.workspace.path);
    } catch (error) {
      signal?.throwIfAborted();
      // An unreachable target workspace only skips session import; file
      // synchronization for the same run must still complete.
      warn(error?.message || error);
      return { ...counts, sourceIds: [] };
    }
    const destinationKey = pathKey(destination);
    const fail = (source, error, session = null, origin = null) => {
      signal?.throwIfAborted();
      if (error?.code === 'CODEX_SOURCE_FILE_MISSING') {
        counts.skipped++;
        onItem({
          kind: 'session',
          source,
          sessionId: session?.id || null,
          status: 'skipped',
          reason: error.code,
        });
        return;
      }
      counts.failed++;
      const diagnostic = String(error?.message || error);
      report({
        source,
        sessionId: session?.id || null,
        code: 'KB_SESSION_IMPORT_FAILED',
        diagnostic: diagnostic.slice(0, 4000),
      });
      onItem({
        kind: 'session',
        source,
        sessionId: session?.id || null,
        title: session?.title,
        originWorkspace: origin?.title || origin?.id,
        status: 'failed',
        error: diagnostic,
      });
    };
    try {
      await library.ready();
    } catch (error) {
      signal?.throwIfAborted();
      warn(error?.message || error);
      return { ...counts, sourceIds: [] };
    }
    for (const adapter of adapters) {
      if (counts.sessions >= MAX_SESSIONS_PER_RUN) {
        break;
      }
      signal?.throwIfAborted();
      let inventory;
      try {
        // Ask the adapter for the target workspace only. A failure or an
        // unreadable session list from another workspace must not stop this run.
        inventory = await adapter.inventory(store.scope.workspaceId, { signal });
        // Inventory warnings are diagnostics only; they must not mark the run failed.
        for (const warning of inventory.warnings || []) {
          const diagnostic = String(warning).slice(0, 4000);
          report({
            source: adapter.source,
            sessionId: null,
            code: 'KB_SESSION_IMPORT_WARNING',
            diagnostic,
          });
          onItem({
            kind: 'session',
            source: adapter.source,
            sessionId: null,
            status: 'warning',
            reason: messageDescriptor(warning),
          });
        }
      } catch (error) {
        fail(adapter.source, error);
        continue;
      }
      for (const origin of inventory.workspaces || []) {
        const candidates = (origin.paths || [origin.path]).filter(Boolean);
        const paths = await Promise.all(candidates.map((path) => realpath(path).catch(() => null)));
        signal?.throwIfAborted();
        if (!paths.some((path) => path && pathKey(path) === destinationKey)) {
          continue;
        }
        let sourceScope;
        try {
          sourceScope = await library.store.scope(adapter.source, adapter.instance, origin);
          await library.store.allow(library.owner, store.scope.workspaceId, sourceScope);
        } catch (error) {
          // Session-library authorization is scoped to this origin; a failure
          // here must not abort the remaining origins or workspaces.
          fail(adapter.source, error, null, origin);
          continue;
        }
        const sessions = (inventory.sessions || []).filter(
          (entry) => entry.workspaceId === origin.id,
        );
        for (const session of sessions) {
          if (counts.sessions >= MAX_SESSIONS_PER_RUN) {
            break;
          }
          signal?.throwIfAborted();
          const cwd = session.cwd && (await realpath(session.cwd).catch(() => null));
          if (!cwd || pathKey(cwd) !== destinationKey) {
            continue;
          }
          counts.sessions++;
          try {
            const details = {
              ...session,
              source: adapter.source,
              isPersisted: true,
              importedAt: new Date().toISOString(),
            };
            delete details.sourcePath;
            delete details.nativeId;
            const captured = library.capture
              ? await library.capture({
                  workspaceId: store.scope.workspaceId,
                  scope: sourceScope,
                  adapter,
                  session,
                  details,
                  signal,
                })
              : null;
            const snapshot = captured?.snapshot || (await adapter.snapshot(session, { signal }));
            if (captured?.exportError) {
              fail(adapter.source, new Error(captured.exportError), session, origin);
              continue;
            }
            signal?.throwIfAborted();
            // Legacy snapshots may store userInput/summary instead of messages.
            // Normalize before selecting so an old turn cannot abort the batch.
            const turns = describeTurns(snapshot).filter(
              (item) => sessionMessages(item.turn).length > 0,
            );
            if (!turns.length) {
              counts.skipped++;
              onItem({
                kind: 'session',
                source: adapter.source,
                sessionId: session.id,
                title: session.title,
                originWorkspace: origin.title || origin.id,
                status: 'skipped',
              });
              continue;
            }
            const frozen =
              captured?.stored ||
              (await library.store.put(sourceScope, details, snapshot, { signal }));
            signal?.throwIfAborted();
            const result = await this.application.importSessions(store, {
              selections: [
                {
                  id: frozen.conversationId,
                  version: snapshot.version,
                  turnKeys: turns.map((turn) => turn.key),
                },
              ],
              mode: 'merge',
              ingest: false,
              signal,
            });
            counts.saved += result.saved;
            counts.skipped += result.skipped;
            for (const item of result.results) {
              if (['saved', 'skipped'].includes(item.status) && item.sourceId) {
                sourceIds.add(item.sourceId);
              }
              onItem({
                kind: 'session',
                source: adapter.source,
                sessionId: session.id,
                title: session.title,
                originWorkspace: origin.title || origin.id,
                status: item.status === 'saved' ? 'completed' : 'skipped',
                documentIds: [item.sourceId],
              });
            }
          } catch (error) {
            fail(adapter.source, error, session, origin);
          }
        }
      }
    }
    signal?.throwIfAborted();
    return { ...counts, sourceIds: [...sourceIds] };
  }
}

/** Run one background session batch through the application's configured conversation library. */
export async function syncWorkspaceSessions(application, store, options = {}) {
  const sync = new SessionSync({ application, conversations: application.conversations });
  return sync.run(store, options);
}
