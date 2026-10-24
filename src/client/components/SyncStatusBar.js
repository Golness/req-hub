'use strict';
const React = require('react'), h = React.createElement;
const model = require('../../shared/sync-task.cjs');
const { DeleteSyncTaskButton } = require('./shared/DeleteSyncTaskButton.js');

function SyncStatusBar({ monitor, onOpen }) {
  const task = monitor.notification;
  if (!task) return null;
  const active = model.isSyncActive(task) || task.status === 'preparing';
  const steps = task.steps || [], step = steps.find(item => ['running','queued'].includes(item.status));
  const done = steps.filter(item => ['completed','skipped'].includes(item.status)).length;
  const chunks = step?.chunks || [], chunkDone = chunks.filter(item => ['completed','skipped'].includes(item.status)).length;
  const text = task.status === 'cancelling' ? '正在终止' : active ? '后台同步中' : ({completed:'同步完成',failed:'同步失败',aborted:'同步已终止'}[task.status] || '同步结束');
  const detail = active ? ` · ${step?.label || '同步检查'} · ${done}/${steps.length} 步${chunks.length ? ` · 分块 ${chunkDone}/${chunks.length}` : ''}` : task.error ? ` · ${task.error}` : '';
  return h('div', { className: 'rh-sync-status', role: 'status', 'aria-live': 'polite', 'data-status': task.status },
    h('button', { type:'button',className:'rh-btn rh-btn-ghost rh-btn-sm rh-sync-status-link',disabled:!task.id,
      onClick:()=>{ onOpen(task); monitor.dismiss(); },title:`${task.requirementId} · ${text}${detail}` },
      `${task.docTypeName || (task.docType === 'design' ? '技术方案' : '需求文档')} · ${task.requirementId} · ${text}${detail}`),
    monitor.error && h('button', {type:'button',className:'rh-btn rh-btn-ghost rh-btn-sm',onClick:monitor.refresh}, monitor.error + '，重试'),
    h(DeleteSyncTaskButton, { task }),
    !active && h('button', {type:'button',className:'rh-btn rh-btn-ghost rh-btn-sm','aria-label':'关闭同步通知',onClick:monitor.dismiss}, '关闭')
  );
}
module.exports = { SyncStatusBar };
