'use strict';
const React = require('react');
const { EnhancementSettings } = require('./ContextAssist.js');
const { LarkCliSettings } = require('./LarkCliSettings.js');
const { SettingsActionScope } = require('./shared/SettingsActionBar.js');
const { t } = require('../locale.js');
const css = require('./DependencySettings.module.css').default;
const h = React.createElement;
const TABS = ['gitnexus', 'lark'];

/**
 * Keep dependency configuration in independent, lazily mounted tab panels.
 * @param props - Workspace identity and optional dependency selected by a settings shortcut.
 * @returns Secondary tabs that retain visited drafts and active task views.
 */
function DependencySettings({ workspaceId, initialTab = 'gitnexus' }) {
  const firstTab = TABS.includes(initialTab) ? initialTab : 'gitnexus';
  const [tab, setTab] = React.useState(firstTab);
  const scope = React.useContext(SettingsActionScope);
  const [visited, setVisited] = React.useState([firstTab]);
  const buttons = React.useRef({});
  const id = React.useId();
  const selectTab = (key) => {
    setTab(key);
    setVisited((previous) => (previous.includes(key) ? previous : [...previous, key]));
  };
  return h(
    'div',
    { className: css.panel },
    h(
      'div',
      {
        className: `rh-workbench-tabs ${css.tabs}`,
        role: 'tablist',
        'aria-label': t('dependencies.tabs'),
      },
      TABS.map((key, index) =>
        h(
          'button',
          {
            key,
            ref: (node) => {
              buttons.current[key] = node;
            },
            id: `${id}-tab-${key}`,
            type: 'button',
            role: 'tab',
            className: 'rh-workbench-tab',
            'aria-selected': tab === key,
            'aria-controls': `${id}-panel-${key}`,
            tabIndex: tab === key ? 0 : -1,
            onClick: () => selectTab(key),
            onKeyDown: (event) => {
              let next;
              if (event.key === 'ArrowRight') {
                next = (index + 1) % TABS.length;
              } else if (event.key === 'ArrowLeft') {
                next = (index + TABS.length - 1) % TABS.length;
              } else if (event.key === 'Home') {
                next = 0;
              } else if (event.key === 'End') {
                next = TABS.length - 1;
              }
              if (next !== undefined) {
                event.preventDefault();
                event.stopPropagation();
                selectTab(TABS[next]);
                buttons.current[TABS[next]]?.focus();
              }
            },
          },
          t(`dependencies.${key}`),
        ),
      ),
    ),
    TABS.map((key) =>
      h(
        'div',
        {
          key,
          id: `${id}-panel-${key}`,
          role: 'tabpanel',
          'aria-labelledby': `${id}-tab-${key}`,
          className: css.content,
          hidden: tab !== key,
          tabIndex: 0,
        },
        visited.includes(key) &&
          h(
            SettingsActionScope.Provider,
            { value: { ...scope, active: scope.active && tab === key } },
            key === 'gitnexus'
              ? h(EnhancementSettings, { key: workspaceId, workspaceId })
              : h(LarkCliSettings, { workspaceId }),
          ),
      ),
    ),
  );
}
module.exports = { DependencySettings };
