import { Worker } from 'node:worker_threads';

export const BINARY_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);
export const MAX_BINARY_BYTES = 20 * 1024 * 1024;
export const PARSE_LIMITS = Object.freeze({ characters: 2_000_000, pages: 500, sheets: 50, cells: 100_000, blocks: 10_000, zipBytes: 40 * 1024 * 1024, zipEntries: 10_000 });

// Terminate CPU-heavy parsers on timeout/cancel instead of blocking the plugin host.
export function parseBinary(bytes, extension, { signal, timeoutMs = 30_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./binary-parser-worker.js', import.meta.url), {
      workerData: { bytes, extension, limits: PARSE_LIMITS },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
    });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason || new Error('任务已取消'));
    const timer = setTimeout(() => finish(new Error('文档解析超过 30 秒，请拆分文件后重试')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', error => finish(new Error(`文档解析失败：${error.message}`)));
    worker.once('exit', code => { if (!finished) finish(new Error(`文档解析进程提前退出（${code}）`)); });
    if (signal?.aborted) abort();
  });
}
