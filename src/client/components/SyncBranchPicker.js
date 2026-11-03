'use strict';
const React = require('react');
const { Input } = require('./shared/Input.js');
const { Button } = require('./shared/Button.js');
const { Menu } = require('./shared/controls.js');
const { createIconComponents } = require('../icons.js');
const { parseBranchName } = require('./CreateDirForm.js');
const { ROUTE } = require('../constants.js');
const { t } = require('../locale.js');
const css = require('./SyncBranchPicker.module.css').default;
const h = React.createElement;
const { IconSearch } = createIconComponents(h);

/**
 * Search scoped branches or requirement files; only explicit selection commits a value.
 * @param props - Search scope, kind, committed value, visibility and selection callbacks.
 * @returns A searchable combobox with input-owned keyboard focus.
 */
function SyncBranchPicker({
  workspaceId,
  requirementId,
  kind = 'branch',
  value,
  onChange,
  onPendingChange,
  disabled,
  active = true,
}) {
  const reference = kind === 'reference';
  const label = t(reference ? 'sync.reference.label' : 'sync.quick.branch');
  const id = React.useId();
  const input = React.useRef(null);
  const [query, setQuery] = React.useState(value || '');
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState({ branches: [], loading: false, error: false });
  const [highlight, setHighlight] = React.useState(0);
  const [revision, setRevision] = React.useState(0);
  const shown = open && active && !disabled;
  const choices = state.branches.map((name, index) => ({
    id: name,
    label: name,
    title: name,
    domId: `${id}-option-${index}`,
  }));
  const current = choices[highlight];

  React.useEffect(() => {
    if (!shown) {
      return;
    }
    const controller = new AbortController();
    setState({ branches: [], loading: true, error: false });
    setHighlight(0);
    const timer = setTimeout(async () => {
      try {
        const endpoint = reference ? 'sync-design-references' : 'sync-branches';
        const response = await fetch(
          `${ROUTE}/${endpoint}?${new URLSearchParams({
            workspaceId,
            ...(reference ? { requirementId } : {}),
            query,
          })}`,
          { signal: controller.signal },
        );
        const data = await response.json();
        const values = reference ? data.files : data.branches;
        if (!response.ok || !Array.isArray(values)) {
          throw new Error('SYNC_BRANCH_LIST_FAILED');
        }
        if (!controller.signal.aborted) {
          const needle = query.trim().toLowerCase();
          setState({
            branches: values.filter(
              (name) =>
                typeof name === 'string' &&
                (reference || parseBranchName(name)?.developer) &&
                name.toLowerCase().includes(needle),
            ),
            loading: false,
            error: false,
          });
        }
      } catch {
        if (!controller.signal.aborted) {
          setState({ branches: [], loading: false, error: true });
        }
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, requirementId, reference, query, shown, revision]);
  React.useEffect(() => {
    if (!active || disabled) {
      setOpen(false);
    }
  }, [active, disabled]);
  React.useEffect(() => {
    if (shown && current) {
      document.getElementById(current.domId)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [shown, current?.domId]);

  const select = (name) => {
    if (!state.branches.includes(name) || disabled) {
      return;
    }
    setQuery(name);
    onChange(name);
    onPendingChange?.(false);
    input.current?.focus();
    setOpen(false);
  };
  const keyboard = (event) => {
    if (event.nativeEvent?.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (shown && choices.length) {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight((index) => (index + direction + choices.length) % choices.length);
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (shown && current && !state.loading) {
        select(current.id);
      } else {
        setOpen(true);
      }
    }
  };
  let message;
  if (state.loading) {
    message = t('common.loading');
  } else if (state.error) {
    message = t(reference ? 'sync.reference.loadFailed' : 'sync.branch.loadFailed');
  } else if (!choices.length) {
    message = t(reference ? 'sync.reference.empty' : 'sync.branch.empty');
  }
  return h(Menu, {
    id: `${id}-list`,
    role: 'listbox',
    label,
    className: css.root,
    listClassName: css.matches,
    containerTag: 'div',
    open: shown,
    autoFocus: false,
    items: choices,
    activeId: current?.id,
    selectedId: value,
    onSelect: select,
    onClose: () => setOpen(false),
    anchor: h(
      'div',
      { className: reference ? `${css.field} ${css.referenceField}` : css.field },
      h(Input, {
        ref: input,
        icon: h(IconSearch, { size: 16 }),
        className: css.input,
        role: 'combobox',
        'aria-label': label,
        'aria-autocomplete': 'list',
        'aria-haspopup': 'listbox',
        'aria-expanded': shown,
        'aria-controls': shown ? `${id}-list` : undefined,
        'aria-activedescendant': shown && current ? current.domId : undefined,
        autoComplete: 'off',
        placeholder: t(reference ? 'sync.reference.placeholder' : 'sync.branch.placeholder'),
        value: query,
        disabled,
        onFocus: () => setOpen(true),
        onChange: (event) => {
          setQuery(event.target.value);
          onChange('');
          onPendingChange?.(!!event.target.value.trim());
          setState({ branches: [], loading: true, error: false });
          setHighlight(0);
          setOpen(true);
        },
        onKeyDown: keyboard,
      }),
      reference &&
        query &&
        h(
          Button,
          {
            variant: 'ghost',
            disabled,
            'aria-label': t('sync.reference.clear'),
            onClick: () => {
              setQuery('');
              onChange('');
              onPendingChange?.(false);
              input.current?.focus();
              setOpen(false);
            },
          },
          t('LogPanel.message002'),
        ),
    ),
    children:
      message &&
      h(
        'div',
        {
          className: css.message,
          role: state.error ? 'alert' : 'status',
        },
        message,
        state.error &&
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              onClick: () => setRevision((previous) => previous + 1),
            },
            t('common.retry'),
          ),
      ),
  });
}
module.exports = { SyncBranchPicker };
