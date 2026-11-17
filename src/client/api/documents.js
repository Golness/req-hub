'use strict';
const { endpoint } = require('./endpoints.js');
const { requestJson } = require('./transport.js');
const { parseBranchName } = require('../utils/parseBranchName.js');
const { findBranchRequirement } = require('../utils/findBranchRequirement.js');

/**
 * Resolve the selected session against registered workspaces and the current branch.
 * @param sessionId - Explicit selected session, never a fallback from session history.
 * @param workspaces - Workspaces visible to this viewer.
 * @param signal - Caller-owned cancellation checked before any subsequent request.
 * @returns A navigation decision without changing configuration or React state.
 */
async function locateSessionRequirement(sessionId, workspaces, signal) {
  if (!sessionId) {
    return { kind: 'no-session' };
  }
  const read = (name, query) => requestJson(endpoint(name, query), { signal, cache: 'no-store' });
  const { session } = await read('session-info', { sessionId });
  if (!session?.cwd) {
    return { kind: 'unavailable' };
  }
  const normalize = (path) => path.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const workspace = workspaces.find((item) => normalize(item.path) === normalize(session.cwd));
  if (!workspace) {
    return { kind: 'unavailable' };
  }
  const { branch } = await read('git-branch', { workspaceId: workspace.id });
  if (!branch) {
    return { kind: 'unavailable' };
  }
  const parsed = parseBranchName(branch);
  if (!parsed?.developer || !parsed.date) {
    return { kind: 'create-branch', workspace, branch };
  }
  const data = await read('tree', { workspaceId: workspace.id, t: Date.now() });
  const { match, ambiguous } = findBranchRequirement(
    data.tree,
    parsed,
    data.caseSensitivePaths !== false,
  );
  if (ambiguous) {
    return { kind: 'ambiguous' };
  }
  if (match) {
    return { kind: 'existing', workspace, requirement: match };
  }
  return { kind: 'missing', workspace, pending: { workspace, ...parsed } };
}

module.exports = { locateSessionRequirement };
