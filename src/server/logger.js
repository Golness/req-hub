/**
 * Logging management module.
 * Provides operation logging and querying capabilities.
 *
 * Log levels: debug < info < warn < error
 * Log tags: identify the source module of the log
 * @module logger
 */

/** @type {Array<LogEntry>} In-memory operation log storage */
const operationLogs = [];

/** @type {number} Maximum number of log entries to keep */
const MAX_LOGS = 200;

/**
 * @typedef {Object} LogEntry
 * @property {number} ts - Unix timestamp in milliseconds
 * @property {string} timestamp - ISO 8601 timestamp string
 * @property {'debug'|'info'|'warn'|'error'} level - Log level
 * @property {string} tag - Log tag identifying source module
 * @property {string} message - Log message
 * @property {any} [data] - Optional additional data
 */

/**
 * Log level definitions.
 * Higher numeric value = higher priority.
 * @type {Object<string, number>}
 */
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Log tag definitions.
 * key: tag ID, value: display name
 * @type {Object<string, string>}
 */
const LOG_TAGS = {
  startup: '启动',
  config: '配置',
  tree: '目录',
  sync: '同步',
  'sync-engine': '同步引擎',
  'phased-sync': '分阶段同步',
  analysis: 'AI分析',
  'task-executor': '任务执行器',
  session: '会话',
  search: '搜索',
  writing: '写作',
  doc: '文档',
  state: '状态',
};

/**
 * Internal function to add a log entry.
 * Maintains log buffer size by removing oldest entries.
 * @param {'debug'|'info'|'warn'|'error'} level - Log level
 * @param {string} tag - Log tag
 * @param {string} message - Log message
 * @param {any} [data=null] - Optional additional data
 * @returns {void}
 */
function _addLog(level, tag, message, data = null) {
  const entry = {
    ts: Date.now(),
    timestamp: new Date().toISOString(),
    level,
    tag,
    message,
    data
  };
  operationLogs.unshift(entry);
  if (operationLogs.length > MAX_LOGS) {
    operationLogs.pop();
  }
}

/**
 * @typedef {Object} Logger
 * @property {function(string, any=): void} debug - Log debug level message
 * @property {function(string, any=): void} info - Log info level message
 * @property {function(string, any=): void} warn - Log warning level message
 * @property {function(string, any=): void} error - Log error level message
 */

/**
 * Create a tagged logger instance.
 * @param {string} tag - Log tag identifying the source module
 * @returns {Logger} Logger object with debug/info/warn/error methods
 */
export function createLogger(tag) {
  return {
    /**
     * Log debug level message.
     * Used for detailed debugging info, typically not shown in production.
     * @param {string} message - Log message
     * @param {any} [data=null] - Optional additional data
     */
    debug: (message, data = null) => _addLog('debug', tag, message, data),
    
    /**
     * Log info level message.
     * Used for routine operation info like startup, completion, progress.
     * @param {string} message - Log message
     * @param {any} [data=null] - Optional additional data
     */
    info: (message, data = null) => _addLog('info', tag, message, data),
    
    /**
     * Log warning level message.
     * Used for warnings like degraded operation, non-fatal errors.
     * @param {string} message - Log message
     * @param {any} [data=null] - Optional additional data
     */
    warn: (message, data = null) => _addLog('warn', tag, message, data),
    
    /**
     * Log error level message.
     * Used for errors like operation failures, exceptions.
     * @param {string} message - Log message
     * @param {any} [data=null] - Optional additional data
     */
    error: (message, data = null) => _addLog('error', tag, message, data),
  };
}

/**
 * Get all logs with optional filtering.
 * @param {Object} [options={}] - Filter options
 * @param {string[]} [options.levels=[]] - Filter by log levels
 * @param {string[]} [options.tags=[]] - Filter by log tags
 * @returns {LogEntry[]} Filtered log entries
 */
export function getLogs(options = {}) {
  const { levels = [], tags = [] } = options;
  
  let filtered = operationLogs;
  
  // 按等级筛选
  if (levels.length > 0) {
    filtered = filtered.filter(log => levels.includes(log.level));
  }
  
  // 按标签筛选
  if (tags.length > 0) {
    filtered = filtered.filter(log => tags.includes(log.tag));
  }
  
  return filtered;
}

/**
 * Get all available log levels.
 * @returns {Object<string, number>} Copy of log levels mapping
 */
export function getLogLevels() {
  return { ...LOG_LEVELS };
}

/**
 * Get all available log tags.
 * @returns {Object<string, string>} Copy of log tags mapping
 */
export function getLogTags() {
  return { ...LOG_TAGS };
}

/**
 * Clear all log entries.
 * @returns {void}
 */
export function clearLogs() {
  operationLogs.length = 0;
}

/**
 * Legacy addLog function for backward compatibility.
 * @deprecated Use createLogger(tag) instead
 * @param {'info'|'success'|'warning'|'error'} type - Legacy log type
 * @param {string} message - Log message
 * @param {any} [data=null] - Optional additional data
 * @returns {void}
 */
export function addLog(type, message, data = null) {
  // 旧类型映射到新等级
  const typeToLevel = {
    success: 'info',
    info: 'info',
    warning: 'warn',
    error: 'error',
  };
  
  // 从消息中尝试提取标签（兼容旧行为）
  let level = typeToLevel[type] || 'info';
  let tag = 'startup'; // 默认标签
  
  // 根据消息内容推断标签
  if (message.includes('配置') || message.includes('LLM')) {
    tag = 'config';
  } else if (message.includes('同步') || message.includes('Sync')) {
    tag = 'sync';
  } else if (message.includes('分析') || message.includes('AI')) {
    tag = 'analysis';
  } else if (message.includes('会话') || message.includes('session')) {
    tag = 'session';
  } else if (message.includes('目录') || message.includes('创建')) {
    tag = 'tree';
  } else if (message.includes('写作')) {
    tag = 'writing';
  } else if (message.includes('启动') || message.includes('卸载')) {
    tag = 'startup';
  }
  
  _addLog(level, tag, message, data);
}

/**
 * Pre-defined logger instances for convenience.
 * Each property is a tagged logger for a specific module.
 * @type {Object<string, Logger>}
 */
export const log = {
  startup: createLogger('startup'),
  config: createLogger('config'),
  tree: createLogger('tree'),
  sync: createLogger('sync'),
  phasedSync: createLogger('phased-sync'),
  taskExecutor: createLogger('task-executor'),
  session: createLogger('session'),
  search: createLogger('search'),
  doc: createLogger('doc'),
  state: createLogger('state'),
  concurrency: createLogger('concurrency'),
};
