'use strict';
const { t } = require('../../locale.js');
const css = require('./SyncVersionCompare.module.css').default;
const { Button } = require('./Button.js');
const React = require('react');
const h = React.createElement;
const { ROUTE } = require('../../constants.js');
const { DiffViewer } = require('./DiffViewer.js');
const { VersionSelect } = require('./VersionSelect.js');
const { hasPublishedDocument } = require('../../../shared/sync-task.cjs');
const DOC_TYPES = [['requirement', t("DocsViewerBody.message073")], ['design', t("documents.design")]];

function SyncVersionCompare({ history, workspaceId, requirementId, docType: selectedDocType, onDocTypeChange }) {
  const id = React.useId();
  const [localDocType, setLocalDocType] = React.useState('requirement');
  const docType = selectedDocType || localDocType;
  const setDocType = type => { setLocalDocType(type); onDocTypeChange?.(type); };
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
      if (!response.ok) throw new Error(data.error || t("SyncVersionCompare.message001"));
      if (token === request.current) setResult(data);
    } catch (error) {
      if (token === request.current) setError(error.message);
    } finally {
      if (token === request.current) setLoading(false);
    }
  };
  return h('section', { className: css.spacing, 'aria-label': t("SyncVersionCompare.message002") },
    h('h3', null, t("SyncVersionCompare.message002")),
    h('div', { className: 'rh-workbench-tabs rh-prompt-tabs', role: 'tablist', 'aria-label': t("FileTreeSidebar.message020") },
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
    h('p', { className: css.mutedText }, t("SyncVersionCompare.message003")),
    versions.length < 2 ? h('p', { role: 'status' }, t("SyncVersionCompare.message004", { value0: versions.length })) : h('div', null,
      h('div', { className: css.row },
        h(VersionSelect, { key: `${docType}-base`, label: t("SyncVersionCompare.message005"), versions, value: oldId, onChange: id => change('oldId', id) }),
        h(VersionSelect, { key: `${docType}-target`, label: t("SyncVersionCompare.message006"), versions, value: newId, onChange: id => change('newId', id) }),
        h(Button, { className: 'rh-btn', disabled: loading, onClick: () => { setSelection({ oldId: newId, newId: oldId }); setResult(null); } }, t("SyncVersionCompare.message007")),
        h(Button, { className: 'rh-btn rh-btn-primary', disabled: loading || !oldId || !newId || oldId === newId, onClick: compare }, loading ? t("SyncVersionCompare.message008") : t("SyncVersionCompare.message009"))),
      oldId === newId && h('p', { role: 'status' }, t("SyncVersionCompare.message010"))),
    error && h('p', { role: 'alert' }, error),
    result && h(DiffViewer, { ...result, fileName: docType === 'requirement' ? 'requirement.md' : 'design.md' })));
}
module.exports = { SyncVersionCompare };
