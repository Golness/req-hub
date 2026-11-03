import model from '../shared/sync-task.cjs';
import { randomUUID } from 'node:crypto';

export const SYNC_LIMITS = {
  preparing: 5 * 60_000,
  idle: 25 * 60_000,
  total: 6 * 60 * 60_000,
  cancelling: 30_000,
};

/** One host-owned lease across workspaces and both document types. Polling never extends it. */
export class SyncSupervisor {
  constructor({ now = Date.now, limits = SYNC_LIMITS } = {}) {
    this.now = now;
    this.limits = limits;
    this.owner = null;
    this.latest = null;
  }
  acquire(fields) {
    if (this.owner) {
      return null;
    }
    const owner = {
      fields,
      notificationId: randomUUID(),
      controller: new AbortController(),
      startedAt: this.now(),
      lastProgressAt: this.now(),
      task: null,
    };
    this.owner = owner;
    owner.controller.signal.addEventListener(
      'abort',
      () => {
        owner.cancelledAt ??= this.now();
      },
      { once: true },
    );
    return owner;
  }
  /**
   * Start one Host-owned sequence using the existing reservation and cancellation signal.
   * @param owner - The acquired execution lease.
   * @returns The observable sequence identity and document outcomes.
   */
  beginQuick(owner) {
    this.assert(owner);
    owner.quickSync = {
      id: owner.notificationId,
      workspaceId: owner.fields.workspaceId,
      requirementId: owner.fields.requirementId,
      status: 'running',
      stage: 'requirement',
      startedAt: owner.startedAt,
      documents: [],
    };
    owner.fields.quickSyncId = owner.quickSync.id;
    return owner.quickSync;
  }
  /**
   * Advance within the same lease only after the previous document has settled.
   * @param owner - The sequence lease; deletion or cancellation rejects advancement.
   * @param docType - The next document type.
   * @returns No value; the shared reservation remains held.
   */
  advanceQuick(owner, docType) {
    this.assert(owner);
    this.remember(owner.task);
    owner.task = null;
    owner.recover = null;
    owner.quickSync.stage = docType;
    Object.assign(owner.fields, {
      docType,
      docTypeName: docType === 'design' ? '技术方案' : '需求文档',
    });
    this.preparing(owner, { stage: 'preparing' });
  }
  /**
   * Settle a sequence once; late completions cannot replace an aborted or failed outcome.
   * @param owner - The sequence's execution lease.
   * @param status - Explicit terminal outcome.
   * @param error - Optional stable failure reason.
   * @returns The terminal sequence snapshot, if this is a quick sync.
   */
  finishQuick(owner, status, error) {
    const sequence = owner?.quickSync;
    if (!sequence || sequence.status !== 'running') {
      return sequence;
    }
    Object.assign(sequence, { status, completedAt: this.now(), ...(error ? { error } : {}) });
    this.latestQuickSync = structuredClone(sequence);
    if (!owner.task || (status !== 'completed' && !model.isSyncActive(owner.task))) {
      owner.notice = {
        ...owner.fields,
        notificationId: owner.notificationId,
        status,
        startedAt: sequence.startedAt,
        completedAt: sequence.completedAt,
        steps: [],
        ...(error ? { error } : {}),
      };
    }
    return sequence;
  }
  attach(owner, task, recover) {
    this.assert(owner);
    owner.task = task;
    owner.recover = recover;
    this.touch(owner);
  }
  assert(owner) {
    if (owner.deleted) {
      throw new Error('SYNC_TASK_DELETED');
    }
    owner.controller.signal.throwIfAborted();
    if (this.owner !== owner) {
      throw new Error('SYNC_LEASE_EXPIRED: 同步任务执行权已失效');
    }
  }
  touch(owner) {
    if (this.owner === owner) {
      owner.lastProgressAt = this.now();
    }
  }
  preparing(owner, activity) {
    this.assert(owner);
    owner.activity = activity;
    this.touch(owner);
  }
  reason(owner = this.owner) {
    if (!owner) {
      return null;
    }
    const now = this.now();
    if (owner.cancelledAt != null && now - owner.cancelledAt >= this.limits.cancelling) {
      return 'SYNC_CANCEL_TIMEOUT: 取消收尾超时，已回收任务';
    }
    if (now - owner.startedAt >= this.limits.total) {
      return 'SYNC_TOTAL_TIMEOUT: 同步任务超过总执行时限';
    }
    if (now - owner.lastProgressAt >= (owner.task ? this.limits.idle : this.limits.preparing)) {
      return 'SYNC_PROGRESS_TIMEOUT: 同步执行长时间无进展，已回收任务';
    }
    return null;
  }
  async check() {
    const owner = this.owner;
    const reason = this.reason(owner);
    if (!owner || !reason) {
      return false;
    }
    await this.expire(owner, reason);
    return true;
  }
  async expire(owner, reason) {
    if (this.owner !== owner) {
      return;
    }
    if (owner.recovering) {
      await owner.recovering;
      return true;
    }
    owner.recovering = (async () => {
      owner.controller.abort(new Error(reason));
      try {
        await owner.recover?.(reason);
        if (!owner.task) {
          owner.notice = {
            ...owner.fields,
            notificationId: owner.notificationId,
            status: 'failed',
            error: reason,
            completedAt: this.now(),
            steps: [],
          };
        }
      } finally {
        this.release(owner, true);
        owner.onRecovered?.(reason);
      }
    })();
    await owner.recovering;
    return true;
  }
  release(owner, recovered = false) {
    if (owner.recovering && !recovered) {
      return;
    }
    const task = owner.notice || owner.task;
    this.remember(task);
    if (this.owner === owner) {
      this.owner = null;
    }
  }
  remember(task) {
    if (
      task &&
      !task.removed &&
      task.completedAt &&
      !model.isSyncActive(task) &&
      (!this.latest || task.completedAt >= (this.latest.completedAt || 0))
    ) {
      this.latest = model.snapshotSyncTask(task);
    }
  }
  remove(target) {
    const matches = (task) => {
      if (!task) {
        return task;
      }
      if (task.workspaceId !== target.workspaceId || task.requirementId !== target.requirementId) {
        return false;
      }
      if (target.snapshotDir) {
        return task.snapshotDir === target.snapshotDir && task.id === target.id;
      }
      if (target.notificationId) {
        return task.notificationId === target.notificationId;
      }
      return task.id === target.id;
    };
    const owner = this.owner;
    const sequenceMember = owner?.quickSync?.documents.some((task) => matches(task));
    if (owner && sequenceMember && !matches(owner.task)) {
      owner.controller.abort(new Error('SYNC_TASK_DELETED'));
      this.finishQuick(owner, 'aborted', 'SYNC_TASK_DELETED');
    }
    if (owner && matches(owner.task || { ...owner.fields, notificationId: owner.notificationId })) {
      this.finishQuick(owner, 'aborted', 'SYNC_TASK_DELETED');
      owner.deleted = true;
      if (owner.task) {
        owner.task.removed = true;
        model.finishSyncTask(owner.task, { status: 'aborted' });
      }
      try {
        owner.revoke?.();
      } catch (error) {
        // Execution fencing is already revoked even if the provider callback fails.
      }
      try {
        owner.controller.abort();
      } catch (error) {
        // Deletion remains fenced even if provider cancellation fails.
      }
      this.release(owner, true);
      try {
        owner.onRecovered?.('SYNC_TASK_DELETED');
      } catch (error) {
        // A disconnected client must not prevent reservation cleanup.
      }
    }
    if (matches(this.latest)) {
      this.latest = null;
    }
  }
  snapshot() {
    const owner = this.owner;
    const steps = owner && !owner.task ? model.createSyncSteps() : [];
    if (steps.length) {
      Object.assign(steps[0], {
        status: 'running',
        startedAt: owner.startedAt,
        activity: owner.activity || { stage: 'preparing' },
      });
    }
    return {
      active: owner
        ? model.snapshotSyncTask(
            owner.task || {
              ...owner.fields,
              notificationId: owner.notificationId,
              status: 'preparing',
              startedAt: owner.startedAt,
              steps,
            },
          )
        : null,
      latest: this.latest,
      lastProgressAt: owner?.lastProgressAt,
      limits: this.limits,
      quickSync: owner?.quickSync ? structuredClone(owner.quickSync) : this.latestQuickSync || null,
    };
  }
}

export const syncSupervisor = new SyncSupervisor();
