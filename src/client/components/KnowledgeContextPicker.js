'use strict';
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { Checkbox } = require('./shared/controls.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const css = require('./KnowledgeContextPicker.module.css').default;
const h = React.createElement;
function KnowledgeContextPicker({ workspaceId, scopeIds, onChange, query, onQueryChange, disabled }) {
  const [scopes, setScopes] = React.useState([]), [error, setError] = React.useState(''), [revision, setRevision] = React.useState(0);
  const [hits, setHits] = React.useState(null), [busy, setBusy] = React.useState(false);
  const controller = React.useRef(null);
  React.useEffect(() => {
    const abort = new AbortController(); controller.current = abort; setError('');
    fetch(`${ROUTE}/writing/options`, { signal: abort.signal }).then(async res => { if (!res.ok) throw new Error(); return res.json(); })
      .then(value => { if (!Array.isArray(value.scopes)) throw new Error(); if (!abort.signal.aborted) setScopes(value.scopes); }).catch(() => { if (!abort.signal.aborted) setError(t('enhancement.contextError')); });
    return () => abort.abort();
  }, [workspaceId, revision]);
  const recommend = async () => {
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ workspaceId, recommendQuery: query, scopeIds: JSON.stringify(scopeIds) });
      const response = await fetch(`${ROUTE}/knowledge/enhancements/jobs?${params}`, { signal: controller.current.signal });
      const value = await response.json(); if (!response.ok) throw new Error(); if (!controller.current.signal.aborted) setHits(value.hits);
    } catch { if (!controller.current.signal.aborted) setError(t('enhancement.contextError')); }
    finally { setBusy(false); }
  };
  return h('details', { className: css.notice }, h('summary', null, t('enhancement.contextTitle', { count: scopeIds.length })),
    h('div', { className: `${css.formStack} ${css.contextBody}` },
    h('p', { className: css.muted }, t('enhancement.contextHelp')),
    h('div', { className: css.toolbar }, scopes.map(scope => h(Checkbox, { key: scope.id, disabled, checked: scopeIds.includes(scope.id), label: scope.title,
      onChange: checked => onChange(checked ? [...scopeIds, scope.id] : scopeIds.filter(id => id !== scope.id)) })),
      h(Button, { size: 'sm', disabled: disabled || busy, onClick: () => setRevision(value => value + 1) }, t('enhancement.refresh'))),
    h(Input, { value: query, disabled, maxLength: 500, 'aria-label': t('enhancement.contextQuery'), placeholder: t('enhancement.contextQuery'), onChange: event => onQueryChange(event.target.value) }),
    h('div', { className: css.toolbar }, h(Button, { size: 'sm', disabled: disabled || busy || !scopeIds.length || !query.trim(), onClick: recommend }, t('enhancement.recommend'))),
    error && h('p', { role: 'alert', className: css.error }, error),
    hits && h('div', { className: css.list }, hits.length ? hits.map(hit => h('div', { key: hit.id, className: css.row }, h('p', null, hit.title), h('p', { className: css.muted }, `${hit.path} · v${hit.version}`), h('p', null, hit.snippet))) : h('p', null, t('enhancement.noHits')))));
}
module.exports = { KnowledgeContextPicker };
