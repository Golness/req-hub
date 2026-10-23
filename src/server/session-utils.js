/**
 * Session utilities module.
 * Provides unified methods for extracting session turn data.
 * @module session-utils
 */

import { estimateTextTokens } from './token-utils.js';

/**
 * @typedef {Object} TurnData
 * @property {number} turnNumber - Turn sequence number
 * @property {string} time - Turn start time (ISO 8601)
 * @property {string} userInput - User input text
 * @property {string} summary - Assistant response summary (truncated if needed)
 * @property {string} [endTime] - Turn end time (ISO 8601)
 * @property {string} [sessionId] - Optional session ID
 */

/**
 * Extract turn data from session events.
 * @param {Array<Object>} events - Session events array
 * @param {Object} [options={}] - Extraction options
 * @param {number} [options.maxSummaryChars=800] - Max chars for summary (≈200 tokens). Set to -1 for no truncation
 * @param {string} [options.sessionId=null] - Optional session ID to attach to each turn
 * @returns {TurnData[]} Array of extracted turns
 */
export function extractTurnsFromEvents(events, options = {}) {
  const { maxSummaryChars = 800, sessionId = null } = options;
  const truncate = maxSummaryChars >= 0; // -1 表示不截断
  
  const turns = [];
  let currentTurn = null;
  
  for (const event of events) {
    if (event.type === 'turn/start') {
      currentTurn = {
        turnNumber: event.data.turn,
        time: event.time,
        userInput: '',
        summary: '',
      };
      if (sessionId) {
        currentTurn.sessionId = sessionId;
      }
    } else if (event.type === 'turn/end' && currentTurn) {
      currentTurn.endTime = event.time;
      turns.push(currentTurn);
      currentTurn = null;
    } else if (event.type === 'user/message' && currentTurn) {
      // user/message 的 content 在顶层 event.data.content
      const content = event.data?.content;
      if (typeof content === 'string') {
        currentTurn.userInput = content;
      } else if (Array.isArray(content)) {
        currentTurn.userInput = content
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('\n');
      }
    } else if (event.type === 'assistant/message' && currentTurn) {
      // assistant/message 的 content 在 event.data.message.content
      const content = event.data?.message?.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('\n');
      }
      // 根据选项决定是否截断
      if (text) {
        const newSummary = truncate 
          ? (text.substring(0, maxSummaryChars) + (text.length > maxSummaryChars ? '...' : ''))
          : text;
        // 如果当前摘要为空，或者新文本更长（取更完整的），则更新
        if (currentTurn.summary === '' || text.length > currentTurn.summary.length) {
          currentTurn.summary = newSummary;
        }
      }
    }
  }
  
  return turns;
}

/**
 * Extract turn data from a single session.
 * @param {Object} sessionQuery - sessionQuery service
 * @param {string} sessionId - Session ID
 * @param {Object} [options={}] - Extraction options
 * @returns {Promise<TurnData[]>} Array of turns, empty array on error
 */
export async function extractSessionTurns(sessionQuery, sessionId, options = {}) {
  if (!sessionQuery) {
    return [];
  }
  
  try {
    const logSnapshot = await sessionQuery.readSession(sessionId);
    const events = logSnapshot.events;
    
    return extractTurnsFromEvents(events, { ...options, sessionId });
  } catch (e) {
    console.error(`提取会话轮次失败: ${e.message}`);
    return [];
  }
}

/**
 * Extract and merge turn data from multiple sessions.
 * @param {Object} sessionQuery - sessionQuery service
 * @param {string[]} sessionIds - Array of session IDs
 * @param {Object} [options={}] - Extraction options
 * @returns {Promise<{turns: TurnData[], totalTokens: number}>} Merged turns and total token count
 */
export async function extractMultipleSessionTurns(sessionQuery, sessionIds, options = {}) {
  const allTurns = [];
  
  for (const sessionId of sessionIds) {
    const turns = await extractSessionTurns(sessionQuery, sessionId, options);
    allTurns.push(...turns);
  }
  
  // 按时间排序
  allTurns.sort((a, b) => a.time - b.time);
  
  // 计算总 token
  const totalTokens = allTurns.reduce(
    (sum, t) => sum + estimateTextTokens(t.userInput) + estimateTextTokens(t.summary), 
    0
  );
  
  return { turns: allTurns, totalTokens };
}

/**
 * Calculate total token count for an array of turns.
 * @param {TurnData[]} turns - Array of turns
 * @returns {number} Total estimated token count
 */
export function calculateTurnsTokens(turns) {
  return turns.reduce(
    (sum, t) => sum + estimateTextTokens(t.userInput || '') + estimateTextTokens(t.summary || ''), 
    0
  );
}

