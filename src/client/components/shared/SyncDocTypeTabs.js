'use strict';
const React = require('react');
const { t } = require('../../locale.js');
const h = React.createElement;

/**
 * Filter comparison and history records through the same keyboard-accessible tabs.
 * @param props - Selected document type, change callback and associated panel ID.
 * @returns The document-type tab list with one keyboard focus target.
 */
function SyncDocTypeTabs({ value, onChange, panelId }) {
  const types = ['requirement', 'design'];
  return h(
    'div',
    {
      className: 'rh-workbench-tabs',
      role: 'tablist',
      'aria-label': t('FileTreeSidebar.message020'),
    },
    types.map((type, index) =>
      h(
        'button',
        {
          key: type,
          id: `${panelId}-tab-${type}`,
          type: 'button',
          role: 'tab',
          className: 'rh-workbench-tab',
          'aria-selected': value === type,
          'aria-controls': panelId,
          tabIndex: value === type ? 0 : -1,
          onClick: () => onChange(type),
          onKeyDown: (event) => {
            let next;
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              next = (index + 1) % types.length;
            } else if (event.key === 'Home') {
              next = 0;
            } else if (event.key === 'End') {
              next = types.length - 1;
            }
            if (next !== undefined) {
              event.preventDefault();
              onChange(types[next]);
              event.currentTarget.parentElement.children[next].focus();
            }
          },
        },
        t(type === 'requirement' ? 'DocsViewerBody.message073' : 'documents.design'),
      ),
    ),
  );
}
module.exports = { SyncDocTypeTabs };
