'use strict';
const React = require('react');
const h = React.createElement;
const { ROUTE } = require('../constants.js');
const { SessionList } = require('./shared/SessionList.js');

const EMPTY = { ids: [], versions: {} };
function ImportWarnings({ warnings = [] }) {
  return warnings.length ? h('details', { className: 'rh-codex-warnings' },
    h('summary', null, `查看 ${warnings.length} 项拉取问题`),
    h('ul', null, warnings.map((warning, index) => h('li', { key: index }, warning)))
  ) : null;
}
function WorkspacePicker({ workspaces, loading, error, warnings, onSelect, onClose }) {
  const [search, setSearch] = React.useState('');
  const ref = React.useRef(null);
  React.useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector('input')?.focus();
    return () => previous?.focus?.();
  }, []);
  const keydown = event => {
    if (event.key === 'Escape' && !event.nativeEvent?.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const controls = [...ref.current.querySelectorAll('input,button:not(:disabled)')];
      const target = event.shiftKey ? controls.at(-1) : controls[0];
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); target?.focus(); }
    }
  };
  const needle = search.trim().toLowerCase();
  const visible = workspaces.filter(workspace => `${workspace.title} ${workspace.path}`.toLowerCase().includes(needle));
  return h('div', { className: 'rh-modal-overlay', role: 'dialog', 'aria-modal': true, 'aria-label': '选择 Codex 工作区', onClick: onClose, onKeyDown: keydown },
    h('div', { className: 'rh-modal', ref, onClick: event => event.stopPropagation() },
      h('div', { className: 'rh-modal-title' }, '选择 Codex 工作区'),
      h('input', { className: 'rh-form-input', type: 'search', 'aria-label': '搜索 Codex 工作区', placeholder: '搜索工作区名称或路径', value: search, onChange: event => setSearch(event.target.value) }),
      error && h('p', { role: 'alert', className: 'rh-error' }, error),
      h(ImportWarnings, { warnings }),
      loading ? h('p', { role: 'status' }, '正在读取 Codex 工作区…')
        : !visible.length ? h('p', { className: 'rh-sync-hint' }, '未找到 Codex 工作区')
          : h('div', { className: 'rh-modal-list rh-codex-workspaces' }, visible.map(workspace => h('button', {
            type: 'button', key: workspace.id, className: 'rh-btn rh-btn-ghost rh-codex-workspace', onClick: () => onSelect(workspace),
          }, h('strong', null, workspace.title), h('span', null, workspace.path || '无目录信息'), h('small', null, `${workspace.sessionCount} 个未归档会话`)))),
      h('div', { className: 'rh-modal-actions' }, h('button', { type: 'button', className: 'rh-btn', onClick: onClose }, '关闭'))
    )
  );
}

function CodexSessionsSection({ workspaceId, selection, onSelectionChange, onView, disabled }) {
  const [data, setData] = React.useState({ workspace: null, sessions: [] });
  const [loading, setLoading] = React.useState(true);
  const [progress, setProgress] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [warnings, setWarnings] = React.useState([]);
  const [search, setSearch] = React.useState('');
  const [picker, setPicker] = React.useState(null);
  const requestId = React.useRef(0), mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);
  const request = async (action, body, onProgress) => {
    const response = await fetch(`${ROUTE}/codex/${action}${body ? '' : '?' + new URLSearchParams({ workspaceId })}`, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, ...body }),
    } : undefined);
    if (response.ok && response.headers?.get('content-type')?.includes('application/x-ndjson')) {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '', result;
      const consume = line => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === 'error') throw Error(event.error);
        if (event.type === 'progress') onProgress?.(event);
        if (event.type === 'result') result = event.result;
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          const lines = pending.split('\n'); pending = lines.pop();
          lines.forEach(consume);
          if (done) { consume(pending); break; }
        }
      } finally { reader.releaseLock(); }
      if (!result) throw Error('刷新连接中断，请重新刷新 Codex 会话');
      return result;
    }
    const result = await response.json();
    if (!response.ok || result.error) throw Error(result.error || '读取 Codex 会话失败');
    return result;
  };
  const load = async (action, body) => {
    const id = ++requestId.current;
    setLoading(true); setError(null);
    setProgress(action === 'refresh' ? { phase: 'queued', completed: 0, total: null } : null);
    try {
      const result = await request(action, body, value => {
        if (mounted.current && id === requestId.current) setProgress(value);
      });
      if (!mounted.current || id !== requestId.current) return;
      const sessions = result.workspace ? result.sessions || [] : [];
      setData({ ...result, sessions }); setWarnings(result.warnings || []);
      const ids = action === 'refresh' ? [] : selection.ids.filter(selected => sessions.some(session => session.id === selected && session.snapshotVersion === selection.versions[selected] && session.syncTurnCount));
      if (ids.length !== selection.ids.length) onSelectionChange({ ids, versions: Object.fromEntries(ids.map(selected => [selected, selection.versions[selected]])) });
    } catch (error) { if (mounted.current && id === requestId.current) { setError(error.message); setData(previous => action === 'refresh' ? { ...previous, sessions: [] } : { workspace: null, sessions: [] }); onSelectionChange(EMPTY); } }
    finally { if (mounted.current && id === requestId.current) { setLoading(false); setProgress(null); } }
  };
  React.useEffect(() => { setData({ workspace: null, sessions: [] }); setSearch(''); load('sessions'); return () => { requestId.current++; }; }, [workspaceId]);
  const openPicker = async () => {
    setPicker({ loading: true, workspaces: [] });
    try {
      const result = await request('workspaces');
      if (mounted.current) setPicker(previous => previous && ({ loading: false, workspaces: result.workspaces || [], warnings: result.warnings || [] }));
    } catch (error) { if (mounted.current) setPicker(previous => previous && ({ loading: false, workspaces: [], error: error.message })); }
  };
  const refresh = projectId => {
    onSelectionChange(EMPTY); setSearch(''); setPicker(null);
    load('refresh', { codexWorkspaceId: projectId || data.workspace?.id, stream: true });
  };
  const toggle = id => {
    const session = data.sessions.find(item => item.id === id);
    if (disabled || !session?.snapshotVersion || !session.syncTurnCount) return;
    const ids = selection.ids.includes(id) ? selection.ids.filter(selected => selected !== id) : [...selection.ids, id];
    onSelectionChange({ ids, versions: Object.fromEntries(ids.map(selected => [selected, selected === id ? session.snapshotVersion : selection.versions[selected]])) });
  };
  const visible = data.sessions.filter(session => `${session.title} ${session.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  return h('section', { className: 'rh-sync-source-section rh-sync-sessions', 'aria-label': '选择 Codex 会话' },
    h('div', { className: 'rh-sync-section-heading' },
      h('h3', { className: 'rh-sync-section-title' }, '选择 Codex 会话（可选）'),
      h('button', { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: loading || disabled, onClick: openPicker }, '选择 Codex 工作区'),
      h('button', { type: 'button', className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: loading || disabled || !data.workspace, onClick: () => refresh() }, '刷新 Codex 会话')),
    h('p', { className: 'rh-sync-hint' }, '拉取未归档主会话并保存为 Markdown；同步用户输入、助手中间回复及最终回复，分析时仅使用完整轮次。'),
    data.workspace && h('p', { className: 'rh-sync-hint', title: data.workspace.path }, `Codex 工作区：${data.workspace.title} · ${data.workspace.path}`),
    error && h('p', { role: 'alert', className: 'rh-error' }, error),
    loading && progress && h('div', { className: 'rh-codex-progress', role: 'status', 'aria-live': 'polite' },
      h('span', null, progress.phase === 'queued' ? '等待刷新…' : progress.phase === 'inventory' ? '正在读取 Codex 会话列表…' : progress.phase === 'saving' ? `正在保存会话列表（${progress.completed}/${progress.total}）…` : `正在拉取 Codex 会话（${progress.completed}/${progress.total}）…`),
      h('progress', { 'aria-label': 'Codex 会话刷新进度', max: progress.total || 1, value: progress.total === null ? undefined : progress.completed })),
    h(ImportWarnings, { warnings }),
    data.workspace && h('input', { className: 'rh-search-input', type: 'search', value: search, 'aria-label': '筛选 Codex 会话', placeholder: '搜索 Codex 会话…', onChange: event => setSearch(event.target.value) }),
    h(SessionList, { sessions: visible, selectedIds: selection.ids, onToggle: toggle, onView, loading, disabled, source: ' Codex ',
      emptyText: data.workspace ? (search.trim() ? '未找到匹配的 Codex 会话' : '该工作区暂无未归档会话') : '请选择 Codex 工作区以拉取会话。' }),
    data.workspace && !loading && !error && h('p', { className: 'rh-sync-hint', role: 'status' }, `已拉取 ${data.sessions.filter(session => session.snapshotVersion).length} 个会话，Markdown 已入库${data.refreshedAt ? ' · ' + new Date(data.refreshedAt).toLocaleString() : ''}`),
    selection.ids.length > 0 && h('p', { className: 'rh-sync-hint' }, `已选择 ${selection.ids.length} 个 Codex 会话`),
    picker && h(WorkspacePicker, { ...picker, onSelect: project => refresh(project.id), onClose: () => setPicker(null) })
  );
}
module.exports = { CodexSessionsSection };
