'use strict';
// The single rendering entry point for everything the Host sends as copy.
// Bare codes and `{ code, params }` descriptors both resolve against the
// plugin dictionaries; anything else is displayed verbatim so user content,
// paths and technical details are never rewritten.
const { t, hasLocaleKey } = require('../locale.js');

const CODE = /^[A-Z][A-Z0-9_]{2,}$/;
const KEY_BUILDERS = [
  (code) => `server.${code}`,
  (code) => `sync.error.${code}`,
  (code) => `kb.error.${code}`,
  (code) => `writing.error.${code}`,
  (code) => `reports.reason.${code}`,
  (code) => `lark.${code}`,
  (code) => `enhancement.error.${code}`,
];

/**
 * Resolve one stable code to localized copy.
 * @param {string} code - Stable message code.
 * @param {Record<string, unknown>} [params] - Interpolation values.
 * @returns {string} Localized text, or the code itself when unknown.
 */
function localizeCode(code, params) {
  if (!CODE.test(code)) return code;
  // A descriptor may carry other codes as parameters (e.g. a timeline title
  // composed of a document type and a status). Resolve them recursively.
  const resolved = params
    ? Object.fromEntries(
        Object.entries(params).map(([name, value]) => [name, localizeMessage(value)]),
      )
    : undefined;
  for (const build of KEY_BUILDERS) {
    const key = build(code);
    if (hasLocaleKey(key)) {
      const text = t(key, resolved);
      // A descriptor collapsed to its bare code in a string context loses its
      // params; drop leftover placeholders instead of showing them literally.
      return resolved ? text : text.replace(/\{v\d+\}/g, '').trim();
    }
  }
  return code;
}

/**
 * Render a Host message in the active UI language.
 * @param {unknown} value - Bare code, `{ code, params, detail }`, or plain text.
 * @returns {string} Display-ready text.
 */
function localizeMessage(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(localizeMessage).filter(Boolean).join('; ');
  }
  if (typeof value === 'string') return localizeCode(value);
  if (typeof value === 'object') {
    if (value instanceof Error) {
      return localizeDescriptor(value.code || value.message, value.params, value.detail);
    }
    if (typeof value.code === 'string') {
      return localizeDescriptor(value.code, value.params, value.detail);
    }
    return '';
  }
  return String(value);
}

/** Render one descriptor, appending an optional raw diagnostic detail. */
function localizeDescriptor(code, params, detail) {
  const text = localizeCode(code, params);
  return detail === undefined || detail === null ? text : `${text}: ${detail}`;
}

/**
 * Build a throwable Error from a Host error value. `.message` stays a pure
 * stable code (so existing checks keep working) while `.code`/`.params` carry
 * the descriptor for `localizeMessage(error)`.
 * @param {unknown} value - Bare code, descriptor, or plain text.
 * @param {string} [fallback] - Copy to use when the response has no error.
 * @returns {Error}
 */
function clientError(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return new Error(fallback || 'INTERNAL_ERROR');
  }
  if (typeof value === 'object' && typeof value.code === 'string') {
    const error = new Error(value.code);
    error.code = value.code;
    error.params = value.params;
    error.detail = value.detail;
    return error;
  }
  return new Error(String(value));
}

/**
 * Like `localizeMessage`, but joins multiple Host messages (e.g. the
 * semicolon-separated aggregate error protocol) into one readable sentence.
 * @param {unknown} value - A single message or an array of messages.
 * @param {string} [separator] - Separator between rendered messages.
 * @returns {string} Display-ready text.
 */
function localizeMessages(value, separator = '; ') {
  if (Array.isArray(value)) {
    return value.map(localizeMessage).filter(Boolean).join(separator);
  }
  return localizeMessage(value);
}

/**
 * Extract a bare stable code from either Host message form.
 * Use this when a value must stay a code (comparisons, `new Error(code)`,
 * error detail components) rather than be rendered as localized copy.
 * @param {unknown} value - Bare code, `{ code, params }`, or plain text.
 * @returns {string} A display-safe string.
 */
function messageCode(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.code === 'string') return value.code;
  return value === null || value === undefined ? '' : String(value);
}

module.exports = {
  localizeMessage,
  localizeMessages,
  localizeCode,
  messageCode,
  clientError,
};
