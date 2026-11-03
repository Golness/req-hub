'use strict';
const React = require('react');
const { Button } = require('./shared/Button.js');
const { t } = require('../locale.js');
const { DshSessionsSection } = require('./DshSessionsSection.js');
const { CodexSessionsSection } = require('./CodexSessionsSection.js');
const css = require('./ConversationSources.module.css').default;
const h = React.createElement;

/**
 * Share acquisition controls and keep both sync sources mounted across tab switches.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function ConversationSources({
  workspaceId,
  acquireOnly = false,
  dshSelection,
  codexSelection,
  onDshSelectionChange,
  onCodexSelectionChange,
  onView,
  onManage,
  onChanged,
  onRefreshStart,
  onBusyChange,
  disabled,
  tabbed = false,
  activeSource,
  onSourceChange,
}) {
  const id = React.useId();
  const [localSource, setLocalSource] = React.useState('dsh');
  const source = activeSource || localSource;
  const [toolbarTarget, setToolbarTarget] = React.useState(null);
  const [dshCount, setDshCount] = React.useState(0);
  const [codexCount, setCodexCount] = React.useState(0);
  const selectSource = (value) => {
    setLocalSource(value);
    onSourceChange?.(value);
  };
  const [activity, setActivity] = React.useState({ dsh: false, codex: false });
  const changeDshBusy = React.useCallback(
    (value) => setActivity((previous) => ({ ...previous, dsh: value })),
    [],
  );
  const changeCodexBusy = React.useCallback(
    (value) => setActivity((previous) => ({ ...previous, codex: value })),
    [],
  );
  const busy = activity.dsh || activity.codex;
  const notifyBusy = React.useRef(onBusyChange);
  notifyBusy.current = onBusyChange;
  React.useEffect(() => {
    notifyBusy.current?.(busy);
  }, [busy]);
  const dsh = h(DshSessionsSection, {
    workspaceId,
    selection: dshSelection,
    onSelectionChange: onDshSelectionChange,
    onView,
    onManage,
    acquireOnly,
    onChanged,
    onRefreshStart,
    onBusyChange: changeDshBusy,
    onCountChange: setDshCount,
    disabled: disabled || busy,
    embedded: tabbed,
    active: source === 'dsh',
    toolbarTarget,
  });
  const codex = h(CodexSessionsSection, {
    workspaceId,
    selection: codexSelection,
    onSelectionChange: onCodexSelectionChange,
    onView,
    acquireOnly,
    onChanged,
    onRefreshStart,
    onBusyChange: changeCodexBusy,
    onCountChange: setCodexCount,
    disabled: disabled || busy,
    embedded: tabbed,
    active: source === 'codex',
    toolbarTarget,
  });
  if (!tabbed) {
    return h('div', { className: acquireOnly ? css.compact : css.sources }, dsh, codex);
  }
  return h(
    'div',
    { className: css.sources },
    h(
      'div',
      { className: css.tabBar },
      h(
        'div',
        { className: css.sourceTabs, role: 'tablist', 'aria-label': t('sync.layout.sessions') },
        ['dsh', 'codex'].map((value, index, tabs) =>
          h(
            Button,
            {
              key: value,
              variant: 'ghost',
              className: css.sourceTab,
              role: 'tab',
              id: id + '-' + value,
              'aria-selected': source === value,
              'aria-controls': id + '-' + value + '-panel',
              tabIndex: source === value ? 0 : -1,
              onClick: () => selectSource(value),
              onKeyDown: (event) => {
                let next;
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  next = (index + 1) % tabs.length;
                } else if (event.key === 'Home') {
                  next = 0;
                } else if (event.key === 'End') {
                  next = tabs.length - 1;
                }
                if (next !== undefined) {
                  event.preventDefault();
                  selectSource(tabs[next]);
                  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
                }
              },
            },
            t(value === 'dsh' ? 'sync.layout.dsh' : 'sync.layout.codex', {
              total: value === 'dsh' ? dshCount : codexCount,
              count: (value === 'dsh' ? dshSelection : codexSelection)?.ids?.length || 0,
            }),
          ),
        ),
      ),
      h('div', { className: css.toolbar, ref: setToolbarTarget }),
    ),
    ['dsh', 'codex'].map((value) =>
      h(
        'div',
        {
          key: value,
          id: id + '-' + value + '-panel',
          role: 'tabpanel',
          'aria-labelledby': id + '-' + value,
          hidden: source !== value,
          className: css.sourcePanel,
        },
        value === 'dsh' ? dsh : codex,
      ),
    ),
  );
}
module.exports = { ConversationSources };
