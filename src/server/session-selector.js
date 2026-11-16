import { msg } from './messages.js';
/**
 * Session selector module.
 * Responsible for listing and filtering DSH sessions related to current workspace.
 * @module session-selector
 */

import { log } from './logger.js';
import { readSessionSnapshot } from './session-utils.js';

async function syncDetails(sessionQuery, sessionId, sessions) {
  try {
    const snapshot = await readSessionSnapshot(sessionQuery, sessionId, sessions);
    return {
      turnCount: snapshot.turnCount,
      syncTurnCount: snapshot.syncTurnCount,
      snapshotVersion: snapshot.version,
    };
  } catch (error) {
    return { turnCount: null, syncTurnCount: 0, snapshotError: error.message };
  }
}

/**
 * @typedef {Object} SessionInfo
 * @property {string} id - Session ID
 * @property {string} title - Session title
 * @property {number} createdAt - Creation timestamp
 * @property {string} cwd - Working directory
 * @property {string|null} parentSession - Parent session ID if subagent
 * @property {boolean} isLive - Whether session is currently active
 * @property {boolean} isPersisted - Whether session is persisted to disk
 * @property {number|null} [turnCount] - Number of conversation turns
 * @property {number} [syncTurnCount] - Number of complete, syncable turns
 * @property {string} [snapshotVersion] - Hash of the previewed conversation projection
 */

/**
 * List DSH sessions related to current workspace.
 * Includes both active and persisted sessions.
 * @param {Object} sessions - DSH sessions service (for active sessions)
 * @param {string} workspacePath - Workspace path to filter by
 * @param {Object} [options={}] - Query options
 * @param {number} [options.limit=20] - Maximum results to return
 * @param {string} [options.query] - Search keyword filter
 * @param {Object} [options.sessionQuery] - DSH sessionQuery service (for persisted sessions)
 * @param {Object} [options.registry] - Workspace registry (for archived session IDs)
 * @param {AbortSignal} [options.signal] - Cancellation propagated to durable metadata queries.
 * @returns {Promise<SessionInfo[]>} Filtered session list sorted by creation time (desc)
 */
export async function listRelatedSessions(sessions, workspacePath, options = {}) {
  const { limit = 20, query, sessionQuery, registry } = options;

  const archivedIds = new Set(registry?.archivedSessionIds || []);

  if (sessionQuery) {
    try {
      const allRecords = await sessionQuery.listSessions(options.signal);
      options.signal?.throwIfAborted();

      const wsPath = workspacePath.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');

      // Apply the same workspace and archive filters to live-session fallback results.
      const filtered = allRecords.filter((record) => {
        if (archivedIds.has(record.header.id)) {
          return false;
        }
        const cwd = record.header.cwd || '';
        const sessionPath = cwd.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');

        const pathMatch = sessionPath === wsPath || sessionPath.startsWith(wsPath + '/');
        const isParentSession = !record.header.parentSession && record.header.origin !== 'subagent';
        return pathMatch && isParentSession;
      });

      const titlePromises = filtered
        .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0))
        .map(async (record) => {
          let title = 'STATUS_UNTITLED';
          try {
            const titleSnapshot = await sessionQuery.readTitle(record.header.id, options.signal);
            title = titleSnapshot?.title || 'STATUS_UNTITLED';
          } catch (e) {
            options.signal?.throwIfAborted();
            // Use the fallback title when its snapshot cannot be read.
          }

          return {
            id: record.header.id,
            title,
            createdAt: record.header.createdAt,
            cwd: record.header.cwd || '',
            parentSession: record.header.parentSession || null,
            isLive: record.live,
            isPersisted: record.persisted,
          };
        });

      const sessionsWithDetails = await Promise.all(titlePromises);

      sessionsWithDetails.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      log.session.info(msg('SESSION_FOUND_RELATED_VIA_QUERY', { v0: sessionsWithDetails.length }));
      return Promise.all(
        sessionsWithDetails
          .filter((session) => !query || session.title.toLowerCase().includes(query.toLowerCase()))
          .slice(0, limit)
          .map(async (session) => ({
            ...session,
            ...(options.metadataOnly ? {} : await syncDetails(sessionQuery, session.id, sessions)),
          })),
      );
    } catch (e) {
      options.signal?.throwIfAborted();
      if (options.strict) {
        throw e;
      }
      log.session.error(msg('SESSION_QUERY_LIST_FAILED', { v0: e.message }));
    }
  }

  if (!sessions) {
    log.session.warn('SESSION_SERVICES_UNAVAILABLE_LIST');
    return [];
  }

  try {
    const allSessions = sessions.list();

    const wsPath = workspacePath.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');

    // Apply the same workspace and archive filters to live-session fallback results.
    const filtered = allSessions.filter((s) => {
      if (archivedIds.has(s.header.id)) {
        return false;
      }
      const cwd = s.header.cwd || '';
      const sessionPath = cwd.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');

      const pathMatch = sessionPath === wsPath || sessionPath.startsWith(wsPath + '/');
      const isParentSession = !s.header.parentSession && s.header.origin !== 'subagent';
      return pathMatch && isParentSession;
    });

    const sessionsWithDetails = await Promise.all(
      filtered
        .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0))
        .slice(0, limit)
        .map(async (s) => ({
          id: s.header.id,
          title: 'SESSION_ACTIVE_LABEL',
          createdAt: s.header.createdAt,
          ...(options.metadataOnly ? {} : await syncDetails(null, s.header.id, sessions)),
          cwd: s.header.cwd || '',
          parentSession: s.header.parentSession || null,
          isLive: true,
          isPersisted: false,
        })),
    );

    sessionsWithDetails.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    log.session.info(msg('SESSION_FOUND_ACTIVE_VIA_SERVICE', { v0: sessionsWithDetails.length }));
    return sessionsWithDetails
      .filter((session) => !query || session.title.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit);
  } catch (e) {
    if (options.strict) {
      throw e;
    }
    log.session.error(msg('SESSION_LIST_FAILED', { v0: e.message }));
    return [];
  }
}
