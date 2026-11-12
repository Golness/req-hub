'use strict';
const React = require('react');
const { t } = require('../../locale.js');
const { Button } = require('../shared/Button.js');
const { useKnowledgeJobs } = require('../../hooks/useKnowledgeV2.js');
const { WikiBrowser } = require('./WikiBrowser.js');
const { SourcesPanel } = require('./SourcesPanel.js');
const { QueryPanel } = require('./QueryPanel.js');
const { LintPanel } = require('./LintPanel.js');
const { TasksDrawer } = require('./TasksDrawer.js');
const { KnowledgeSettings } = require('./KnowledgeSettings.js');
const css = require('./KnowledgeWorkspace.module.css').default;
const h = React.createElement;
const { IconSettings, IconHourglass } = require('../../icons.js').createIconComponents(h);

const TABS = ['wiki', 'sources', 'query', 'lint'];

/**
 * Knowledge workspace over the v2 API: Wiki, sources, query and lint views.
 * Visited views stay mounted so query history and lint findings survive tab switches.
 * @param props - Workspace identity, active tab, visibility and navigation callbacks.
 * @returns The rendered component content.
 */
function KnowledgeWorkspace({
  workspaceId,
  tab,
  onTabChange,
  active = true,
  initialPageId,
  initialSourceId,
  onOpenFile,
  docsDir,
}) {
  const jobs = useKnowledgeJobs(workspaceId, active);
  const [revision, setRevision] = React.useState(0);
  const [tasksOpen, setTasksOpen] = React.useState(false);
  const [pageRequest, setPageRequest] = React.useState(null);
  const [sourceRequest, setSourceRequest] = React.useState(null);
  const mounted = React.useRef(new Set());
  const lastTab = React.useRef('wiki');
  const requestToken = React.useRef(0);
  const view = TABS.includes(tab) ? tab : 'settings';
  if (view !== 'settings') {
    lastTab.current = view;
  }
  mounted.current.add(view);
  const refresh = () => {
    setRevision((value) => value + 1);
    jobs.refresh();
  };
  const openPage = (pageId) => {
    setPageRequest({ pageId, token: ++requestToken.current });
    onTabChange('wiki');
  };
  const openSource = (sourceId) => {
    setSourceRequest({ sourceId, token: ++requestToken.current });
    onTabChange('sources');
  };
  const generationId =
    jobs.jobs.find((job) => job.status === 'completed' && job.generationId)?.generationId || null;
  const initialRequest = React.useMemo(
    () => (initialPageId ? { pageId: initialPageId, token: 0 } : null),
    [initialPageId],
  );
  const initialSourceRequest = React.useMemo(
    () => (initialSourceId ? { sourceId: initialSourceId, token: 0 } : null),
    [initialSourceId],
  );
  const panels = {
    wiki: () =>
      h(WikiBrowser, {
        workspaceId,
        refreshKey: revision,
        generationId,
        running: jobs.running,
        pageRequest: pageRequest || initialRequest,
        onChanged: refresh,
        onOpenImport: () => onTabChange('sources'),
        onOpenSource: openSource,
      }),
    sources: () =>
      h(SourcesPanel, {
        workspaceId,
        refreshKey: revision,
        generationId,
        sourceRequest: sourceRequest || initialSourceRequest,
        onChanged: refresh,
        onOpenFile,
        onOpenTasks: () => setTasksOpen(true),
        docsDir,
      }),
    query: () =>
      h(QueryPanel, { workspaceId, onOpenPage: openPage, onOpenSource: openSource }),
    lint: () => h(LintPanel, { workspaceId, jobs, onOpenPage: openPage }),
    settings: () => h(KnowledgeSettings, { workspaceId, onChanged: refresh }),
  };
  return h(
    'div',
    { className: css.workspace },
    h(
      'div',
      { className: css.header },
      h(
        'div',
        {
          className: `rh-workbench-tabs ${css.tabs}`,
          role: 'tablist',
          'aria-label': t('kb.tabs'),
        },
        TABS.map((id, index) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              className: 'rh-workbench-tab',
              'aria-selected': view === id,
              tabIndex: view === id ? 0 : -1,
              onClick: () => onTabChange(id),
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
                  onTabChange(TABS[next]);
                  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
                }
              },
            },
            t(`kb.tab.${id}`),
          ),
        ),
      ),
      h(
        'div',
        { className: css.headerActions },
        h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            icon: h(IconHourglass, { size: 14 }),
            onClick: () => setTasksOpen(true),
          },
          jobs.activeCount ? t('kb.tasksCount', { count: jobs.activeCount }) : t('kb.tasks'),
        ),
        h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            icon: h(IconSettings, { size: 14 }),
            'aria-label': t('kb.settings'),
            'aria-pressed': view === 'settings',
            onClick: () => onTabChange(view === 'settings' ? lastTab.current : 'settings'),
          },
        ),
      ),
    ),
    [...mounted.current].map((id) =>
      h(
        'div',
        {
          key: id,
          className: `${css.pane} ${id === 'settings' ? css.settingsPane : ''}`,
          hidden: view !== id,
          role: id === 'settings' ? undefined : 'tabpanel',
        },
        panels[id](),
      ),
    ),
    h(TasksDrawer, {
      open: tasksOpen,
      onClose: () => setTasksOpen(false),
      jobs,
    }),
  );
}
module.exports = { KnowledgeWorkspace };