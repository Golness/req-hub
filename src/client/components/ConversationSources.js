'use strict';
const React = require('react');
const { DshSessionsSection } = require('./DshSessionsSection.js');
const { CodexSessionsSection } = require('./CodexSessionsSection.js');
const css = require('./ConversationSources.module.css').default;
const h = React.createElement;

/** One acquisition/selection entry shared by document sync and knowledge import. */
function ConversationSources({ workspaceId, acquireOnly = false, dshSelection, codexSelection, onDshSelectionChange, onCodexSelectionChange, onView, onManage, onChanged, onRefreshStart, onBusyChange, disabled }) {
  const [activity, setActivity] = React.useState({ dsh: false, codex: false });
  const changeDshBusy = React.useCallback(value => setActivity(previous => ({ ...previous, dsh: value })), []);
  const changeCodexBusy = React.useCallback(value => setActivity(previous => ({ ...previous, codex: value })), []);
  const busy = activity.dsh || activity.codex;
  const notifyBusy = React.useRef(onBusyChange); notifyBusy.current = onBusyChange;
  React.useEffect(() => { notifyBusy.current?.(busy); }, [busy]);
  return h('div', { className: acquireOnly ? css.compact : css.sources },
    h(DshSessionsSection, { workspaceId, selection: dshSelection, onSelectionChange: onDshSelectionChange, onView, onManage, acquireOnly, onChanged, onRefreshStart, onBusyChange: changeDshBusy, disabled: disabled || busy }),
    h(CodexSessionsSection, { workspaceId, selection: codexSelection, onSelectionChange: onCodexSelectionChange, onView, acquireOnly, onChanged, onRefreshStart, onBusyChange: changeCodexBusy, disabled: disabled || busy }));
}
module.exports = { ConversationSources };
