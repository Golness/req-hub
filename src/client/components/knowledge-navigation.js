'use strict';
const GROUPS = {
  wiki: ['wiki', 'query'],
  sources: ['files', 'sessions', 'index', 'documents', 'search'],
  review: ['review'],
  maintenance: ['lint', 'rules', 'changes', 'events', 'code'],
};
/**
 * Keep deep links in their stable section while retaining document editor ownership.
 * @param tab - The selected leaf view.
 * @returns The primary navigation key.
 */
function knowledgeSection(tab) {
  return Object.keys(GROUPS).find((key) => GROUPS[key].includes(tab)) || 'wiki';
}
module.exports = { GROUPS, knowledgeSection };
