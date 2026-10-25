'use strict';
const { t } = require('../locale.js');
const React = require('react');
const { ROUTE } = require('../constants.js');
const { isSyncActive } = require('../../shared/sync-task.cjs');
const isActive = task => task && (isSyncActive(task) || task.status === 'preparing');

/** Shell-owned observation; leaving an operation page never cancels server execution. */
function useSyncMonitor() {
  const [state, setState] = React.useState({ active: null, latest: null, error: '' });
  const [dismissed, setDismissed] = React.useState(() => new Set());
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
        if (!response.ok || data.error) throw new Error(data.error || t("useSyncMonitor.message001"));
        if (!disposed) setState({ ...data, active: removedTasks.current.has(taskKey(data.active)) ? null : data.active,
          latest: removedTasks.current.has(taskKey(data.latest)) ? null : data.latest, error: '' });
      } catch (error) {
        if (!disposed) setState(previous => ({ ...previous, error: t("useSyncMonitor.message002") }));
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
  const task = state.active || state.latest;
  const notificationKey = task && taskKey(task) + ':' + (isActive(task) ? 'active' : task.status);
  const notification = dismissed.has(notificationKey) ? null : task;
  const terminalKey = notification && !isActive(notification) ? notificationKey : null;
  React.useEffect(() => {
    if (!terminalKey) return;
    const timer = setTimeout(() => setDismissed(previous => new Set([...previous, terminalKey])), 8000);
    return () => clearTimeout(timer);
  }, [terminalKey]);
  return { ...state, notification,
    dismiss: () => setDismissed(previous => new Set([...previous, notificationKey])), refresh: () => refreshRef.current() };
}
module.exports = { useSyncMonitor };
