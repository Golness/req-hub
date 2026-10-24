'use strict';
const React = require('react');
const { ROUTE } = require('../constants.js');

/** Shell-owned observation; leaving an operation page never cancels server execution. */
function useSyncMonitor() {
  const [state, setState] = React.useState({ active: null, latest: null, error: '' });
  const [dismissed, setDismissed] = React.useState(null);
  const refreshRef = React.useRef(() => {});
  const removedTasks = React.useRef(new Set());
  const taskKey = task => task && JSON.stringify([task.workspaceId, task.requirementId, task.snapshotDir || task.notificationId || task.id]);
  React.useEffect(() => {
    let disposed = false, fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const response = await fetch(`${ROUTE}/sync-overview`), data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || '读取同步任务失败');
        if (!disposed) setState({ ...data, active: removedTasks.current.has(taskKey(data.active)) ? null : data.active,
          latest: removedTasks.current.has(taskKey(data.latest)) ? null : data.latest, error: '' });
      } catch (error) {
        if (!disposed) setState(previous => ({ ...previous, error: '同步状态连接中断，后台状态待确认' }));
      } finally { fetching = false; }
    };
    refreshRef.current = refresh;
    const timer = setInterval(refresh, 1500);
    const removed = event => {
      const task = event.detail;
      removedTasks.current.add(taskKey(task));
      const matches = item => item && item.workspaceId === task.workspaceId && item.requirementId === task.requirementId
        && (task.snapshotDir ? item.snapshotDir === task.snapshotDir : item.notificationId === task.notificationId);
      setState(previous => ({ ...previous, active: matches(previous.active) ? null : previous.active, latest: matches(previous.latest) ? null : previous.latest }));
    };
    window.addEventListener('req-hub-sync-deleted', removed);
    window.addEventListener('req-hub-sync-change', refresh);
    window.addEventListener('focus', refresh);
    refresh();
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('req-hub-sync-deleted', removed); window.removeEventListener('req-hub-sync-change', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  const latestKey = state.latest?.snapshotDir || state.latest?.notificationId || state.latest?.id;
  return { ...state, notification: state.active || (latestKey !== dismissed ? state.latest : null),
    dismiss: () => setDismissed(latestKey), refresh: () => refreshRef.current() };
}
module.exports = { useSyncMonitor };
