import model from '../shared/sync-task.cjs';
import { updateSyncProgress, completeSync } from './sync-state.js';

/** One ordered writer owns steps, chunks, publication metadata and terminal snapshots. */
export class SyncLifecycle {
  constructor(task, emit = () => {}) { this.task = task; this.emit = emit; this.pending = Promise.resolve(); }
  enqueue(work) {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }
  event(event) {
    return this.enqueue(async () => {
      if (!model.updateSyncTask(this.task, event)) return;
      await updateSyncProgress(this.task.id, this.task, this.task.workspaceId, this.task.requirementId);
      this.emit({ type: 'state', sync: structuredClone(this.task) });
    });
  }
  step(phase, updates) { return this.event({ type: 'step', phase, updates }); }
  file(phase, fileName) { return this.event({ type: 'file', phase, fileName }); }
  metadata(updates) { return this.event({ type: 'metadata', updates }); }
  chunk(phase, chunkIndex, updates) { return this.event({ type: 'chunk', phase, chunkIndex, updates }); }
  async optional(phase, { signal, text }, work) {
    signal?.throwIfAborted();
    const analysis = this.task.steps.find(step => step.phase === 'analysis');
    if (phase === 'index' && analysis && analysis.status !== 'completed') {
      return this.step(phase, { status: 'skipped', text: '构建分析未成功，未重建依赖它的索引' });
    }
    await this.step(phase, { status: 'running', text });
    try {
      const updates = await work();
      signal?.throwIfAborted();
      await this.step(phase, { ...updates, status: 'completed' });
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.step(phase, { status: 'failed', error: error.message, text: error.message });
    }
  }
  finish(options = {}) {
    return this.enqueue(async () => {
      model.finishSyncTask(this.task, options);
      await updateSyncProgress(this.task.id, this.task, this.task.workspaceId, this.task.requirementId);
      await completeSync(this.task.id, this.task.workspaceId, this.task.requirementId);
      this.emit({ type: 'state', sync: structuredClone(this.task) });
      return this.task;
    });
  }
  async progress(progress) {
    const { phase, status } = progress;
    if (status === 'output_file') return;
    if (status === 'summary_subagent') {
      await this.metadata({ currentSubagentSessionId: progress.sessionId });
      return this.step(phase, { summarySessionId: progress.sessionId });
    }
    if (['waiting_for_slot', 'processing_chunk', 'chunk_subagent', 'chunk_completed', 'chunk_failed', 'chunk_aborted'].includes(status)) {
      const chunkIndex = progress.chunkIndex ?? progress.chunk - 1;
      const state = { waiting_for_slot: 'queued', processing_chunk: 'running', chunk_subagent: 'running', chunk_completed: 'completed', chunk_failed: 'failed', chunk_aborted: 'aborted' }[status];
      return this.chunk(phase, chunkIndex, { status: state, ...(progress.sessionId ? { sessionId: progress.sessionId } : {}), ...(progress.error ? { error: progress.error } : {}) });
    }
    if (['started', 'completed', 'failed', 'skipped', 'aborted'].includes(status)) {
      const state = status === 'started' ? 'running' : status;
      return this.step(phase, { status: state, ...(progress.error ? { error: progress.error } : {}), text: progress.error || progress.reason || ({ running: '执行中…', completed: '已完成', skipped: '无相关变更' }[state] || '执行失败') });
    }
    if (status === 'merging_chunks') return this.step(phase, { text: '汇总分块分析…' });
  }
}
