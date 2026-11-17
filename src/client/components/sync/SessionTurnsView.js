'use strict';

const clientApi = require('../../api/index.js');
const { localizeMessage, clientError } = require('../../utils/serverMessage.js');
const { formatDateTime, useTimeZone } = require('../../time.js');
const { PagedList } = require('../shared/PagedList.js');
const { t } = require('../../locale.js');
const css = require('../SyncPanel.module.css').default;
const { cssValue } = require('../shared/presentation.js');
const { Button } = require('../shared/Button.js');
const React = require('react');
const h = React.createElement;
const { HeaderBack } = require('../shared/HeaderBack.js');
const { useState, useEffect, useRef } = React;
const { createIconComponents } = require('../../icons.js');
const { IconSync, IconError, IconCheck, IconCancel, IconChevronDown } = createIconComponents(h);
/**
 * @component
 * Displays the conversation turns of a session in an expandable list format.
 * Each turn shows ordered human input and labeled intermediate/final assistant text.
 * Supports expand all / collapse all functionality.
 * @param {Object} props - Component props
 * @param {string} props.sessionId - The session ID to load turns for
 * @param {string} props.sessionTitle - Display title for the session
 * @param {Function} props.onBack - Callback invoked to return to the previous view
 * @returns {JSX.Element}
 */
function SessionTurnsView({ workspaceId, sessionId, sessionTitle, snapshotVersion, onBack }) {
  useTimeZone();
  const [turnsData, setTurnsData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedTurns, setExpandedTurns] = useState(new Set());

  useEffect(() => {
    loadSessionTurns();
  }, [sessionId]);

  const loadSessionTurns = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await clientApi.request(
        clientApi.endpoint(
          'session-turns',
          `${new URLSearchParams({ workspaceId, sessionId, version: snapshotVersion })}`,
        ),
      );
      const data = await res.json();
      if (res.ok) {
        if (data.success) {
          setTurnsData(data);
        } else {
          setError(localizeMessage(data.error) || t('sync.loadFailed'));
        }
      } else {
        setError(localizeMessage(data.error) || t('sync.loadFailed'));
      }
    } catch (e) {
      console.error('Failed to load session turns:', e);
      setError(e.message || t('sync.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const toggleTurn = (turnNumber) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnNumber)) {
        next.delete(turnNumber);
      } else {
        next.add(turnNumber);
      }
      return next;
    });
  };

  const expandAll = () => {
    if (turnsData) {
      setExpandedTurns(new Set(turnsData.turns.map((turn) => turn.turnNumber)));
    }
  };

  const collapseAll = () => {
    setExpandedTurns(new Set());
  };

  if (loading) {
    return h(
      'div',
      { className: css.centered },
      h(HeaderBack, { onBack }),
      h('div', { className: css.mutedText }, t('common.loading')),
    );
  }

  if (error) {
    return h(
      'div',
      { className: css.section },
      h(HeaderBack, { onBack }),
      h('div', { className: css.row }, h(IconError, { size: 14 }), error),
    );
  }

  if (!turnsData || !turnsData.turns || turnsData.turns.length === 0) {
    return h(
      'div',
      { className: css.section },
      h(HeaderBack, { onBack: onBack, label: t('common.back') }),
      h('div', { className: css.mutedText2 }, t('SyncPanel.message006')),
    );
  }

  return h(
    'div',
    { className: css.column },
    // Header
    h(
      'div',
      { className: css.section2 },
      h(
        'div',
        { className: css.row2 },
        h(HeaderBack, { onBack: onBack, label: t('common.back') }),
        h('span', { className: css.heading }, sessionTitle || t('SyncPanel.message007')),
      ),
      h(
        'div',
        { className: css.row3 },
        h(
          'span',
          null,
          t('SyncPanel.message008', {
            value0: turnsData.turnCount || turnsData.turns?.length || 0,
          }),
        ),
        h('span', null, `•`),
        h(
          'span',
          null,
          t('SyncPanel.message009', { value0: ((turnsData.totalTokens || 0) / 1000).toFixed(1) }),
        ),
        h(
          'span',
          { className: css.spacing3 },
          expandedTurns.size === turnsData.turnCount
            ? h(
                Button,
                { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: collapseAll },
                t('SyncPanel.message010'),
              )
            : h(
                Button,
                { className: 'rh-btn rh-btn-ghost rh-btn-sm', onClick: expandAll },
                t('SyncPanel.message011'),
              ),
        ),
      ),
    ),

    // Turns list
    h(
      'div',
      { className: css.pane },
      h(
        PagedList,
        { className: css.turnPages },
        turnsData.turns.map((turn, idx) => {
          const isExpanded = expandedTurns.has(turn.turnNumber);
          const time = turn.time ? formatDateTime(turn.time) : '';
          const userInput = turn.messages?.find((message) => message.role === 'user')?.text || '';

          return h(
            'div',
            {
              key: idx,
              className: css.pane2,
            },
            // Turn header
            h(
              'div',
              {
                onClick: () => toggleTurn(turn.turnNumber),
                className: css.row4,
                style: {
                  '--rh-background-1': cssValue(
                    isExpanded ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
                  ),
                },
              },
              h(
                'span',
                { className: css.heading2 },
                t('SyncPanel.message012', { value0: turn.turnNumber }),
              ),
              h('span', { className: css.pane3 }, userInput.substring(0, 100)),
              !turn.syncable && h('span', { className: css.mutedText3 }, t('SyncPanel.message013')),
              h('span', { className: css.mutedText4 }, time),
              h(
                'span',
                {
                  className: css.mutedText5,
                  style: {
                    '--rh-transform-2': cssValue(isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'),
                  },
                },
                h(IconChevronDown, { size: 12 }),
              ),
            ),

            // Turn content (expanded)
            isExpanded &&
              h(
                'div',
                { className: css.section3 },
                (turn.messages || []).map((message, messageIndex) =>
                  h(
                    'div',
                    {
                      key: messageIndex,
                      className: css.spacing2,
                    },
                    h('div', { className: css.heading3 }, message.label),
                    h(
                      'div',
                      {
                        className: css.section4,
                        style: {
                          '--rh-border-left-7': cssValue(
                            '3px solid ' +
                              (message.kind === 'final'
                                ? 'var(--dsw-alias-state-success-primary)'
                                : 'var(--rh-accent)'),
                          ),
                        },
                      },
                      message.text,
                    ),
                  ),
                ),
              ),
          );
        }),
      ),
    ),
  );
}

module.exports = { SessionTurnsView };
