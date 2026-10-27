/**
 * Token estimation utilities.
 * Estimates are planning values, never provider usage or a tokenizer count.
 * @module token-utils
 */


/** Fallback input estimate when the Host supplies no model capacity metadata. */
export const MAX_SYNC_INPUT_TOKENS = 150000;

/**
 * Include framing in the same multilingual estimate used for evidence and UI.
 */
export function estimateSubagentInputTokens(text) {
  return estimateTextTokens(text) + 8;
}

/** @type {number} JSON structure overhead per content block (in tokens) */
export const BLOCK_OVERHEAD = 4;

/** @type {number} Role framing overhead per message (in tokens) */
export const ROLE_OVERHEAD = 4;

/**
 * Estimate token count for a text string.
 * @param {string} text - Input text
 * @returns {number} Estimated token count
 */
export function estimateTextTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Code/identifiers need more room than prose. Non-ASCII text must not be
  // priced as English, nor as one token for every UTF-8 byte.
  let ascii = 0, other = 0;
  for (const char of text) {
    if (char.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3 + other * 2);
}

/**
 * Estimate token count for an array of content blocks.
 * Handles text, reasoning, tool-call, and other block types.
 * @param {Array<{type: string, text?: string, name?: string, arguments?: string}>} blocks - Content block array
 * @returns {number} Estimated token count
 */
export function estimateContentTokens(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  
  let tokens = 0;
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateTextTokens(block.text) + BLOCK_OVERHEAD;
        break;
      case 'tool-call':
        tokens += estimateTextTokens(block.name)
          + estimateTextTokens(block.arguments)
          + BLOCK_OVERHEAD;
        break;
      default:
        // 其他类型使用 JSON 结构估算
        tokens += BLOCK_OVERHEAD + estimateTextTokens(JSON.stringify(block));
    }
  }
  return tokens;
}

/**
 * Estimate token count for a single message.
 * @param {Object} message - Message object
 * @param {string} message.role - Message role (user/assistant/system)
 * @param {Array|string} message.content - Message content (string or content block array)
 * @returns {number} Estimated token count
 */
export function estimateMessageTokens(message) {
  if (!message) return 0;
  
  const content = message.content;
  let tokens = 0;
  
  if (typeof content === 'string') {
    tokens = estimateTextTokens(content) + ROLE_OVERHEAD;
  } else if (Array.isArray(content)) {
    tokens = estimateContentTokens(content) + ROLE_OVERHEAD;
  }
  
  return tokens;
}


/**
 * Format token count as a human-readable string.
 * @param {number} tokens - Token count
 * @returns {string} Formatted string (e.g., "1.5k", "2.3M")
 */
export function formatTokens(tokens) {
  if (typeof tokens !== 'number' || isNaN(tokens)) return '0';
  
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}
