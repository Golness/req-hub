'use strict';
const React = require('react');
const { SettingsActionScope } = require('./SettingsActionBar.js');
const css = require('./SettingsTabs.module.css').default;
const h = React.createElement;

/**
 * Keep independent settings pages below fixed tabs and above one fixed action dock.
 * @param props - Label, keyed tabs with render callbacks, optional initial tab and nested flags.
 * @returns Retained visited pages; only the active page can contribute footer actions.
 */
function SettingsTabs({ label, tabs, initialTab }) {
  const first = tabs.some((tab) => tab.id === initialTab) ? initialTab : tabs[0].id;
  const [selected, setSelected] = React.useState(first);
  const [visited, setVisited] = React.useState([first]);
  const [target, setTarget] = React.useState(null);
  const scope = React.useContext(SettingsActionScope);
  const id = React.useId();
  const select = (key) => {
    setSelected(key);
    setVisited((previous) => (previous.includes(key) ? previous : [...previous, key]));
  };
  return h(
    'section',
    { className: css.panel },
    h(
      'div',
      { className: `rh-workbench-tabs ${css.tabs}`, role: 'tablist', 'aria-label': label },
      tabs.map((tab, index) =>
        h(
          'button',
          {
            key: tab.id,
            id: `${id}-tab-${tab.id}`,
            type: 'button',
            role: 'tab',
            className: 'rh-workbench-tab',
            'aria-selected': selected === tab.id,
            'aria-controls': `${id}-panel-${tab.id}`,
            tabIndex: selected === tab.id ? 0 : -1,
            onClick: () => select(tab.id),
            onKeyDown: (event) => {
              let next;
              if (event.key === 'ArrowRight') {
                next = (index + 1) % tabs.length;
              } else if (event.key === 'ArrowLeft') {
                next = (index + tabs.length - 1) % tabs.length;
              } else if (event.key === 'Home') {
                next = 0;
              } else if (event.key === 'End') {
                next = tabs.length - 1;
              }
              if (next !== undefined) {
                event.preventDefault();
                event.stopPropagation();
                select(tabs[next].id);
                event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
              }
            },
          },
          tab.label,
        ),
      ),
    ),
    h(
      'div',
      { className: css.body },
      tabs.map((tab) =>
        h(
          'div',
          {
            key: tab.id,
            id: `${id}-panel-${tab.id}`,
            role: 'tabpanel',
            'aria-labelledby': `${id}-tab-${tab.id}`,
            hidden: selected !== tab.id,
            className: `${css.content} ${tab.nested ? css.nested : ''}`,
            tabIndex: 0,
          },
          visited.includes(tab.id) &&
            h(
              SettingsActionScope.Provider,
              {
                value: {
                  active: scope.active && selected === tab.id,
                  target: scope.target || target,
                },
              },
              tab.render(),
            ),
        ),
      ),
    ),
    !scope.target && h('div', { className: css.dock, ref: setTarget, 'data-settings-dock': '' }),
  );
}
module.exports = { SettingsTabs };
