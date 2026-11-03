'use strict';
const React = require('react');
const { t } = require('../locale.js');
const css = require('./KnowledgeTabs.module.css').default;
const h = React.createElement;
const { GROUPS, knowledgeSection } = require('./knowledge-navigation.js');
const { Button } = require('./shared/Button.js');

function isSelected(tab, id) {
  if (tab === 'documents' || id === 'documents') {
    return tab === id;
  }
  return knowledgeSection(tab) === knowledgeSection(id);
}

/**
 * Select a knowledge view while retaining the current scope.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function KnowledgeTabs({ tab, onTabChange, onClose, backTargetRef }) {
  return h(
    'div',
    { className: css.strip },
    h('div', { className: 'rh-header-back-slot', ref: backTargetRef }),
    h(
      'div',
      { className: 'rh-workbench-tabs', role: 'tablist', 'aria-label': t('knowledgeLayout.tabs') },
      [
        ['documents', t('knowledgeLayout.documents')],
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
            'aria-selected': isSelected(tab, id),
            'aria-controls': 'knowledge-content',
            tabIndex: isSelected(tab, id) ? 0 : -1,
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
    h(
      Button,
      {
        className: css.close,
        variant: 'ghost',
        size: 'sm',
        onClick: onClose,
        'aria-label': t('DocsViewerBody.message076'),
      },
      t('common.close'),
    ),
  );
}
/**
 * Place secondary navigation above the file tree and content columns.
 * @param props - Current leaf view and its navigation callback.
 * @returns The secondary navigation row, or null without secondary destinations.
 */
function KnowledgeSecondaryTabs({ tab, onTabChange }) {
  const section = knowledgeSection(tab);
  if (tab === 'documents' || !['sources', 'maintenance'].includes(section)) {
    return null;
  }
  const labels = {
    files: 'knowledgeLayout.files',
    sessions: 'knowledgeLayout.sessions',
    index: 'wiki.tab.index',
    search: 'DocsViewerBody.message055',
    lint: 'wiki.tab.lint',
    rules: 'wiki.tab.rules',
    changes: 'wiki.tab.changes',
    events: 'wiki.events.title',
    code: 'knowledge.code',
  };
  return h(
    'nav',
    { className: css.secondary, 'aria-label': t('knowledge.navigation') },
    GROUPS[section]
      .filter((id) => id !== 'documents')
      .map((id) =>
        h(
          Button,
          {
            key: id,
            size: 'sm',
            'aria-current': tab === id ? 'page' : undefined,
            onClick: () => onTabChange(id),
          },
          t(labels[id]),
        ),
      ),
  );
}
module.exports = { KnowledgeTabs, KnowledgeSecondaryTabs };
