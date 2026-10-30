'use strict';
const React = require('react');
const { t } = require('../locale.js');
const css = require('./KnowledgeTabs.module.css').default;
const h = React.createElement;
const { knowledgeSection } = require('./knowledge-navigation.js');

/**
 * Select a knowledge view while retaining the current scope.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function KnowledgeTabs({ tab, onTabChange }) {
  return h(
    'div',
    { className: css.strip },
    h(
      'div',
      { className: 'rh-workbench-tabs', role: 'tablist', 'aria-label': t('knowledgeLayout.tabs') },
      [
        ['wiki', t('knowledge.wiki')],
        ['files', t('knowledge.sources')],
        ['review', t('knowledge.review')],
        ['lint', t('knowledge.maintenance')],
      ].map(([id, text], index, tabs) =>
        h(
          'button',
          {
            key: id,
            id: `knowledge-tab-${id}`,
            type: 'button',
            role: 'tab',
            className: 'rh-workbench-tab',
            'aria-selected': knowledgeSection(tab) === knowledgeSection(id),
            'aria-controls': 'knowledge-content',
            tabIndex: knowledgeSection(tab) === knowledgeSection(id) ? 0 : -1,
            onClick: () => onTabChange(id),
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
                onTabChange(tabs[next][0]);
                event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
              }
            },
          },
          text,
        ),
      ),
    ),
  );
}
module.exports = { KnowledgeTabs };
