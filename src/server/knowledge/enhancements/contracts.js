import { createHash } from 'node:crypto';

export const ACTIVE = new Set(['queued', 'preparing', 'running', 'cancelling']);
export const DEFAULTS = Object.freeze({ enabled: false, maxInvalidOutputWrites: 3, maxConcurrentJobs: 2, maxDocuments: 30, maxInputBytes: 2_000_000, maxResultBytes: 250_000,
  maxNodes: 200, maxEdges: 1000, maxDepth: 5, timeoutMs: 300_000, retainedJobs: 50, retainedRevisions: 3,
  gitnexusServer: 'gitnexus', maxCodeQueries: 20, indexTimeoutMs: 1_800_000, indexWorkers: 2, indexWorkerReadyTimeoutMs: 60000 });
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function fail(code, status = 400, details = {}) { throw Object.assign(new Error(code), { status, details }); }
export function bounded(value, maxBytes) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail('ENHANCEMENT_INVALID_INPUT');
  if (Buffer.byteLength(serialized) > maxBytes) fail('ENHANCEMENT_BUDGET_EXCEEDED', 413);
  return value;
}
export function limits(config) { return { ...DEFAULTS, ...config?.enhancements }; }
export function integer(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) fail('ENHANCEMENT_INVALID_INPUT');
  return number;
}
export const publicError = error => ({ code: /^ENHANCEMENT_[A-Z_]+$/.test(error.message) ? error.message : 'ENHANCEMENT_FAILED', details: error.details || {} });
