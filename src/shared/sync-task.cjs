'use strict';

const TASK_ACTIVE = new Set(['running', 'cancelling']);
const TERMINAL = new Set(['completed', 'failed', 'aborted', 'skipped']);
const OPEN = new Set(['pending', 'queued', 'running']);
const PHASES = [
  ['init', '同步检查'],
  ['code_analysis', '代码差异分析'],
  ['discussion_analysis', '讨论差异分析'],
  ['merge', '隔离文档局部编辑'],
  ['validate', '补丁与字节校验'],
  ['publish', '一致性发布'],
];

/**
 * Create the fixed step plan, including discussion only when sessions were selected.
 * @param [options] - Task outcome or selection options.
 * @returns New pending step records.
 */
function createSyncSteps({ sessionIds = [] } = {}) {
  return PHASES.filter(([phase]) => phase !== 'discussion_analysis' || sessionIds.length).map(
    ([phase, label]) => ({ phase, label, status: 'pending', text: '', files: [], chunks: null }),
  );
}

function setUnit(unit, updates, now) {
  if (TERMINAL.has(unit.status)) {
    return false;
  }
  if (unit.status === 'running' && updates.status === 'queued') {
    return false;
  }
  if (updates.status && !OPEN.has(updates.status) && !TERMINAL.has(updates.status)) {
    throw new Error('SYNC_UNIT_STATUS');
  }
  Object.assign(unit, updates);
  if (unit.status === 'running') {
    unit.startedAt ??= now;
  }
  if (TERMINAL.has(unit.status)) {
    unit.completedAt ??= now;
  }
  return true;
}

/**
 * Apply a scoped progress event without reopening terminal tasks or steps.
 * @param task - The scoped sync task; this function may update it in place.
 * @param event - The shared task-model progress event.
 * @param [now] - Observation time in milliseconds.
 * @returns Whether the task accepted the event.
 */
function updateSyncTask(task, event, now = Date.now()) {
  if (!TASK_ACTIVE.has(task.status)) {
    return false;
  }
  if (event.type === 'cancel') {
    task.status = 'cancelling';
    task.cancelRequestedAt ??= now;
    return true;
  }
  if (event.type === 'metadata') {
    if (
      ['status', 'steps', 'completedAt', 'id', 'workspaceId', 'requirementId'].some(
        (key) => key in event.updates,
      )
    ) {
      throw new Error('SYNC_METADATA_SCOPE');
    }
    Object.assign(task, event.updates);
    return true;
  }
  const step = task.steps?.find((s) => s.phase === event.phase);
  if (!step) {
    return false;
  }
  if (event.type === 'step') {
    return setUnit(step, event.updates, now);
  }
  if (event.type === 'file') {
    step.files ||= [];
    task.generatedFiles ||= [];
    const artifact =
      typeof event.fileName === 'object' ? event.fileName : { fileName: event.fileName };
    if (!step.files.includes(artifact.fileName)) {
      step.files.push(artifact.fileName);
    }
    if (
      !task.generatedFiles.some(
        (file) => file.phase === event.phase && file.fileName === artifact.fileName,
      )
    ) {
      task.generatedFiles.push({ phase: event.phase, ...artifact });
    }
    return true;
  }
  if (event.type === 'chunk') {
    if (TERMINAL.has(step.status)) {
      return false;
    }
    step.chunks ||= [];
    const index = event.chunkIndex;
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('SYNC_CHUNK_INDEX');
    }
    step.chunks[index] ||= { index, status: 'pending' };
    const changed = setUnit(step.chunks[index], event.updates, now);
    if (event.updates.sessionId) {
      task.currentSubagentSessionId = event.updates.sessionId;
    }
    return changed;
  }
  throw new Error('SYNC_TASK_EVENT');
}

// Only this function chooses a terminal task outcome and closes unfinished units.
/**
 * Settle unfinished steps consistently with the final task outcome.
 * @param task - The scoped sync task; this function may update it in place.
 * @param [options] - Task outcome or selection options.
 * @returns The updated task record.
 */
function finishSyncTask(task, { status, error, phase, now = Date.now() } = {}) {
  if (TERMINAL.has(task.status) && task.completedAt) {
    return task;
  }
  const steps = task.steps || [];
  const aborted = status === 'aborted' || task.status === 'cancelling' || task.status === 'aborted';
  const failed =
    status === 'failed' ||
    !!error ||
    task.status === 'failed' ||
    steps.some((s) => s.status === 'failed' || s.chunks?.some((c) => c?.status === 'failed'));
  const unfinished = steps.some(
    (s) => !TERMINAL.has(s.status) || s.chunks?.some((c) => c && !TERMINAL.has(c.status)),
  );
  let outcome;
  if (aborted) {
    outcome = 'aborted';
  } else if (failed || unfinished) {
    outcome = 'failed';
  } else {
    outcome = status || (TERMINAL.has(task.status) ? task.status : 'completed');
  }
  task.status = outcome;
  task.completedAt = now;
  if (outcome === 'aborted') {
    task.abortedAt ??= now;
  }
  if (error) {
    task.error = error;
  }
  if (outcome === 'failed' && !task.error) {
    task.error =
      steps.find((s) => s.status === 'failed')?.error ||
      steps.find((s) => s.status === 'failed')?.text ||
      '同步未完成';
  }
  const target =
    steps.find((s) => s.phase === phase && OPEN.has(s.status)) ||
    steps.find((s) => s.status === 'running') ||
    steps.find((s) => s.status === 'queued') ||
    (!steps.some((s) => s.status === 'failed') && steps.find((s) => s.status === 'pending'));
  for (const step of steps) {
    if (!TERMINAL.has(step.status)) {
      let status;
      if (outcome === 'aborted') {
        status = 'aborted';
      } else if (step === target) {
        status = 'failed';
      } else {
        status = 'skipped';
      }
      let text = '前序步骤失败，未执行';
      if (status === 'failed') {
        text = task.error;
      } else if (status === 'aborted') {
        text = '任务已取消';
      }
      setUnit(step, { status, text }, now);
    }
    for (const chunk of step.chunks || []) {
      if (chunk && !TERMINAL.has(chunk.status)) {
        setUnit(
          chunk,
          {
            status: outcome === 'aborted' ? 'aborted' : 'failed',
            error: task.error || '所属步骤已结束',
          },
          now,
        );
      }
    }
  }
  delete task.currentSubagentSessionId;
  return task;
}

/**
 * Clone task state for publication without sharing mutable progress objects.
 * @param task - The scoped sync task; this function may update it in place.
 * @returns An independent JSON snapshot of the task.
 */
function snapshotSyncTask(task) {
  const { workspace, docsRoot, ...state } = task;
  return structuredClone(state);
}
/**
 * Check whether a task is still running or cancelling.
 * @param task - The scoped sync task; this function may update it in place.
 * @returns Whether execution remains active.
 */
function isSyncActive(task) {
  return TASK_ACTIVE.has(task?.status);
}
/**
 * Check publication metadata rather than only terminal status.
 * @param task - The scoped sync task; this function may update it in place.
 * @returns Whether the task records a published document.
 */
function hasPublishedDocument(task) {
  return task?.status === 'completed' || task?.publishState === 'state_committed';
}
/**
 * Identify stored tasks whose state needs consistency repair.
 * @param task - The scoped sync task; this function may update it in place.
 * @returns Whether repair is required.
 */
function needsSyncRepair(task) {
  return (
    !TERMINAL.has(task.status) ||
    !task.completedAt ||
    (task.steps || []).some(
      (s) => !TERMINAL.has(s.status) || s.chunks?.some((c) => c && !TERMINAL.has(c.status)),
    )
  );
}
/**
 * Repair inconsistent persisted task state using the shared terminal rules.
 * @param task - The scoped sync task; this function may update it in place.
 * @returns The repaired task record.
 */
function repairSyncTask(task) {
  if (!needsSyncRepair(task)) {
    return task;
  }
  const now = task.completedAt || Date.now();
  delete task.completedAt;
  const interrupted = !TERMINAL.has(task.status);
  return finishSyncTask(task, {
    status: interrupted ? 'failed' : task.status,
    error: interrupted ? task.error || '任务已中断，历史记录缺少结束状态' : task.error,
    now,
  });
}
module.exports = {
  snapshotSyncTask,
  createSyncSteps,
  updateSyncTask,
  finishSyncTask,
  isSyncActive,
  hasPublishedDocument,
  needsSyncRepair,
  repairSyncTask,
};
