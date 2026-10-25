'use strict';
const React = require('react');
const { t } = require('../locale.js');
const h = React.createElement;
function ConversationProvenance({ conversation }) {
  if (!conversation) return null;
  return h('section', { 'aria-label': t('conversationImport.provenance') },
    h('p', null, t('conversationImport.origin', { source: conversation.source === 'dsh' ? 'DSH' : 'Codex', workspace: conversation.sourceWorkspaceTitle, title: conversation.title })),
    conversation.sourceWorkspacePaths?.length > 0 && h('p', null, conversation.sourceWorkspacePaths.join(' · ')),
    h('p', null, t('conversationImport.frozen')),
    h('details', null, h('summary', null, t('conversationImport.provenance')),
      h('p', null, conversation.nativeSessionId),
      conversation.turns.map(turn => h('p', { key: turn.key }, t('conversationImport.turnVersion', { number: turn.number, version: turn.snapshotVersion.slice(0, 12), start: turn.startLine, end: turn.endLine })))));
}
module.exports = { ConversationProvenance };
