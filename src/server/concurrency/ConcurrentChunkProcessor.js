/**
 * 并发 Chunk 处理器
 *
 * 设计要点：
 * 1. 最多 MAX_CONCURRENCY(3) 个 subagent 同时运行
 * 2. 单个 chunk 失败不影响其他 chunk（Promise.allSettled 语义）
 * 3. 支持 AbortSignal 取消（与现有 signal 机制对齐）
 * 4. 失败 chunk 记录到 errors[]，不中断整体流程
 * 5. 进度事件实时推送（每个 chunk 开始/完成/失败都推送）
 */

import { BoundedSemaphore, AbortError } from './BoundedSemaphore.js';
import { log } from '../logger.js';

export class ConcurrentChunkProcessor {
  constructor(options = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 3;
    this.semaphore = new BoundedSemaphore(this.maxConcurrency);
  }

  /**
   * 并发处理所有 chunk
   *
   * @param {Array} chunks - chunk 数组
   * @param {Function} processFn - async (chunk, chunkIndex) => result
   * @param {Object} options - { signal, onProgress, phase }
   * @returns {{ results: Array, errors: Array, stats: Object, hasFailedChunks: boolean }}
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

    // 为每个 chunk 创建一个 Promise
    const tasks = chunks.map((chunk, index) =>
      this._processChunk(chunk, index, processFn, { signal, onProgress, phase, results, errors, stats })
    );

    // 等待所有任务完成（包括成功和失败）
    await Promise.allSettled(tasks);

    stats.endTime = Date.now();
    stats.duration = stats.endTime - stats.startTime;

    //  修复 Issue #5: 保留失败 chunk 的位置信息
    // 返回 hasFailedChunks 标志，让调用方知道是否有 chunk 失败
    // 调用方在 merge 前可以检查这个标志，决定是否将错误信息附加到 merge prompt
    const hasFailedChunks = stats.failed > 0;

    //  修复 Issue #6: 过滤时只保留非 null 且非 undefined 的结果
    // 避免 processFn 返回 undefined 时 stats.completed 与实际 results.length 不一致
    const validResults = results.filter(r => r != null);

    return { results: validResults, errors, stats, hasFailedChunks };
  }

  async _processChunk(chunk, index, processFn, ctx) {
    const { signal, onProgress, phase, results, errors, stats } = ctx;
    let slot;

    try {
      // 1. 检查是否已取消
      if (signal?.aborted) {
        stats.skipped++;
        return;
      }

      // 2. 获取并发槽位（可能排队等待）
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

      // 3. 再次检查取消（可能在排队期间被取消）
      if (signal?.aborted) {
        stats.skipped++;
        return;
      }

      // 4. 开始处理
      await onProgress?.({
        phase,
        status: 'processing_chunk',
        chunk: index + 1,
        total: stats.total,
        running: this.semaphore.runningCount,
        waiting: this.semaphore.waitingCount,
      });

      // 5. 执行实际处理
      const result = await processFn(chunk, index);

      //  修复 Issue #6: 检查结果有效性
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
      // 6. 错误处理：区分取消和真正的失败
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
      // 7. 释放槽位（幂等，确保释放）
      slot?.release();
    }
  }
}
