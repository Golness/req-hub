/** FIFO concurrency slots with cancellable waiters and idempotent slot release. */

import { log } from '../logger.js';

/** Identify semaphore cancellation with the stable ABORT_ERR code. */
export class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
  }
}

/** Own FIFO waiters; running slots must be released independently of queue cancellation. */
export class BoundedSemaphore {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];
  }

  /**
   * Wait for a slot, rejecting when the supplied signal is aborted.
   * @param {AbortSignal} [signal] - Cancellation for this acquisition.
   * @returns {Promise<{slot: {release: Function}}>} A slot the caller must release in finally.
   */
  async acquire(signal) {
    if (signal?.aborted) {
      throw new AbortError('Operation aborted');
    }

    if (this.running < this.maxConcurrency) {
      this.running++;
      return { slot: this._createSlot() };
    }

    return new Promise((resolve, reject) => {
      // Recheck cancellation before registering a queued waiter.

      if (signal?.aborted) {
        reject(new AbortError('Operation aborted'));
        return;
      }

      let settled = false; // Settle each queued acquisition at most once.

      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(new AbortError('Operation aborted while waiting in queue'));
        }
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      const entry = {
        resolve: (slot) => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve({ slot });
        },
        reject: (err) => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      };

      this.queue.push(entry);
    });
  }

  /** Release one running slot and admit the oldest remaining waiter. */
  release() {
    if (this.running <= 0) {
      log.concurrency.warn(
        'BoundedSemaphore: release() called when running <= 0, possible double-release bug',
      );
      return;
    }
    this.running--;

    if (this.queue.length > 0 && this.running < this.maxConcurrency) {
      this.running++;
      const next = this.queue.shift();
      next.resolve(this._createSlot());
    }
  }

  /** Reject queued acquisitions without cancelling running slots or future acquisitions. */
  abortAll() {
    for (const entry of this.queue) {
      entry.reject(new AbortError('Semaphore aborted'));
    }
    this.queue = [];
  }

  _createSlot() {
    let released = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.release();
        }
      },
    };
  }

  get waitingCount() {
    return this.queue.length;
  }
  get runningCount() {
    return this.running;
  }
}
