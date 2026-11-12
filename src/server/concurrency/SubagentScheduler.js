import { BoundedSemaphore } from './BoundedSemaphore.js';

/** Shared ReqHub child capacity when no profile override exists. */
export const DEFAULT_SUBAGENT_CONCURRENCY = 3;
const schedulers = new WeakMap();

/** Own the ReqHub child budget for one Host subagent service, across all workspaces and features. */
export class SubagentScheduler {
  constructor() {
    this.semaphore = new BoundedSemaphore(DEFAULT_SUBAGENT_CONCURRENCY);
    this.controller = new AbortController();
    this.leases = new Set();
    this.configured = false;
  }

  /**
   * Apply a validated profile limit; active owners retain their slots after a reduction.
   * @param {number} limit - Shared capacity, from 1 to 16.
   * @returns {void}
   */
  configure(limit = DEFAULT_SUBAGENT_CONCURRENCY) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
      throw new RangeError('SUBAGENT_CONCURRENCY_INVALID');
    }
    this.configured = true;
    this.semaphore.setConcurrency(limit);
  }

  get signal() {
    return this.controller.signal;
  }

  /**
   * Acquire FIFO capacity; the caller releases it only after child startup and disposal settle.
   * @param {AbortSignal} [signal] - Caller cancellation, combined with plugin shutdown.
   * @returns {Promise<{release: Function}>} Idempotent lease owning one child slot.
   */
  async acquire(signal) {
    const combined = AbortSignal.any([this.signal, signal].filter(Boolean));
    const { slot } = await this.semaphore.acquire(combined);
    if (combined.aborted) {
      slot.release();
      combined.throwIfAborted();
    }
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    this.leases.add(pending);
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.leases.delete(pending);
        finish();
        slot.release();
      },
    };
  }

  /** Stop admission and propagate cancellation before feature owners start their cleanup. */
  beginClose() {
    this.controller.abort(new Error('SUBAGENT_SCHEDULER_CLOSED'));
  }

  /**
   * Wait for every acquired lease to reach quiescent child disposal.
   * @returns {Promise<void>} Completion after all slot owners have released resources.
   */
  async close() {
    this.beginClose();
    await Promise.all([...this.leases]);
  }
}

/**
 * Resolve the shared scheduler using the Host service identity, never a workspace or parent agent.
 * @param {object} service - Injected Host subagent service.
 * @param {object} [config] - Initial effective configuration; later tasks cannot overwrite live edits.
 * @returns {SubagentScheduler} The service's shared ReqHub scheduler.
 */
export function getSubagentScheduler(service, config) {
  let scheduler = schedulers.get(service);
  if (!scheduler) {
    scheduler = new SubagentScheduler();
    schedulers.set(service, scheduler);
  }
  if (config && !scheduler.configured) {
    scheduler.configure(config.ai?.delegation?.maxConcurrency);
  }
  return scheduler;
}

/**
 * Attach a plugin lifecycle, renewing only a fully drained scheduler after unload.
 * @param {object} service - Injected Host subagent service.
 * @returns {SubagentScheduler} Scheduler owned by this plugin activation.
 */
export function installSubagentScheduler(service) {
  const previous = schedulers.get(service);
  if (previous?.signal.aborted) {
    if (previous.leases.size) {
      throw new Error('SUBAGENT_SCHEDULER_DRAINING');
    }
    schedulers.delete(service);
  }
  return getSubagentScheduler(service);
}

/**
 * Apply a saved configuration to the shared pool without discarding queued or active owners.
 * @param {object} service - Injected Host subagent service, when available.
 * @param {object} config - Effective configuration after successful persistence.
 * @returns {void}
 */
export function configureSubagentScheduler(service, config) {
  if (service) {
    getSubagentScheduler(service).configure(config.ai?.delegation?.maxConcurrency);
  }
}
