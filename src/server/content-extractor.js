/**
 * Content extractor module.
 * Extracts useful context information from DSH sessions.
 * @module content-extractor
 */

import { log } from './logger.js';
import { charsToTokens, estimateTextTokens, formatTokens, CHARS_PER_TOKEN } from './token-utils.js';

/**
 * @typedef {Object} ExtractedMessage
 * @property {'user'|'assistant'} role - Message role
 * @property {string} text - Message text content
 * @property {string} time - Message timestamp
 * @property {string} [sessionId] - Optional session ID
 */

/**
 * @typedef {Object} ExtractedToolCall
 * @property {string} name - Tool name
 * @property {Object} arguments - Tool arguments
 * @property {string} time - Call timestamp
 */

/**
 * @typedef {Object} ExtractedContent
 * @property {ExtractedMessage[]} messages - Extracted messages
 * @property {ExtractedToolCall[]} toolCalls - Extracted tool calls
 * @property {number} totalTokens - Estimated total token count
 * @property {number} [totalLength] - Estimated total character count
 * @property {number} [sessionCount] - Number of sessions processed
 * @property {string} [error] - Error message if extraction failed
 */

/**
 * Extract text from content (string or content block array).
 * @param {string|Array<{type: string, text?: string}>} content - Content to extract from
 * @returns {string} Extracted text
 */
function extractText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
  }
  return '';
}

/**
 * Extract useful context information from a DSH session.
 * @param {Object} sessions - DSH sessions service
 * @param {string} sessionId - Session ID to extract from
 * @param {Object} [options={}] - Extraction options
 * @param {boolean} [options.includeToolCalls=false] - Whether to include tool calls
 * @param {number} [options.maxContentTokens=12500] - Maximum content tokens (≈50k chars)
 * @returns {Promise<ExtractedContent>} Extracted content
 */
export async function extractSessionContent(sessions, sessionId, options = {}) {
  const {
    includeToolCalls = false,
    maxContentTokens = 12500, // 约 50k 字符
  } = options;
  
  if (!sessions) {
    log.session.warn('sessions 服务不可用，无法提取会话内容');
    return {
      messages: [],
      toolCalls: [],
      totalTokens: 0,
    };
  }

  try {
    // 获取活跃会话
    const session = sessions.get(sessionId);
    if (!session) {
      log.session.warn(`会话不存在或已关闭: ${sessionId}`);
      return {
        messages: [],
        toolCalls: [],
        totalTokens: 0,
      };
    }
    
    // 获取会话事件
    const events = session.snapshotEvents();
    
    // 提取关键内容
    const content = {
      messages: [],
      toolCalls: [],
      totalTokens: 0,
    };
    
    for (const event of events) {
      switch (event.type) {
        case 'user/message': {
          // user/message 的 content 在顶层 event.data.content
          const text = extractText(event.data?.content || event.data?.message?.content);
          if (text) {
            content.messages.push({
              role: 'user',
              text,
              time: event.time,
            });
            content.totalTokens += estimateTextTokens(text);
          }
          break;
        }
        
        case 'assistant/message': {
          // assistant/message 的 content 在 event.data.message.content
          const text = extractText(event.data?.message?.content);
          if (text) {
            content.messages.push({
              role: 'assistant',
              text,
              time: event.time,
            });
            content.totalTokens += estimateTextTokens(text);
          }
          break;
        }
        
        case 'tool/call': {
          if (includeToolCalls) {
            content.toolCalls.push({
              name: event.data.name,
              arguments: event.data.arguments,
              time: event.time,
            });
          }
          break;
        }
      }
      
      // 截断保护
      if (content.totalTokens > maxContentTokens) {
        log.session.warn(`会话内容超过 ${maxContentTokens} tokens，已截断`);
        break;
      }
    }
    
    log.session.info(`从会话 ${sessionId} 提取了 ${content.messages.length} 条消息，约 ${formatTokens(content.totalTokens)} tokens`);
    return content;
  } catch (e) {
    log.session.error(`提取会话内容失败: ${e.message}`);
    return {
      messages: [],
      toolCalls: [],
      totalTokens: 0,
      error: e.message,
    };
  }
}

/**
 * Extract and merge content from multiple sessions.
 * Messages are sorted by time across all sessions.
 * @param {Object} sessions - DSH sessions service
 * @param {string[]} sessionIds - Array of session IDs
 * @param {Object} [options={}] - Extraction options
 * @returns {Promise<ExtractedContent>} Merged content from all sessions
 */
export async function extractMultipleSessions(sessions, sessionIds, options = {}) {
  const {
    includeToolCalls = false,
    maxContentTokens = 12500, // 约 50k 字符
  } = options;
  
  const allMessages = [];
  const allToolCalls = [];
  let totalTokens = 0;
  
  for (const sessionId of sessionIds) {
    const content = await extractSessionContent(sessions, sessionId, {
      includeToolCalls,
      maxContentTokens: maxContentTokens - totalTokens,
    });
    
    // 添加会话标识
    const sessionMessages = content.messages.map(msg => ({
      ...msg,
      sessionId,
    }));
    
    allMessages.push(...sessionMessages);
    allToolCalls.push(...content.toolCalls);
    totalTokens += content.totalTokens;
    
    // 如果超过限制，停止提取
    if (totalTokens >= maxContentTokens) {
      log.session.warn(`多会话内容超过 ${maxContentTokens} tokens，停止提取`);
      break;
    }
  }
  
  // 按时间排序
  allMessages.sort((a, b) => a.time - b.time);
  allToolCalls.sort((a, b) => a.time - b.time);
  
  return {
    messages: allMessages,
    toolCalls: allToolCalls,
    totalTokens,
    totalLength: totalTokens * CHARS_PER_TOKEN, // 兼容旧字段
    sessionCount: sessionIds.length,
  };
}




