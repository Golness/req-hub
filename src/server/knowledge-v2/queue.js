import { randomUUID } from 'node:crypto';
import { fail, now, publicError, LIMITS } from './contracts.js';

const TERMINAL = new Set(['completed', 'skipped', 'failed', 'cancelled', 'interrupted']);

/**
 * Persistent per-scope job manifests with one global serial model runner.
 * Restarted running jobs become interrupted; restored queued jobs wait for an
 * explicit user resume instead of consuming model calls automatically.
 */
export class KnowledgeQueue {
  /**
   * @param options - {getStores, runJob, onChange}; runJob owns model execution.
   */
  constructor({ getStores, runJob, onChange }) {
    this.getStores = getStores;
    this.runJob = runJob;
    this.onChange = onChange;
    this.pending = Promise.resolve();
    this.active = new Map();
    this.auto = new Set();
    this.closed = false;
  }
  /** Mark interrupted work from a previous process; never auto-resume it. */
  async recover(store) {
    await store.run(async () => {
      const manifest = await store.jobs();
      let changed = false;
      for (const job of manifest.jobs) {
        if (job.status === 'running' || job.status === 'cancelling') {
          job.status = 'interrupted';
          job.error = { code: 'KB_INTERRUPTED', details: {}, retryable: true };
          job.finishedAt = now();
          changed = true;
        }
      }
      if (changed) {
        await store.writeJobs(manifest);
      }
    });
  }
  async update(store, jobId, patch) {
    let updated;
    await store.run(async () => {
      const manifest = await store.jobs();
      const job = manifest.jobs.find((item) => item.id === jobId);
      if (!job) {
        fail('KB_JOB_MISSING', 404, { jobId });
      }
      Object.assign(job, patch, { updatedAt: now() });
      updated = job;
      await store.writeJobs(manifest);
    });
    this.onChange?.(updated);
    return updated;
  }
  /**
   * Persist one job with requestKey idempotency, then start the serial runner.
   * @param store - Owning scope store.
   * @param spec - {kind, requestKey, inputHash, sourceIds, sourceRevisions, rulesHash}.
   * @returns The queued or existing job record.
   */
  async enqueue(store, spec) {
    if (this.closed) {
      fail('KB_STORAGE_BUSY', 503);
    }
    if (!spec.requestKey || typeof spec.requestKey !== 'string') {
      fail('KB_JOB_INVALID', 400);
    }
    let job;
    await store.run(async () => {
      const manifest = await store.jobs();
      const prior = manifest.jobs.find((item) => item.requestKey === spec.requestKey);
      if (prior) {
        if (prior.inputHash !== spec.inputHash) {
          fail('KB_JOB_CONFLICT', 409, { requestKey: spec.requestKey });
        }
        job = prior;
        return;
      }
      job = {
        id: randomUUID(),
        scopeId: store.scope.scopeId,
        status: 'queued',
        createdAt: now(),
        ...spec,
      };
      manifest.jobs.push(job);
      trimJobs(manifest);
      await store.writeJobs(manifest);
    });
    this.onChange?.(job);
    if (job.status === 'queued') {
      this.auto.add(job.id);
      this.pump();
    }
    return job;
  }
  /**
   * Wait until a queued compile reaches a terminal state, bounded so a slow
   * model job cannot block the daily batch indefinitely.
   * @param store - Owning scope store.
   * @param jobId - Job identity.
   * @param options - {signal, timeoutMs}.
   * @returns The latest job record, or null when it is no longer persisted.
   */
  async waitFor(store, jobId, { signal, timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      signal?.throwIfAborted();
      const manifest = await store.jobs();
      const job = manifest.jobs.find((item) => item.id === jobId);
      if (!job || TERMINAL.has(job.status) || Date.now() >= deadline) {
        return job || null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  pump() {
    this.pending = this.pending
      .catch(() => {
        // A failed job must not block later queued work.
      })
      .then(async () => {
        while (!this.closed && (await this.runNext())) {
          // Sequential by design: one knowledge model task for the whole plugin.
        }
      });
    return this.pending;
  }
  async runNext() {
    for (const store of this.getStores()) {
      const manifest = await store.jobs();
      const job = manifest.jobs.find((item) => item.status === 'queued' && this.auto.has(item.id));
      if (job) {
        await this.execute(store, job);
        return true;
      }
    }
    return false;
  }
  async execute(store, job) {
    const controller = new AbortController();
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    this.active.set(job.id, { controller, done });
    try {
      await this.update(store, job.id, { status: 'running', stage: 'reading', startedAt: now() });
      const result = await this.runJob(job, {
        store,
        signal: controller.signal,
        onStage: (stage) => {
          void this.update(store, job.id, { stage }).catch(() => {});
        },
      });
      await this.update(store, job.id, {
        status: result?.skipped ? 'skipped' : 'completed',
        stage: result?.skipped ? null : 'published',
        generationId: result?.generationId || null,
        summary: result?.summary || null,
        findings: result?.findings || null,
        error: null,
        finishedAt: now(),
      });
    } catch (error) {
      const status = controller.signal.aborted
        ? 'cancelled'
        : error.code === 'KB_STALE'
          ? 'interrupted'
          : 'failed';
      await this.update(store, job.id, {
        status,
        stage: null,
        error: publicError(error),
        finishedAt: now(),
      });
    } finally {
      this.active.delete(job.id);
      this.auto.delete(job.id);
      settle();
    }
  }
  /**
   * Cancel one job and wait for its execution to truly end.
   * @param store - Owning scope store.
   * @param jobId - Job identity.
   * @returns The terminal job record.
   */
  async cancel(store, jobId) {
    const active = this.active.get(jobId);
    if (active) {
      await this.update(store, jobId, { status: 'cancelling' });
      active.controller.abort(Object.assign(new Error('KB_CANCELLED'), { code: 'KB_CANCELLED' }));
      await active.done;
    } else {
      await store.run(async () => {
        const manifest = await store.jobs();
        const job = manifest.jobs.find((item) => item.id === jobId);
        if (!job) {
          fail('KB_JOB_MISSING', 404, { jobId });
        }
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.finishedAt = now();
          this.auto.delete(jobId);
          await store.writeJobs(manifest);
        }
      });
    }
    const manifest = await store.jobs();
    return manifest.jobs.find((item) => item.id === jobId);
  }
  /** Resume a restored queued job or retry a terminal failure as a new job. */
  async resume(store, jobId) {
    const manifest = await store.jobs();
    const job = manifest.jobs.find((item) => item.id === jobId);
    if (!job) {
      fail('KB_JOB_MISSING', 404, { jobId });
    }
    if (job.status === 'queued') {
      this.auto.add(job.id);
      this.pump();
      return job;
    }
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status)) {
      fail('KB_JOB_NOT_RETRYABLE', 409, { status: job.status });
    }
    return this.enqueue(store, {
      kind: job.kind,
      requestKey: randomUUID(),
      inputHash: job.inputHash,
      sourceIds: job.sourceIds,
      sourceRevisions: job.sourceRevisions,
      rulesHash: job.rulesHash,
      retryOf: job.id,
    });
  }
  /** Stop admission and signal all running work before waiting for any owner. */
  beginClose() {
    this.closed = true;
    for (const { controller } of this.active.values()) {
      controller.abort(Object.assign(new Error('KB_CANCELLED'), { code: 'KB_CANCELLED' }));
    }
  }
  /** Abort all running work and wait for the runner to become quiescent. */
  async close() {
    this.beginClose();
    await this.pending;
    for (const store of this.getStores()) {
      await this.recover(store);
    }
  }
}

function trimJobs(manifest) {
  const active = manifest.jobs.filter((job) =>
    ['queued', 'running', 'cancelling'].includes(job.status),
  );
  const terminal = manifest.jobs
    .filter((job) => !['queued', 'running', 'cancelling'].includes(job.status))
    .sort((a, b) =>
      String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)),
    );
  manifest.jobs = [...active, ...terminal.slice(0, LIMITS.retainedJobs)];
}
