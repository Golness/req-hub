'use strict';
const { Disclosure } = require('./shared/Disclosure.js');
const React = require('react');
const { t } = require('../locale.js');
const { ROUTE } = require('../constants.js');
const { Checkbox } = require('./shared/controls.js');
const { Button } = require('./shared/Button.js');
const { Input } = require('./shared/Input.js');
const css = require('./KnowledgeContextPicker.module.css').default;
const h = React.createElement;
/**
 * Select knowledge scopes for automatic retrieval by the existing Host sync pipeline.
 * @param props - Workspace, selected scope IDs, selection callback and disabled state.
 * @returns A searchable optional scope selector; search never changes the selection.
 */
function KnowledgeContextPicker({ workspaceId, scopeIds, onChange, disabled, embedded = false }) {
  const [scopes, setScopes] = React.useState([]);
  const [error, setError] = React.useState('');
  const [revision, setRevision] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    const abort = new AbortController();
    setError('');
    setLoading(true);
    fetch(`${ROUTE}/writing/options`, { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error();
        }
        return res.json();
      })
      .then((value) => {
        if (!Array.isArray(value.scopes)) {
          throw new Error();
        }
        if (!abort.signal.aborted) {
          setScopes(value.scopes);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError(t('enhancement.contextError'));
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [workspaceId, revision]);
  const visibleScopes = scopes.filter((scope) =>
    scope.title.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return h(
    'section',
    { className: embedded ? css.embedded : css.notice },
    h(
      Disclosure,
      { title: t('enhancement.contextTitle', { count: scopeIds.length }) },
      h(
        'div',
        { className: `${css.formStack} ${css.contextBody}` },
        h(Input, {
          className: css.search,
          value: search,
          disabled,
          'aria-label': t('sync.knowledge.search'),
          placeholder: t('sync.knowledge.search'),
          onChange: (event) => setSearch(event.target.value),
        }),
        h(
          'div',
          { className: css.toolbar },
          h(
            Button,
            { size: 'sm', disabled: disabled || !scopeIds.length, onClick: () => onChange([]) },
            t('sync.knowledge.clear'),
          ),
          h(
            Button,
            {
              size: 'sm',
              disabled: disabled || loading,
              onClick: () => setRevision((value) => value + 1),
            },
            t('enhancement.refresh'),
          ),
        ),
        loading && h('p', { role: 'status', className: css.muted }, t('common.loading')),
        error && h('p', { role: 'alert', className: css.error }, error),
        h(
          'div',
          { className: css.list },
          visibleScopes.map((scope) =>
            h(Checkbox, {
              key: scope.id,
              className: css.row,
              disabled: disabled || loading,
              checked: scopeIds.includes(scope.id),
              label: scope.title,
              onChange: (checked) =>
                onChange(
                  checked ? [...scopeIds, scope.id] : scopeIds.filter((id) => id !== scope.id),
                ),
            }),
          ),
        ),
        !loading &&
          !error &&
          !visibleScopes.length &&
          h(
            'p',
            { className: css.muted },
            t(scopes.length ? 'sync.knowledge.noMatch' : 'sync.knowledge.empty'),
          ),
      ),
    ),
    h('p', { className: `${css.muted} ${css.description}` }, t('sync.knowledge.help')),
  );
}
module.exports = { KnowledgeContextPicker };
