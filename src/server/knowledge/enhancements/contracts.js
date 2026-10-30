import { createHash } from 'node:crypto';

export const ACTIVE = new Set(['queued', 'preparing', 'running', 'cancelling']);
export const DEFAULTS = Object.freeze({
  enabled: false,
  maxInvalidOutputWrites: 3,
  maxConcurrentJobs: 2,
  maxDocuments: 30,
  maxInputBytes: 2_000_000,
  maxResultBytes: 250_000,
  maxNodes: 200,
  maxEdges: 1000,
  maxDepth: 5,
  timeoutMs: 300_000,
  retainedJobs: 50,
  retainedRevisions: 3,
  gitnexusServer: 'gitnexus',
  maxCodeQueries: 20,
  indexTimeoutMs: 1_800_000,
  indexWorkers: 2,
  indexWorkerReadyTimeoutMs: 60000,
});
/**
 * Hash a raw string or JSON-serialized value for version checks.
 * @param value - The input value to validate or encode.
 * @returns The SHA-256 hexadecimal digest.
 */
export const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
/**
 * Throw a stable domain error with structured status and details.
 * @param code - Stable domain error code.
 * @param [status] - HTTP status for the domain failure.
 * @param [details] - Structured diagnostic fields.
 * @returns Never returns.
 */
export function fail(code, status = 400, details = {}) {
  throw Object.assign(new Error(code), { status, details });
}
/**
 * Reject a value whose complete JSON encoding exceeds the byte budget.
 * @param value - The input value to validate or encode.
 * @param maxBytes - Maximum bytes for the complete serialized value.
 * @returns The original value when it fits.
 */
export function bounded(value, maxBytes) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    fail('ENHANCEMENT_INVALID_INPUT');
  }
  if (Buffer.byteLength(serialized) > maxBytes) {
    fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
  }
  return value;
}
/**
 * Resolve enhancement settings from validated configuration.
 * @param config - Validated plugin configuration.
 * @returns Effective enhancement settings.
 */
export function limits(config) {
  return { ...DEFAULTS, ...config?.enhancements };
}
/**
 * Validate a positive integer against its configured maximum.
 * @param value - The input value to validate or encode.
 * @param fallback - Default used only when the value is absent.
 * @param max - Maximum permitted integer.
 * @returns The explicit value or fallback; invalid values throw.
 */
export function integer(value, fallback, max) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    fail('ENHANCEMENT_INVALID_INPUT');
  }
  return number;
}
/**
 * Convert an enhancement error to its public code and structured details.
 * @param error - The underlying execution error.
 * @returns The stable error code and structured details.
 */
export const publicError = (error) => ({
  code: /^ENHANCEMENT_[A-Z_]+$/.test(error.message) ? error.message : 'ENHANCEMENT_FAILED',
  details: error.details || {},
});
