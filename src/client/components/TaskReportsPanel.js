'use strict';
const clientApi = require('../api/index.js');
const { formatDateTime, useTimeZone } = require('../time.js');
const { PagedList } = require('./shared/PagedList.js');
const React = require('react');
const { t, hasLocaleKey } = require('../locale.js');
const { localizeMessage } = require('../utils/serverMessage.js');
const { Button } = require('./shared/Button.js');
const css = require('./TaskReportsPanel.module.css').default;
const h = React.createElement;

/** Browse scheduled reports and navigate with scoped server-provided document identities. */
function TaskReportsPanel({ onClose, onNavigate }) {
  useTimeZone();
  const [tab, setTab] = React.useState('knowledge');
  const [items, setItems] = React.useState([]);
  const [detail, setDetail] = React.useState(null);
  const [cursor, setCursor] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const owner = React.useRef(null);
  const historyPage = React.useRef(0);
  const trackPage = React.useCallback((page) => {
    historyPage.current = page;
  }, []);
  // Host-owned statuses may grow independently of the plugin dictionary.
  const label = (key) => (hasLocaleKey(`reports.${key}`) ? t(`reports.${key}`) : key);
  const request = async (query, signal) => {
    return clientApi.requestJson(clientApi.endpoint('task-reports', query), { signal });
  };
  React.useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    let timer;
    const load = async () => {
      if (!detail && historyPage.current > 0) {
        timer = setTimeout(load, 2000);
        return;
      }
      setLoading(true);
      try {
        const result = await request(detail ? { id: detail.id } : { kind: tab }, controller.signal);
        if (!controller.signal.aborted) {
          if (detail) {
            setDetail(result);
          } else {
            if (!Array.isArray(result.items)) {
              throw new Error('REPORT_INVALID_RESPONSE');
            }
            setItems(result.items);
            setCursor(result.nextCursor ?? null);
          }
          setError(null);
          if (
            (detail ? [result] : result.items).some((item) =>
              ['running', 'waiting_session'].includes(item.status),
            )
          ) {
            timer = setTimeout(load, 2000);
          }
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [tab, detail?.id, revision]);
  const stats = (value) => {
    const counts = t(tab === 'knowledge' ? 'reports.knowledgeStats' : 'reports.syncStats', {
      documents: value?.documents || 0,
      sessions: value?.sessions || 0,
      branches: value?.branches || 0,
    });
    return (
      counts +
      ' · ' +
      t('reports.stats', {
        workspaces: value?.workspaces || 0,
        total: value?.total || 0,
        succeeded: value?.succeeded || 0,
        failed: value?.failed || 0,
        pending: value?.pending || 0,
      })
    );
  };
  const status = (value) => label('status.' + value);
  return h(
    'section',
    { className: css.panel },
    h(
      'header',
      { className: css.header },
      h(
        'div',
        { role: 'tablist', 'aria-label': label('title'), className: css.tabs },
        ...['knowledge', 'sync'].map((id, index) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              'aria-selected': tab === id,
              tabIndex: tab === id ? 0 : -1,
              className: css.tab,
              onClick: () => {
                setDetail(null);
                setItems([]);
                setTab(id);
              },
              onKeyDown: (event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  let next = 1 - index;
                  if (event.key === 'Home') {
                    next = 0;
                  } else if (event.key === 'End') {
                    next = 1;
                  }
                  setDetail(null);
                  setItems([]);
                  setTab(['knowledge', 'sync'][next]);
                  event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
                }
              },
            },
            label(id),
          ),
        ),
      ),
      h(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, t('common.close')),
    ),
    h(
      'div',
      { className: css.toolbar },
      detail &&
        h(Button, { size: 'sm', variant: 'ghost', onClick: () => setDetail(null) }, label('back')),
      h(
        Button,
        { size: 'sm', disabled: loading, onClick: () => setRevision((value) => value + 1) },
        label('refresh'),
      ),
    ),
    error && h('p', { role: 'alert' }, error),
    loading && h('p', { role: 'status' }, label('loading')),
    !detail && !loading && !items.length && h('p', null, label('empty')),
    !detail &&
      h(
        PagedList,
        {
          resetKey: tab,
          onPageChange: trackPage,
          hasMore: cursor !== null,
          onMore: async () => {
            const signal = owner.current.signal;
            try {
              const next = await request({ kind: tab, cursor }, signal);
              if (!signal.aborted) {
                setItems((old) => [...old, ...next.items]);
                setCursor(next.nextCursor ?? null);
              }
            } catch (reason) {
              if (!signal.aborted) {
                setError(reason.message);
              }
            }
          },
          busy: loading,
        },
        items.map((report) =>
          h(
            'article',
            { key: report.id, className: css.record },
            h('h3', null, report.day, ' · ', status(report.status)),
            h('p', null, stats(report.stats)),
            h('p', { className: css.hint }, formatDateTime(report.startedAt)),
            report.targetDay && h('p', null, t('reports.targetDay', { day: report.targetDay })),
            h(
              Button,
              { size: 'sm', onClick: () => setDetail({ id: report.id, workspaces: [] }) },
              label('detail'),
            ),
          ),
        ),
      ),
    detail &&
      h(
        'div',
        { className: css.list },
        h(
          'p',
          null,
          detail.day,
          ' · ',
          status(detail.status || 'running'),
          ' · ',
          stats(detail.stats),
        ),
        ...[
          h(
            PagedList,
            { resetKey: detail.id },
            (detail.workspaces || []).flatMap((workspace) =>
              workspace.items.map((item) =>
                h(
                  'article',
                  { key: workspace.id + item.key, className: css.record },
                  h(
                    'h3',
                    null,
                    item.branch || localizeMessage(item.title) || item.sessionId || workspace.title,
                  ),
                  item.source &&
                    h('span', { className: css.badge }, item.source === 'dsh' ? 'DSH' : 'Codex'),
                  h('p', null, workspace.title, ' · ', status(item.status)),
                  item.originWorkspace && h('p', { className: css.hint }, item.originWorkspace),
                  item.reason && h('p', { className: css.hint }, localizeMessage(item.reason)),
                  item.error && h('p', { role: 'alert' }, localizeMessage(item.error)),
                  (item.documentId || item.documentIds?.[0]) &&
                    h(
                      Button,
                      {
                        size: 'sm',
                        onClick: () =>
                          onNavigate({
                            kind: 'knowledge',
                            workspaceId: workspace.id,
                            documentId: item.documentId || item.documentIds[0],
                          }),
                      },
                      label('source'),
                    ),
                  ...(item.tasks || []).map((task) =>
                    h(
                      'div',
                      { key: task.id, className: css.toolbar },
                      h(
                        Button,
                        {
                          size: 'sm',
                          onClick: () =>
                            onNavigate({ kind: 'sync', workspaceId: workspace.id, task }),
                        },
                        t(
                          task.docType === 'design'
                            ? 'documents.design'
                            : 'DocsViewerBody.message073',
                        ),
                        ' · ',
                        label('history'),
                      ),
                      ['completed', 'state_committed', 'document_written'].includes(
                        task.publishState || task.status,
                      ) &&
                        h(
                          Button,
                          {
                            size: 'sm',
                            onClick: () =>
                              onNavigate({ kind: 'document', workspaceId: workspace.id, task }),
                          },
                          label('artifact'),
                        ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    null,
  );
}
module.exports = { TaskReportsPanel };
