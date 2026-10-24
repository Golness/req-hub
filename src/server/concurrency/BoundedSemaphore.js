/**
 * 有界并发信号量
 *
 * 设计依据：
 * - req-hub 使用 one-shot spawn 模式，不经过 harness 的 ActivationPool
 * - run.result 不会 reject 子代理失败（types.ts:325），需检查 stopReason
 * - run.dispose() 幂等（types.ts:333），可安全在 finally 中调用
 * - BoundedSemaphore 的价值：应用层背压（避免 LLM API rate limit）+ 有序排队 + AbortSignal 集成
 */

import { log } from '../logger.js';

export class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
  }
}

export class BoundedSemaphore {
  constructor(maxConcurrency) {
    this.maxConcurrency = maxConcurrency;
    this.running = 0;
    this.queue = [];       // 等待队列 [{ resolve, reject }]
    //  修复 Issue #4: 移除 this.aborted 死代码
    // 原设计中 abortAll() 设置 this.aborted = true，但 acquire() 从未检查它
    // 如果 abortAll() 的意图是"阻止新的获取"，应该在 acquire() 中检查
    // 如果意图只是"清空等待队列"，则不需要这个标志
    // 当前实现：abortAll() 只清空队列，不阻止新的获取（因为 signal 已经传播取消）
  }

  /**
   * 获取一个执行槽位
   * 如果当前运行数 < maxConcurrency，立即返回
   * 否则排队等待，支持 AbortSignal 取消
   */
  async acquire(signal) {
    // 检查取消
    if (signal?.aborted) {
      throw new AbortError('Operation aborted');
    }

    // 有空位，直接获取
    if (this.running < this.maxConcurrency) {
      this.running++;
      return { slot: this._createSlot() };
    }

    // 无空位，排队等待
    return new Promise((resolve, reject) => {
      //  修复竞态条件：在 Promise 内部再次检查 signal 状态
      // 避免在外部检查后、Promise 创建前 signal 触发的时间窗口
      if (signal?.aborted) {
        reject(new AbortError('Operation aborted'));
        return;
      }

      let settled = false;  // 防止双重 resolve/reject

      // 注册 abort 监听
      const onAbort = () => {
        if (settled) return;
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
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve({ slot });
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      };

      this.queue.push(entry);
    });
  }

  /**
   * 释放一个执行槽位，唤醒队列中下一个等待者
   */
  release() {
    //  修复 Issue #7: 添加警告日志，避免静默掩盖 bug
    if (this.running <= 0) {
      log.concurrency.warn('BoundedSemaphore: release() called when running <= 0, possible double-release bug');
      return;
    }
    this.running--;

    // 唤醒队列中下一个
    if (this.queue.length > 0 && this.running < this.maxConcurrency) {
      this.running++;
      const next = this.queue.shift();
      next.resolve(this._createSlot());
    }
  }

  /**
   * 中止所有等待中的任务
   * 注意：正在运行的任务不受影响，它们通过各自的 AbortSignal 传播取消
   */
  abortAll() {
    //  修复 Issue #4: 移除 this.aborted = true（死代码）
    // abortAll() 只清空等待队列，不阻止新的获取
    // 因为取消通过 signal 传播，不需要信号量层面的全局标志
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

  get waitingCount() { return this.queue.length; }
  get runningCount() { return this.running; }
}
