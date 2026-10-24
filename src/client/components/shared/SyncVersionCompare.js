'use strict';
const React = require('react');
const h = React.createElement;
const { ROUTE } = require('../../constants.js');
const { DiffViewer } = require('./DiffViewer.js');
const { VersionSelect } = require('./VersionSelect.js');
const { hasPublishedDocument } = require('../../../shared/sync-task.cjs');
const DOC_TYPES = [['requirement', '需求文档'], ['design', '技术方案']];

function SyncVersionCompare({ history, workspaceId, requirementId }) {
  const id = React.useId();
  const [docType, setDocType] = React.useState('requirement');
  const versions = history.filter(sync => hasPublishedDocument(sync) && sync.docType === docType);
  const [selection, setSelection] = React.useState(null);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const request = React.useRef(0);
  const oldId = selection?.oldId ?? versions[1]?.id ?? '';
  const newId = selection?.newId ?? versions[0]?.id ?? '';
  React.useEffect(() => {
    request.current++;
    setSelection(null); setResult(null); setError(''); setLoading(false);
    return () => { request.current++; };
  }, [docType, workspaceId, requirementId, history]);
  const change = (side, id) => {
    request.current++;
    setSelection({ oldId, newId, [side]: id });
    setResult(null); setError(''); setLoading(false);
  };
  const compare = async () => {
    const token = ++request.current;
    setLoading(true); setError(''); setResult(null);
    try {
      const params = new URLSearchParams({ workspaceId, requirementId, syncId1: oldId, syncId2: newId });
      const response = await fetch(`${ROUTE}/sync-version-diff?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '版本对比失败');
      if (token === request.current) setResult(data);
    } catch (error) {
      if (token === request.current) setError(error.message);
    } finally {
      if (token === request.current) setLoading(false);
    }
  };
  return h('section', { style: { marginTop: 20 }, 'aria-label': '文档版本对比' },
    h('h3', null, '文档版本对比'),
    h('div', { className: 'rh-workbench-tabs rh-prompt-tabs', role: 'tablist', 'aria-label': '文档类型' },
      DOC_TYPES.map(([type, text], index) => h('button', {
        key: type, id: `${id}-tab-${type}`, type: 'button', role: 'tab',
        className: 'rh-workbench-tab',
        'aria-selected': docType === type, 'aria-controls': `${id}-panel`,
        tabIndex: docType === type ? 0 : -1,
        onClick: () => setDocType(type),
        onKeyDown: event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % DOC_TYPES.length
            : event.key === 'ArrowLeft' ? (index + DOC_TYPES.length - 1) % DOC_TYPES.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? DOC_TYPES.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          setDocType(DOC_TYPES[next][0]);
          event.currentTarget.parentElement.children[next].focus();
        },
      }, text))),
    h('div', { role: 'tabpanel', id: `${id}-panel`, 'aria-labelledby': `${id}-tab-${docType}` },
    h('p', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 'var(--rh-font-size)' } }, '仅显示成功版本，默认对比最近两版。'),
    versions.length < 2 ? h('p', { role: 'status' }, `已有 ${versions.length} 个成功版本，至少需要两个版本才能对比。`) : h('div', null,
      h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' } },
        h(VersionSelect, { key: `${docType}-base`, label: '基准版本', versions, value: oldId, onChange: id => change('oldId', id) }),
        h(VersionSelect, { key: `${docType}-target`, label: '目标版本', versions, value: newId, onChange: id => change('newId', id) }),
        h('button', { className: 'rh-btn', disabled: loading, onClick: () => { setSelection({ oldId: newId, newId: oldId }); setResult(null); } }, '交换'),
        h('button', { className: 'rh-btn rh-btn-primary', disabled: loading || !oldId || !newId || oldId === newId, onClick: compare }, loading ? '对比中…' : '查看差异')),
      oldId === newId && h('p', { role: 'status' }, '请选择两个不同版本。')),
    error && h('p', { role: 'alert' }, error),
    result && h(DiffViewer, { ...result, fileName: docType === 'requirement' ? 'requirement.md' : 'design.md' })));
}
module.exports = { SyncVersionCompare };
