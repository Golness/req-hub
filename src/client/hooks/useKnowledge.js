'use strict';
const { useState, useEffect, useRef } = require('react');
const { ROUTE } = require('../constants.js');

async function knowledgeRequest(path, workspaceId, body, signal) {
  const res = await fetch(`${ROUTE}/knowledge${path}${body || workspaceId == null ? '' : `${path.includes('?') ? '&' : '?'}workspaceId=${encodeURIComponent(workspaceId)}`}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, workspaceId }), signal }
    : { signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function useKnowledge(workspaceId) {
  const [state, setState] = useState({ workspaceId, selected: [], status: null, job: null, error: null, busy: false });
  const [revision, setRevision] = useState(0);
  const scope = useRef(workspaceId); scope.current = workspaceId;
  const generation = useRef(0);
  const current = state.workspaceId === workspaceId ? state : { workspaceId, selected: [], status: null, job: null, error: null, busy: false };
  const patch = changes => setState(old => ({ ...(old.workspaceId === workspaceId ? old : current), ...changes }));

  useEffect(() => {
    const token = ++generation.current;
    const controller = new AbortController();
    setState(old => old.workspaceId === workspaceId ? { ...old, error: null } : { workspaceId, selected: [], status: null, job: null, error: null, busy: false });
    let timer;
    const refresh = async () => {
      try {
        const status = await knowledgeRequest('/status', workspaceId, null, controller.signal);
        const id = status.activeJobId || status.latestJobId;
        const job = id ? await knowledgeRequest(`/builds/${encodeURIComponent(id)}`, workspaceId, null, controller.signal) : null;
        if (generation.current !== token) return;
        setState(old => ({ ...old, status, job, error: null }));
        if (status.activeJobId) timer = setTimeout(refresh, 1000);
      } catch (error) { if (!controller.signal.aborted && generation.current === token) setState(old => ({ ...old, error: error.message })); }
    };
    refresh();
    return () => { generation.current++; controller.abort(); clearTimeout(timer); };
  }, [workspaceId, revision]);

  const start = async paths => {
    const id = scope.current;
    const token = generation.current;
    patch({ busy: true, error: null });
    try {
      const job = await knowledgeRequest('/builds', workspaceId, { requestKey: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, files: (paths || current.selected).map(relativePath => ({ relativePath })) });
      if (scope.current === id && generation.current === token) {
        patch({ job });
        setRevision(n => n + 1);
      }
    } catch (error) { if (scope.current === id && generation.current === token) patch({ error: error.message }); }
    finally { if (scope.current === id && generation.current === token) patch({ busy: false }); }
  };
  const cancel = async () => {
    const id = scope.current;
    const token = generation.current;
    try { const job = await knowledgeRequest(`/builds/${current.job.id}/cancel`, id, {}); if (scope.current === id && generation.current === token) patch({ job }); }
    catch (error) { if (scope.current === id && generation.current === token) patch({ error: error.message }); }
  };
  return { ...current, start, cancel, setSelected: selected => patch({ selected }), refresh: () => setRevision(n => n + 1), running: current.busy || ['queued', 'running', 'cancelling'].includes(current.job?.status) };
}
module.exports = { useKnowledge, knowledgeRequest };
