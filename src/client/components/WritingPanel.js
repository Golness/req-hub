'use strict';
const React = require('react');
const { Select } = require('./shared/Select.js');
const h = React.createElement;
const { ROUTE } = require('../constants.js');
const { MilkdownEditor } = require('./MilkdownEditor.js');
const { DiffViewer } = require('./shared/DiffViewer.js');
const { diffLines } = require('diff');

function writingChanges(before, after) {
  const parts = [];
  for (const change of diffLines(before, after)) {
    if (!change.added && !change.removed) { parts.push({ text: change.value }); continue; }
    let part = parts.at(-1);
    if (!part || part.text !== undefined) { part = { before: '', after: '', decision: null }; parts.push(part); }
    part[change.added ? 'after' : 'before'] += change.value;
  }
  return parts;
}
const mergedWriting = parts => parts.map(p => p.text ?? (p.decision === 'accept' ? p.after : p.before)).join('');
async function request(path, body, signal) {
  const response = await fetch(`${ROUTE}/writing${path}`, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || '写作请求失败'), { status: response.status }); return data;
}
function loadDraft(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return Object.fromEntries(['requirement', 'design'].filter(type => typeof saved?.[type] === 'string').map(type => [type, saved[type]]));
  } catch { return {}; }
}

function WritingPanel({ workspaceId }) {
  // Workspace-keyed parent keeps the two document types independent.
  const storageKey = `req-hub:writing:${workspaceId}`;
  const [draft, setDraft] = React.useState(() => loadDraft(storageKey));
  const [docType, setDocType] = React.useState('requirement');
  const [scopeIds, setScopeIds] = React.useState([]);
  const [options, setOptions] = React.useState(null);
  const [instruction, setInstruction] = React.useState('');
  const [error, setError] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [jobId, setJobId] = React.useState(null);
  const [proposal, setProposal] = React.useState(null);
  const [starter, setStarter] = React.useState('');
  const jobRef = React.useRef(null), operationRef = React.useRef(null), pollTimer = React.useRef(null);
  const content = draft[docType] || '';
  const setContent = value => setDraft(previous => ({ ...previous, [docType]: value }));
  React.useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { setError('草稿无法保存到浏览器，请下载备份'); } }, [draft, storageKey]);
  const refresh = React.useCallback(() => {
    const controller = new AbortController();
    request('/options', null, controller.signal).then(data => { setOptions(data); setError(''); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  React.useEffect(refresh, [refresh]);
  React.useEffect(() => () => {
    operationRef.current?.abort(); clearTimeout(pollTimer.current);
    if (jobRef.current) void request(`/jobs/${jobRef.current}/cancel`, {}).catch(() => {});
  }, []);
  const optimize = async () => {
    setError(''); setRunning(true);
    const controller = new AbortController(); operationRef.current = controller;
    try {
      const sessionId = window.__DSH_CTX__?.get?.('uiWorkspace')?.selection?.getSnapshot?.()?.sessionId;
      if (!sessionId) throw new Error('请先选择一个活跃的 DSH 会话');
      const job = await request('/optimize', { workspaceId, docType, content, instruction, scopeIds, sessionId }, controller.signal);
      jobRef.current = job.id; setJobId(job.id);
      const poll = async () => {
        try {
          const state = await request(`/jobs/${job.id}`, null, controller.signal);
          if (controller.signal.aborted) return;
          if (state.status === 'running') { pollTimer.current = setTimeout(poll, 1000); return; }
          setRunning(false); jobRef.current = null; setJobId(null);
          if (state.status === 'completed') setProposal({ ...state.result, parts: writingChanges(state.result.original, state.result.content) });
          else if (state.status === 'failed') setError(state.error || '优化失败');
        } catch (e) {
          if (controller.signal.aborted) return;
          setError(e.message);
          if (e.status === 404) { setRunning(false); jobRef.current = null; setJobId(null); }
          else pollTimer.current = setTimeout(poll, 3000);
        }
      };
      void poll();
    } catch (e) { if (!controller.signal.aborted) { setError(e.message); setRunning(false); } }
  };
  const cancel = async () => {
    try {
      if (jobRef.current) await request(`/jobs/${jobRef.current}/cancel`, {});
      operationRef.current?.abort(); clearTimeout(pollTimer.current); jobRef.current = null; setJobId(null); setRunning(false);
    } catch (e) { setError(e.message); }
  };
  const decide = (index, decision) => {
    const parts = proposal.parts.map((p, i) => i === index ? { ...p, decision } : p);
    setContent(mergedWriting(parts));
    if (parts.every(p => p.text !== undefined || p.decision)) setProposal(null);
    else setProposal({ ...proposal, parts });
  };
  const finish = accept => {
    const parts = proposal.parts.map(p => p.text !== undefined || p.decision ? p : { ...p, decision: accept ? 'accept' : 'reject' });
    setContent(mergedWriting(parts)); setProposal(null);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${docType}.md`; anchor.click(); URL.revokeObjectURL(url);
  };
  const locked = running || !!proposal;
  return h('div', { className: 'rh-writing-panel' },
    h('div', { className: 'rh-knowledge-toolbar' },
      h('label', null, '文档类型 ', h(Select, { value: docType, disabled: locked, onChange: e => { setDocType(e.target.value); setStarter(''); } }, h('option', { value: 'requirement' }, '需求文档'), h('option', { value: 'design' }, '技术方案'))),
      h('label', null, '起稿方式 ', h(Select, { value: starter, disabled: locked, onChange: e => setStarter(e.target.value) }, h('option', { value: '' }, '空白文档'), h('option', { value: docType }, options?.starters?.[docType]?.label || '文档模板'))),
      h('button', { className: 'rh-btn rh-btn-ghost', disabled: locked || !!content.trim() || !options, onClick: () => setContent(starter ? options.starters[starter].content : '') }, '开始起稿'),
      h('button', { className: 'rh-btn rh-btn-ghost', disabled: !content, onClick: download }, '下载 Markdown')),
    h('details', { className: 'rh-writing-sources', open: true }, h('summary', null, `使用知识库（已选 ${scopeIds.length}）`),
      h('button', { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: refresh, disabled: running }, '刷新知识库'),
      options?.scopes.map(scope => h('label', { key: scope.id, className: 'rh-writing-scope', title: scope.docsRoot },
        h('input', { type: 'checkbox', disabled: locked, checked: scopeIds.includes(scope.id), onChange: e => setScopeIds(ids => e.target.checked ? [...ids, scope.id] : ids.filter(id => id !== scope.id)) }), `${scope.title} · ${scope.entryCount} 篇`)),
      options?.scopes.length === 0 && h('p', null, '尚无已构建知识库，可先进入知识库分析文件。'),
      h('small', null, scopeIds.length ? '优化时将检索并读取所选知识库，返回来源与版本。' : '未选择知识库，仅依据当前正文优化。')),
    error && h('div', { className: 'rh-knowledge-error', role: 'alert' }, error),
    h('div', { className: 'rh-writing-editor' }, h(MilkdownEditor, { content, onChange: setContent, readOnly: locked })),
    h('div', { className: 'rh-knowledge-toolbar' },
      h('input', { className: 'rh-search-input', 'aria-label': '优化要求', placeholder: '优化要求，例如：结合知识库补充审批边界与验收标准', value: instruction, disabled: locked, maxLength: 4000, onChange: e => setInstruction(e.target.value) }),
      h('button', { className: 'rh-btn rh-btn-primary', disabled: locked || !content.trim() || !options, onClick: optimize }, running ? '优化中…' : '优化'),
      running && h('button', { className: 'rh-btn rh-btn-ghost', onClick: cancel, disabled: !jobId }, '取消')),
    proposal && h('section', { className: 'rh-writing-proposal', 'aria-label': '优化差异' },
      h('div', { className: 'rh-knowledge-toolbar' }, h('strong', null, '审阅优化建议'),
        h('button', { className: 'rh-btn rh-btn-primary', onClick: () => finish(true) }, '合并全部剩余建议'),
        h('button', { className: 'rh-btn rh-btn-ghost', onClick: () => finish(false) }, '保留正文并结束审阅')),
      h(DiffViewer, { oldContent: proposal.original, newContent: proposal.content, fileName: `${docType}.md`, oldLabel: '优化前', newLabel: '优化建议' }),
      proposal.parts.map((part, index) => part.text !== undefined || part.decision ? null : h('div', { key: index, className: 'rh-writing-change' },
        h(DiffViewer, { oldContent: part.before, newContent: part.after, fileName: `修改 ${index + 1}` }),
        h('button', { className: 'rh-btn rh-btn-primary', onClick: () => decide(index, 'accept') }, '合并此处'),
        h('button', { className: 'rh-btn rh-btn-ghost', onClick: () => decide(index, 'reject') }, '保留原文'))),
      h('details', null, h('summary', null, `已读取的知识依据（${proposal.evidence.length}）`), proposal.evidence.map(item => h('p', { key: item.id }, `${item.workspaceTitle} · ${item.sources.map(s => s.relativePath).join('、')} · v${item.version}`))),
      h('small', null, '完成审阅后可继续编辑，再次优化。')));
}
module.exports = { WritingPanel, writingChanges, mergedWriting };
