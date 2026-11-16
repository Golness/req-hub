import { currentContentLanguage } from './content-templates.js';
import { msg, messageFromDescriptor } from './messages.js';
import { Worker } from 'node:worker_threads';

export const BINARY_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx']);
export const MAX_BINARY_BYTES = 20 * 1024 * 1024;
export const PARSE_LIMITS = Object.freeze({
  characters: 2_000_000,
  pages: 500,
  sheets: 50,
  cells: 100_000,
  blocks: 10_000,
  zipBytes: 40 * 1024 * 1024,
  zipEntries: 10_000,
});

/** Parse bounded PDF, Word or spreadsheet content in a worker. */
export function parseBinary(bytes, extension, { signal, timeoutMs = 30_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./binary-parser-worker.js', import.meta.url), {
      workerData: {
        bytes,
        extension,
        limits: PARSE_LIMITS,
        contentLanguage: currentContentLanguage(),
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    });
    let finished = false;
    const finish = (error, result) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const abort = () => finish(signal.reason || new Error('TASK_CANCELLED'));
    const timer = setTimeout(() => finish(new Error('ERR_DOC_PARSE_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message) =>
      finish(message.error ? messageFromDescriptor(message.error) : null, message.result),
    );
    worker.once('error', (error) =>
      finish(msg('ERR_DOC_PARSE_FAILED_WITH_REASON', { v0: error.message })),
    );
    worker.once('exit', (code) => {
      if (!finished) {
        finish(msg('ERR_DOC_PARSE_WORKER_EXITED', { v0: code }));
      }
    });
    if (signal?.aborted) {
      abort();
    }
  });
}
