'use strict';

const TASK_ACTIVE = new Set(['running', 'cancelling']);
const TERMINAL = new Set(['completed', 'failed', 'aborted', 'skipped']);
const OPEN = new Set(['pending', 'queued', 'running']);
const PHASES = [
  ['init', '同步检查'], ['code_analysis', '代码差异分析'], ['discussion_analysis', '讨论差异分析'],
  ['merge', '隔离文档局部编辑'], ['validate', '补丁与字节校验'], ['publish', '一致性发布'],
];

function createSyncSteps({ sessionIds = [] } = {}) {
  return PHASES.filter(([phase]) => phase !== 'discussion_analysis' || sessionIds.length)
    .map(([phase, label]) => ({ phase, label, status: 'pending', text: '', files: [], chunks: null }));
}

function setUnit(unit, updates, now) {
  if (TERMINAL.has(unit.status)) return false;
  if (unit.status === 'running' && updates.status === 'queued') return false;
  if (updates.status && !OPEN.has(updates.status) && !TERMINAL.has(updates.status)) throw new Error('SYNC_UNIT_STATUS');
  Object.assign(unit, updates);
  if (unit.status === 'running') unit.startedAt ??= now;
  if (TERMINAL.has(unit.status)) unit.completedAt ??= now;
  return true;
}

function updateSyncTask(task, event, now = Date.now()) {
  if (!TASK_ACTIVE.has(task.status)) return false;
  if (event.type === 'cancel') { task.status = 'cancelling'; task.cancelRequestedAt ??= now; return true; }
  if (event.type === 'metadata') {
    if (['status', 'steps', 'completedAt', 'id', 'workspaceId', 'requirementId'].some(key => key in event.updates)) throw new Error('SYNC_METADATA_SCOPE');
    Object.assign(task, event.updates); return true;
  }
  const step = task.steps?.find(s => s.phase === event.phase);
  if (!step) return false;
  if (event.type === 'step') return setUnit(step, event.updates, now);
  if (event.type === 'file') {
    step.files ||= []; task.generatedFiles ||= [];
    if (!step.files.includes(event.fileName)) step.files.push(event.fileName);
    if (!task.generatedFiles.some(file => file.phase === event.phase && file.fileName === event.fileName)) task.generatedFiles.push({ phase: event.phase, fileName: event.fileName });
    return true;
  }
  if (event.type === 'chunk') {
    if (TERMINAL.has(step.status)) return false;
    step.chunks ||= []; const index = event.chunkIndex;
    if (!Number.isInteger(index) || index < 0) throw new Error('SYNC_CHUNK_INDEX');
    step.chunks[index] ||= { index, status: 'pending' };
    const changed = setUnit(step.chunks[index], event.updates, now);
    if (event.updates.sessionId) task.currentSubagentSessionId = event.updates.sessionId;
    return changed;
  }
  throw new Error('SYNC_TASK_EVENT');
}

// Only this function chooses a terminal task outcome and closes unfinished units.
function finishSyncTask(task, { status, error, phase, now = Date.now() } = {}) {
  if (TERMINAL.has(task.status) && task.completedAt) return task;
  const steps = task.steps || [];
  const aborted = status === 'aborted' || task.status === 'cancelling' || task.status === 'aborted';
  const failed = status === 'failed' || !!error || task.status === 'failed' || steps.some(s => s.status === 'failed' || s.chunks?.some(c => c?.status === 'failed'));
  const unfinished = steps.some(s => !TERMINAL.has(s.status) || s.chunks?.some(c => c && !TERMINAL.has(c.status)));
  const outcome = aborted ? 'aborted' : failed || unfinished ? 'failed' : status || (TERMINAL.has(task.status) ? task.status : 'completed');
  task.status = outcome;
  task.completedAt = now;
  if (outcome === 'aborted') task.abortedAt ??= now;
  if (error) task.error = error;
  if (outcome === 'failed' && !task.error) task.error = steps.find(s => s.status === 'failed')?.error || steps.find(s => s.status === 'failed')?.text || '同步未完成';
  const target = steps.find(s => s.phase === phase && OPEN.has(s.status)) || steps.find(s => s.status === 'running') || steps.find(s => s.status === 'queued') || (!steps.some(s => s.status === 'failed') && steps.find(s => s.status === 'pending'));
  for (const step of steps) {
    if (!TERMINAL.has(step.status)) {
      const status = outcome === 'aborted' ? 'aborted' : step === target ? 'failed' : 'skipped';
      setUnit(step, { status, text: status === 'failed' ? task.error : status === 'aborted' ? '任务已取消' : '前序步骤失败，未执行' }, now);
    }
    for (const chunk of step.chunks || []) if (chunk && !TERMINAL.has(chunk.status)) setUnit(chunk, { status: outcome === 'aborted' ? 'aborted' : 'failed', error: task.error || '所属步骤已结束' }, now);
  }
  delete task.currentSubagentSessionId;
  return task;
}

function isSyncActive(task) { return TASK_ACTIVE.has(task?.status); }
function hasPublishedDocument(task) { return task?.status === 'completed' || task?.publishState === 'state_committed'; }
function needsSyncRepair(task) {
  return !TERMINAL.has(task.status) || !task.completedAt || (task.steps || []).some(s => !TERMINAL.has(s.status) || s.chunks?.some(c => c && !TERMINAL.has(c.status)));
}
function repairSyncTask(task) {
  if (!needsSyncRepair(task)) return task;
  const now = task.completedAt || Date.now();
  delete task.completedAt;
  const interrupted = !TERMINAL.has(task.status);
  return finishSyncTask(task, { status: interrupted ? 'failed' : task.status, error: interrupted ? task.error || '任务已中断，历史记录缺少结束状态' : task.error, now });
}
module.exports = { createSyncSteps, updateSyncTask, finishSyncTask, isSyncActive, hasPublishedDocument, needsSyncRepair, repairSyncTask };
