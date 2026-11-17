'use strict';
const { CustomSyncPanel } = require('./sync/CustomSyncPanel.js');
const { QuickSync } = require('./sync/QuickSync.js');
const { SyncHistoryPanel } = require('./sync/History.js');
const { t } = require('../locale.js');
const css = require('./SyncPanel.module.css').default;
const { Button } = require('./shared/Button.js');
const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef } = React;
const { DocsViewerContext, SessionSelectionContext } = require('../context.js');
/**
 * Present quick and custom entries while retaining the existing sync executor.
 * @param props - Workspace, selected requirement and navigation callbacks.
 * @returns The tabbed synchronization panel.
 */
function SyncPanel(props) {
  const [tab, setTab] = useState(props.focusedSync ? 'history' : 'quick');
  const [historyRequirement, setHistoryRequirement] = useState(props.selectedReq);
  return h(
    'div',
    { className: css.panel },
    h(
      'div',
      { className: css.tabs },
      h(
        'div',
        { className: 'rh-workbench-tabs', role: 'tablist', 'aria-label': t('sync.tabs') },
        ['quick', 'custom', 'history'].map((id, index, tabs) =>
          h(
            'button',
            {
              key: id,
              id: `sync-tab-${id}`,
              type: 'button',
              role: 'tab',
              className: 'rh-workbench-tab',
              'aria-selected': tab === id,
              'aria-controls': `sync-content-${id}`,
              tabIndex: tab === id ? 0 : -1,
              onClick: () => setTab(id),
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
                  setTab(tabs[next]);
                  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
                }
              },
            },
            t(`sync.${id}`),
          ),
        ),
      ),
      h(Button, { size: 'sm', variant: 'ghost', onClick: props.onClose }, t('common.close')),
    ),
    ['quick', 'custom', 'history'].map((id) =>
      h(
        'div',
        {
          key: id,
          className: css.body,
          id: `sync-content-${id}`,
          role: 'tabpanel',
          'aria-labelledby': `sync-tab-${id}`,
          hidden: tab !== id,
        },
        h(SyncTabContent, {
          id,
          props,
          active: tab === id,
          historyRequirement,
          onRequirementReady: setHistoryRequirement,
        }),
      ),
    ),
  );
}

/**
 * Own a local return-button target after removing the old shell title bar.
 * @param props - Tab identity and sync panel properties.
 * @returns A panel with navigation contained within its tab.
 */
function SyncTabContent({ id, props, active, historyRequirement, onRequirementReady }) {
  const context = React.useContext(DocsViewerContext);
  const [target, setTarget] = useState(null);
  let content;
  if (id === 'quick') {
    content = h(QuickSync, {
      key: props.workspaceId,
      workspaceId: props.workspaceId,
      onRequirementReady,
      active,
    });
  } else if (id === 'history') {
    content = h(SyncHistoryPanel, {
      key: `${props.workspaceId}:${historyRequirement?.id || ''}`,
      workspaceId: props.workspaceId,
      selectedReq: historyRequirement,
      focusedSync:
        props.focusedSync?.requirementId === historyRequirement?.id ? props.focusedSync : null,
      active,
    });
  } else {
    content = h(CustomSyncPanel, props);
  }
  return h(
    DocsViewerContext.Provider,
    { value: { ...context, headerBackTarget: target } },
    h('div', { className: 'rh-header-back-slot', ref: setTarget }),
    content,
  );
}

module.exports = { SyncPanel };
