'use strict';
/**
 * React Context for ReqHub cross-component communication.
 * Provides shared state and methods to descendant components.
 *
 * @module req-hub/client/context
 */

const React = require('react');

/**
 * React Context for the document viewer.
 * Provides methods for refreshing the file tree and selected requirement.
 *
 * @constant {React.Context}
 * @property {Function} refreshTree - Callback to refresh the file tree structure.
 * @property {Function} refreshSelectedReq - Callback to refresh the currently selected requirement.
 */
const DocsViewerContext = React.createContext({
  refreshTree: () => {},
  refreshSelectedReq: () => {},
});

// Only the selection getter crosses the component boundary, never the Host ctx.
const SessionSelectionContext = React.createContext(() => null);
const SessionSelectionStoreContext = React.createContext(null);

/**
 * Subscribe to the current session through the plugin's narrow selection interface.
 * @returns The selected session ID, or null when the optional Host selection is unavailable.
 */
function useSelectedSessionId() {
  const store = React.useContext(SessionSelectionStoreContext);
  const getSession = React.useContext(SessionSelectionContext);
  const snapshot = React.useCallback(
    () => (store ? store.getSnapshot() : getSession()),
    [store, getSession],
  );
  const subscribe = React.useCallback(
    (listener) => (store ? store.subscribe(listener) : () => {}),
    [store],
  );
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

module.exports = {
  DocsViewerContext,
  SessionSelectionContext,
  SessionSelectionStoreContext,
  useSelectedSessionId,
};
