'use strict';
/**
 * Constants for ReqHub client.
 * Contains route paths, tab identifiers, and script element IDs.
 *
 * @module req-hub/client/constants
 */


/**
 * Base route path for the ReqHub plugin.
 * @constant {string}
 */
const ROUTE = '/req-hub';

/**
 * Tab kind identifier used for sidebar tab registration.
 * @constant {string}
 */
const TAB_KIND = 'req-hub';

/**
 * Unique tab ID for the ReqHub sidebar tab.
 * @constant {string}
 */
const TAB_ID = '@local/req-hub';

/**
 * Script element ID for the Marked markdown parser library.
 * @constant {string}
 */
const MARKED_SCRIPT_ID = 'req-hub-marked';

/**
 * Script element ID for the Mermaid diagram rendering library.
 * @constant {string}
 */
const MERMAID_SCRIPT_ID = 'req-hub-mermaid';

/**
 * Script element ID for the Highlight.js syntax highlighting library.
 * @constant {string}
 */
const HIGHLIGHT_SCRIPT_ID = 'req-hub-highlight';

module.exports = {
  ROUTE,
  TAB_KIND,
  TAB_ID,
  MARKED_SCRIPT_ID,
  MERMAID_SCRIPT_ID,
  HIGHLIGHT_SCRIPT_ID,
};
