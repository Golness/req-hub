import { AsyncLocalStorage } from 'node:async_hooks';

/** Carry one execution's cancellation through nested read-only Git preparation helpers. */
export const syncCancellation = new AsyncLocalStorage();

/**
 * Read and check the current execution signal before starting a preparation subprocess.
 * @returns {AbortSignal|undefined} The owning task's signal, when called during a sync.
 */
export function syncSignal() {
  const signal = syncCancellation.getStore();
  signal?.throwIfAborted();
  return signal;
}
