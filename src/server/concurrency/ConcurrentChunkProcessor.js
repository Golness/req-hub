/** Run chunks with bounded concurrency, preserving failures without stopping sibling chunks. */

import { BoundedSemaphore, AbortError } from './BoundedSemaphore.js';
import { log } from '../logger.js';

/** Isolate per-chunk failures while waiting for every acquired slot to be released. */
export class ConcurrentChunkProcessor {
  constructor(options = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 3;
    this.semaphore = new BoundedSemaphore(this.maxConcurrency);
  }

  /**
   * Wait for all chunks, including failed and cancelled work.
   * @param {Array} chunks - Input chunks in source order.
   * @param {Function} processFn - Async processor receiving a chunk and its zero-based index.
   * @param {Object} [options] - Cancellation, progress callback and phase.
   * @returns {Promise<Object>} Successful results, indexed errors, counts and a failure flag.
   */
  async processAll(chunks, processFn, options = {}) {
    const { signal, onProgress, phase } = options;
    const results = new Array(chunks.length).fill(null);
    const errors = [];
    const stats = {
      total: chunks.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      startTime: Date.now(),
    };

    const tasks = chunks.map((chunk, index) =>
      this._processChunk(chunk, index, processFn, {
        signal,
        onProgress,
        phase,
        results,
        errors,
        stats,
      }),
    );

    await Promise.allSettled(tasks);

    stats.endTime = Date.now();
    stats.duration = stats.endTime - stats.startTime;

    // Keep failed chunk positions available to the caller before merging results.

    const hasFailedChunks = stats.failed > 0;

    // Null and undefined results are failures and are excluded from successful output.

    const validResults = results.filter((r) => r != null);

    return { results: validResults, errors, stats, hasFailedChunks };
  }

  async _processChunk(chunk, index, processFn, ctx) {
    const { signal, onProgress, phase, results, errors, stats } = ctx;
    let slot;

    try {
      if (signal?.aborted) {
        stats.skipped++;
        return;
      }

      await onProgress?.({
        phase,
        status: 'waiting_for_slot',
        chunk: index + 1,
        total: stats.total,
        waiting: this.semaphore.waitingCount,
        running: this.semaphore.runningCount,
      });

      const acquired = await this.semaphore.acquire(signal);
      slot = acquired.slot;

      if (signal?.aborted) {
        stats.skipped++;
        return;
      }

      await onProgress?.({
        phase,
        status: 'processing_chunk',
        chunk: index + 1,
        total: stats.total,
        running: this.semaphore.runningCount,
        waiting: this.semaphore.waitingCount,
      });

      const result = await processFn(chunk, index);

      if (result == null) {
        stats.failed++;
        errors.push({
          chunk: index + 1,
          error: '处理函数返回空结果',
        });
        log.concurrency.warn(`Chunk ${index + 1} 返回空结果`);

        await onProgress?.({
          phase,
          status: 'chunk_failed',
          chunk: index + 1,
          total: stats.total,
          error: '处理函数返回空结果',
        });
        return;
      }

      results[index] = result;
      stats.completed++;

      await onProgress?.({
        phase,
        status: 'chunk_completed',
        chunk: index + 1,
        total: stats.total,
        completed: stats.completed,
        failed: stats.failed,
      });
    } catch (error) {
      if (signal?.aborted || error instanceof AbortError || error.name === 'AbortError') {
        stats.skipped++;
        await onProgress?.({
          phase,
          status: 'chunk_aborted',
          chunk: index + 1,
          total: stats.total,
        });
      } else {
        stats.failed++;
        errors.push({
          chunk: index + 1,
          error: error.message || String(error),
          stack: error.stack,
        });

        await onProgress?.({
          phase,
          status: 'chunk_failed',
          chunk: index + 1,
          total: stats.total,
          error: error.message,
        });
      }
    } finally {
      slot?.release();
    }
  }
}
