/**
 * Cache management module.
 * Provides simple in-memory caching with TTL support.
 * @module cache
 */

/** @type {Map<string, {data: any, timestamp: number}>} Cache storage */
const cache = new Map();

/** @type {number} Default TTL in milliseconds (30 seconds) */
const DEFAULT_TTL = 30000;

/**
 * Get cached value by key.
 * Returns null if key doesn't exist or entry has expired.
 * @param {string} key - Cache key
 * @returns {any|null} Cached data or null if not found/expired
 */
export function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > DEFAULT_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Set cached value with current timestamp.
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 * @returns {void}
 */
export function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}
