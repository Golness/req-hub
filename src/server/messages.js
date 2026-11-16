/**
 * Host-to-UI message protocol.
 *
 * The server never emits human-readable copy. It emits either a bare stable
 * code (for static messages) or a descriptor `{ code, params }` when the
 * message carries dynamic values. Both forms are safe to put in `error`,
 * `message`, `reason`, `title` and SSE payloads, and both are rendered through
 * the client's `localizeMessage()` helper.
 *
 * Keeping parameterless codes as plain strings means the many callers that
 * only check truthiness or compare a code keep working unchanged.
 */

/**
 * A message carrying dynamic values. It serializes as `{ code, params }` for
 * JSON/SSE/SQLite transport, but collapses to the bare code in string contexts
 * such as `new Error(message)` or template concatenation.
 */
export class Message extends Error {
  constructor(code, params) {
    super(code);
    this.name = 'Message';
    this.code = code;
    this.params = params;
  }

  /** Keep `String(message)` and `error.message` a pure stable code. */
  toString() {
    return this.code;
  }

  /** Transport shape for JSON, SSE and report persistence. */
  toJSON() {
    return { code: this.code, params: this.params };
  }
}

/**
 * Build a message descriptor.
 * @param {string} code - Stable SCREAMING_SNAKE_CASE message code.
 * @param {Record<string, unknown>} [params] - Interpolation values.
 * @returns {string|Message}
 */
export function msg(code, params) {
  if (!params || Object.keys(params).length === 0) {
    return code;
  }
  return new Message(code, params);
}

/**
 * Extract the stable code from either message form.
 * @param {unknown} value - A bare code or a descriptor.
 * @returns {string} The code, or an empty string when there is none.
 */
export function messageCode(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.code === 'string') return value.code;
    // Plain `new Error('CODE')` keeps the stable code in `.message`.
    if (value instanceof Error && typeof value.message === 'string') return value.message;
  }
  return '';
}

const CODE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * Convert a message into a plain, structured-clone-safe transport value.
 *
 * `Message` is an `Error` subclass: JSON.stringify() honours its `toJSON()`,
 * but `postMessage`/structuredClone silently drops custom fields. Use this at
 * worker and SSE boundaries so `params` never disappear.
 * @param {unknown} value - Bare code, `Message`, or plain descriptor.
 * @returns {string|{code: string, params: Record<string, unknown>}}
 */
export function messageDescriptor(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(messageDescriptor);
  // `TaskExecutorError` uses `.code` for a machine-level error code; its
  // `.messageCode` is the user-visible stable code. Prefer that explicitly.
  const code =
    (typeof value.messageCode === 'string' && value.messageCode) ||
    messageCode(value) ||
    messageCode(value.message);
  if (!code) return 'INTERNAL_ERROR';
  if (!CODE.test(code)) return code;
  const raw = value.params;
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return code;
  // Nested descriptors (document types, session ids, step labels) must be
  // normalized too, otherwise structuredClone/JSON still drops their params.
  return {
    code,
    params: Object.fromEntries(
      Object.entries(raw).map(([name, entry]) => [name, messageDescriptor(entry)]),
    ),
  };
}

/**
 * Rebuild a throwable message from a transport descriptor.
 * @param {unknown} value - Bare code or plain descriptor.
 * @returns {Error|string}
 */
export function messageFromDescriptor(value) {
  const code = messageCode(value);
  const params = value && typeof value === 'object' ? value.params : undefined;
  const built = msg(code || 'INTERNAL_ERROR', params);
  return typeof built === 'string' ? new Error(built) : built;
}

/**
 * Normalize any thrown value into a stable code plus optional params.
 * Used by route `catch` blocks so error responses never contain prose.
 *
 * Prefer the message descriptor over `error.code`: classes such as
 * `TaskExecutorError` use `.code` for a machine-level error code and keep the
 * user-visible stable code in `.message`.
 * @param {unknown} error - Thrown value.
 * @returns {{code: string, params?: Record<string, unknown>}}
 */
export function describeError(error) {
  const descriptor = messageDescriptor(error);
  if (typeof descriptor === 'object') return descriptor;
  return { code: descriptor };
}
