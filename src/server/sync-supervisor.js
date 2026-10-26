import model from '../shared/sync-task.cjs';
import { randomUUID } from 'node:crypto';

export const SYNC_LIMITS = { preparing: 5 * 60_000, idle: 25 * 60_000, total: 6 * 60 * 60_000, cancelling: 30_000 };

/** One host-owned lease across workspaces and both document types. Polling never extends it. */
export class SyncSupervisor {
  constructor({ now = Date.now, limits = SYNC_LIMITS } = {}) {
    this.now = now; this.limits = limits; this.owner = null; this.latest = null;
  }
  acquire(fields) {
    if (this.owner) return null;
    const owner = { fields, notificationId: randomUUID(), controller: new AbortController(), startedAt: this.now(), lastProgressAt: this.now(), task: null };
    this.owner = owner;
    owner.controller.signal.addEventListener('abort', () => { owner.cancelledAt ??= this.now(); }, { once: true });
    return owner;
  }
  attach(owner, task, recover) {
    this.assert(owner); owner.task = task; owner.recover = recover; this.touch(owner);
  }
  assert(owner) {
    if (owner.deleted) throw new Error('SYNC_TASK_DELETED');
    owner.controller.signal.throwIfAborted();
    if (this.owner !== owner) throw new Error('SYNC_LEASE_EXPIRED: 同步任务执行权已失效');
  }
  touch(owner) { if (this.owner === owner) owner.lastProgressAt = this.now(); }
  preparing(owner, activity) { this.assert(owner); owner.activity = activity; this.touch(owner); }
  reason(owner = this.owner) {
    if (!owner) return null;
    const now = this.now();
    if (owner.cancelledAt != null && now - owner.cancelledAt >= this.limits.cancelling) return 'SYNC_CANCEL_TIMEOUT: 取消收尾超时，已回收任务';
    if (now - owner.startedAt >= this.limits.total) return 'SYNC_TOTAL_TIMEOUT: 同步任务超过总执行时限';
    if (now - owner.lastProgressAt >= (owner.task ? this.limits.idle : this.limits.preparing)) return 'SYNC_PROGRESS_TIMEOUT: 同步执行长时间无进展，已回收任务';
    return null;
  }
  async check() {
    const owner = this.owner, reason = this.reason(owner);
    if (!owner || !reason) return false;
    await this.expire(owner, reason);
    return true;
  }
  async expire(owner, reason) {
    if (this.owner !== owner) return;
    if (owner.recovering) { await owner.recovering; return true; }
    owner.recovering = (async () => {
      owner.controller.abort(new Error(reason));
      try {
        await owner.recover?.(reason);
        if (!owner.task) owner.notice = { ...owner.fields, notificationId: owner.notificationId, status: 'failed', error: reason, completedAt: this.now(), steps: [] };
      } finally { this.release(owner, true); owner.onRecovered?.(reason); }
    })();
    await owner.recovering;
    return true;
  }
  release(owner, recovered = false) {
    if (owner.recovering && !recovered) return;
    const task = owner.task || owner.notice;
    this.remember(task);
    if (this.owner === owner) this.owner = null;
  }
  remember(task) {
    if (task && !task.removed && task.completedAt && !model.isSyncActive(task) && (!this.latest || task.completedAt >= (this.latest.completedAt || 0))) this.latest = structuredClone(task);
  }
  remove(target) {
    const matches = task => task && task.workspaceId === target.workspaceId && task.requirementId === target.requirementId
      && (target.snapshotDir ? task.snapshotDir === target.snapshotDir && task.id === target.id : target.notificationId ? task.notificationId === target.notificationId : task.id === target.id);
    const owner = this.owner;
    if (owner && matches(owner.task || { ...owner.fields, notificationId: owner.notificationId })) {
      owner.deleted = true;
      if (owner.task) { owner.task.removed = true; model.finishSyncTask(owner.task, { status: 'aborted' }); }
      try { owner.revoke?.(); } catch { /* Execution fencing remains authoritative. */ }
      try { owner.controller.abort(); } catch { /* Deletion must not depend on host termination. */ }
      this.release(owner, true);
      try { owner.onRecovered?.('SYNC_TASK_DELETED'); } catch { /* Disconnected client. */ }
    }
    if (matches(this.latest)) this.latest = null;
  }
  snapshot() {
    const owner = this.owner;
    const steps = owner && !owner.task ? model.createSyncSteps() : [];
    if (steps.length) Object.assign(steps[0], { status: 'running', startedAt: owner.startedAt, activity: owner.activity || { stage: 'preparing' } });
    return { active: owner ? structuredClone(owner.task || { ...owner.fields, notificationId: owner.notificationId, status: 'preparing', startedAt: owner.startedAt, steps }) : null,
      latest: this.latest, lastProgressAt: owner?.lastProgressAt, limits: this.limits };
  }
}

export const syncSupervisor = new SyncSupervisor();
