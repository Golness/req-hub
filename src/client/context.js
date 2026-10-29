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
module.exports = { DocsViewerContext, SessionSelectionContext };
