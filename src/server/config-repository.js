import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const scope = new AsyncLocalStorage();
const snapshot = Symbol('req-hub:config-snapshot');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const put = (target, key, value) =>
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
const revision = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (code, path) =>
  Object.assign(new Error(code), {
    code,
    status: 409,
    details: path ? { field: path } : {},
  });

function merge(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    put(next, key, object(value) ? merge(object(next[key]) ? next[key] : {}, value) : value);
  }
  return next;
}

function applyChanges(base, requested, current, path = '') {
  const next = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(requested)])) {
    if (isDeepStrictEqual(base[key], requested[key])) {
      continue;
    }
    const field = path ? `${path}.${key}` : key;
    if (
      object(requested[key]) &&
      (object(base[key]) || base[key] === undefined) &&
      (object(current[key]) || current[key] === undefined)
    ) {
      put(next, key, applyChanges(base[key] || {}, requested[key], current[key] || {}, field));
    } else {
      if (
        !isDeepStrictEqual(base[key], current[key]) &&
        !isDeepStrictEqual(requested[key], current[key])
      ) {
        throw conflict('CONFIG_CONFLICT', field);
      }
      if (key in requested) {
        put(next, key, requested[key]);
      } else {
        delete next[key];
      }
    }
  }
  return next;
}

function assertOverrides(value, overrides, path = '') {
  for (const [key, expected] of Object.entries(overrides)) {
    const field = path ? `${path}.${key}` : key;
    if (object(expected)) {
      assertOverrides(value[key] || {}, expected, field);
    } else if (!isDeepStrictEqual(value[key], expected)) {
      throw conflict('CONFIG_DEPLOYMENT_OVERRIDE', field);
    }
  }
}

/**
 * Own one profile's validated settings and serialized writes. Handles must not be shared
 * across profiles; run() binds legacy readers and background callbacks to this instance.
 * @param options - Profile path, defaults, deployment overrides and schema validator.
 */
export class ConfigRepository {
  constructor({ filePath, legacyFile, defaults, overrides = {}, validate }) {
    this.filePath = filePath;
    this.legacyFile = legacyFile;
    this.defaults = defaults;
    this.overrides = structuredClone(overrides);
    this.validate = validate;
    this.queue = Promise.resolve();
    this.closed = false;
    this.validate(overrides);
  }

  /** @param callback - Work owned by this repository. @returns The callback result. */
  run(callback) {
    return scope.run(this, callback);
  }

  /** @returns A validated snapshot; its private base survives object spreads, not JSON. */
  async read() {
    if (this.closed) {
      throw new Error('CONFIG_CLOSED');
    }
    const pending = this.queue.then(() => this.readCurrent());
    this.queue = pending.catch(() => {
      // Reads can fail too; the next operation must still be admitted.
    });
    return pending;
  }

  async readCurrent() {
    const target = this.filePath();
    let saved = {};
    if (existsSync(target)) {
      saved = this.validate(JSON.parse(await readFile(target, 'utf8')));
    } else if (this.legacyFile && existsSync(this.legacyFile)) {
      saved = this.validate(JSON.parse(await readFile(this.legacyFile, 'utf8')));
      await this.write(saved);
    }
    const value = merge(merge(structuredClone(this.defaults), saved), this.overrides);
    Object.defineProperty(value, snapshot, {
      value: { repository: this, value: structuredClone(value), revision: revision(value) },
      enumerable: true,
    });
    return value;
  }

  /**
   * Update from the latest value inside the write queue. Snapshot saves use a three-way
   * merge: unrelated writes survive and conflicting edits fail without replacing the file.
   * @param change - A settings value or async updater, executed once inside the queue.
   * @param options - Optional expected revision and cancellation signal.
   * @returns The committed snapshot after atomic replacement.
   */
  update(change, { expectedRevision, signal } = {}) {
    if (this.closed) {
      return Promise.reject(new Error('CONFIG_CLOSED'));
    }
    const pending = this.queue.then(async () => {
      signal?.throwIfAborted();
      const current = await this.readCurrent();
      if (expectedRevision !== undefined && expectedRevision !== revision(current)) {
        throw conflict('CONFIG_CONFLICT');
      }
      let next;
      if (typeof change === 'function') {
        next = await change(current);
      } else {
        const base = change?.[snapshot];
        if (base && base.repository !== this) {
          throw conflict('CONFIG_SCOPE_MISMATCH');
        }
        next = base ? applyChanges(base.value, change, current) : change;
      }
      const value = this.validate(next);
      assertOverrides(value, this.overrides);
      signal?.throwIfAborted();
      await this.write(value, signal);
      return this.readCurrent();
    });
    this.queue = pending.catch(() => {
      // The operation owns its rejection; a rejected write must not poison later updates.
    });
    return pending;
  }

  async write(value, signal) {
    const target = this.filePath();
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
      signal?.throwIfAborted();
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** @returns Completion after already admitted writes settle; later writes reject. */
  async close() {
    this.closed = true;
    await this.queue;
  }
}

/** @returns The repository bound to the current asynchronous operation, if any. */
export function currentConfigRepository() {
  return scope.getStore();
}

/**
 * Bind direct standalone callers without changing another asynchronous scope.
 * @param repository - Standalone configuration owner.
 * @returns A synchronous restore callback; production activation uses repository.run().
 */
export function enterConfigRepository(repository) {
  const previous = scope.getStore();
  scope.enterWith(repository);
  return () => scope.enterWith(previous);
}

/** @param value - A loaded snapshot. @returns Its optimistic client-safe revision. */
export function configRevision(value) {
  return revision(value);
}
