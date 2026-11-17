'use strict';
const React = require('react');
const { SessionSelectionContext, useSelectedSessionId } = require('../context.js');
const { locateSessionRequirement } = require('../api/documents.js');

/**
 * Own the latest locate request for one viewer; superseded and unmounted results reject.
 * @param workspaces - Currently visible workspace descriptors.
 * @returns A locate action producing a decision and its signal for the subsequent commit.
 */
function useRequirementLocator(workspaces) {
  const getSession = React.useContext(SessionSelectionContext);
  const sessionId = useSelectedSessionId();
  const owner = React.useRef(null);
  React.useEffect(() => () => owner.current?.abort(), [workspaces, sessionId]);
  return async () => {
    owner.current?.abort();
    const controller = new AbortController();
    owner.current = controller;
    const selectedSession = getSession();
    const result = await locateSessionRequirement(selectedSession, workspaces, controller.signal);
    if (getSession() !== selectedSession) {
      controller.abort();
    }
    controller.signal.throwIfAborted();
    return { ...result, signal: controller.signal };
  };
}

module.exports = { useRequirementLocator };
