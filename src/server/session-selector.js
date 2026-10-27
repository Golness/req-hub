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
    return { turnCount: snapshot.turnCount, syncTurnCount: snapshot.syncTurnCount, snapshotVersion: snapshot.version };
  } catch (error) { return { turnCount: null, syncTurnCount: 0, snapshotError: error.message }; }
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
 * @returns {Promise<SessionInfo[]>} Filtered session list sorted by creation time (desc)
 */
export async function listRelatedSessions(sessions, workspacePath, options = {}) {
  const { limit = 20, query, sessionQuery, registry } = options;

  // 获取已归档会话 ID 集合，用于过滤
  const archivedIds = new Set(registry?.archivedSessionIds || []);

  // 使用 sessionQuery 服务获取所有会话（包括持久化的）
  if (sessionQuery) {
    try {
      // 获取所有会话记录
      const allRecords = await sessionQuery.listSessions();

      // 标准化路径用于比较
      const wsPath = workspacePath.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');

      // 按工作目录过滤：只匹配工作区路径本身或其子目录，且只取父会话，排除已归档
      const filtered = allRecords.filter(record => {
        // 排除已归档的会话
        if (archivedIds.has(record.header.id)) return false;
        const cwd = record.header.cwd || '';
        const sessionPath = cwd.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
        // 会话路径必须等于工作区路径，或者是工作区路径的子目录
        // 且必须是父会话（没有 parentSession）
        const pathMatch = sessionPath === wsPath || sessionPath.startsWith(wsPath + '/');
        const isParentSession = !record.header.parentSession;
        return pathMatch && isParentSession;
      });
      
      // 并行获取会话标题
      const titlePromises = filtered.sort((a,b) => (b.header.createdAt || 0) - (a.header.createdAt || 0)).map(async (record) => {
        let title = '(无标题)';
        try {
          const titleSnapshot = await sessionQuery.readTitle(record.header.id);
          title = titleSnapshot?.title || '(无标题)';
        } catch (e) {
          // 标题读取失败，使用默认
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
      
      // 按创建时间倒序
      sessionsWithDetails.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      
      log.session.info(`找到 ${sessionsWithDetails.length} 个相关会话（使用 sessionQuery）`);
      return Promise.all(sessionsWithDetails.filter(session => !query || session.title.toLowerCase().includes(query.toLowerCase())).slice(0, limit)
        .map(async session => ({ ...session, ...(options.metadataOnly ? {} : await syncDetails(sessionQuery, session.id, sessions)) })));
    } catch (e) {
      if (options.strict) throw e;
      log.session.error(`sessionQuery 列出会话失败: ${e.message}`);
      // 继续使用 sessions 服务作为后备
    }
  }
  
  // 后备：使用 sessions 服务（仅活跃会话）
  if (!sessions) {
    log.session.warn('sessions 和 sessionQuery 服务都不可用，无法列出会话');
    return [];
  }

  try {
    // 获取所有活跃会话
    const allSessions = sessions.list();
    
    // 标准化路径用于比较
    const wsPath = workspacePath.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
    
    // 按工作目录过滤：只匹配工作区路径本身或其子目录，且只取父会话，排除已归档
    const filtered = allSessions.filter(s => {
      // 排除已归档的会话
      if (archivedIds.has(s.header.id)) return false;
      const cwd = s.header.cwd || '';
      const sessionPath = cwd.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
      // 会话路径必须等于工作区路径，或者是工作区路径的子目录
      // 且必须是父会话（没有 parentSession）
      const pathMatch = sessionPath === wsPath || sessionPath.startsWith(wsPath + '/');
      const isParentSession = !s.header.parentSession;
      return pathMatch && isParentSession;
    });
    
    // 转换为统一格式
    const sessionsWithDetails = await Promise.all(filtered.sort((a,b) => (b.header.createdAt || 0) - (a.header.createdAt || 0)).slice(0, limit).map(async s => ({
      id: s.header.id,
      title: '(活跃会话)',
      createdAt: s.header.createdAt,
      ...(options.metadataOnly ? {} : await syncDetails(null, s.header.id, sessions)),
      cwd: s.header.cwd || '',
      parentSession: s.header.parentSession || null,
      isLive: true,
      isPersisted: false,
    })));
    
    // 按创建时间倒序
    sessionsWithDetails.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    
    log.session.info(`找到 ${sessionsWithDetails.length} 个相关活跃会话（使用 sessions 服务）`);
    return sessionsWithDetails.filter(session => !query || session.title.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
  } catch (e) {
    if (options.strict) throw e;
    log.session.error(`列出会话失败: ${e.message}`);
    return [];
  }
}
