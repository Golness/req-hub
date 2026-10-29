'use strict';
const { t } = require('../locale.js');

function syncActivityText(activity) {
  const stages = ['preparing', 'sessions', 'commits', 'sources', 'checking', 'budget', 'artifacts', 'chunks'];
  const stage = stages.includes(activity?.stage) ? activity.stage : 'preparing';
  const text = t(`sync.activity.${stage}`);
  return Number.isInteger(activity?.total) ? `${text} (${activity.current ?? 0}/${activity.total})` : text;
}

function syncErrorText(value) {
  const text = typeof value === 'string' ? value : '';
  return [...new Set(text.split('；'))].map(part => {
    const unread = /^EVIDENCE_NOT_FULLY_READ: ([^;]+); nextOffset=(\d+); totalChars=(\d+); remaining=(\d+)\./.exec(part);
    if (unread) return t('sync.error.incompleteEvidence', { artifactId: unread[1], offset: unread[2], total: unread[3], remaining: unread[4] });
    const knowledgeError = /^ENHANCEMENT_(?:BUDGET_EXCEEDED|INPUT_CHANGED|SCOPE_DENIED|INVALID_INPUT)$/.test(part);
    if (knowledgeError) return t(`enhancement.error.${part}`);
    return part.replace(
    /\b(CHANGE_BLOCK_ID|CHANGE_ACTION|CHANGE_TEXT|SYNC_OUTPUT_REPAIR_LIMIT|ANALYSIS_JSON_INVALID|ANALYSIS_SCHEMA|CHANGE_ID|CHANGE_EVIDENCE_OR_SCOPE|PENDING_SCHEMA|EVIDENCE_REFERENCE_NOT_READ|MERGE_CHANGE_DROPPED|SYNC_STORAGE_BUSY|SYNC_EXECUTION_REVOKED|SYNC_EXECUTION_INTERRUPTED|SYNC_RETIRE_LINK|SYNC_STORAGE_LINK|SYNC_SUBAGENT_FAILED|EXECUTION_ERROR|MAX_TOKENS_REACHED|EXECUTION_INTERRUPTED|REFUSAL|SYNC_TOOL_ISOLATION_FAILED|SYNC_REQUEST_BUDGET_EXCEEDED|SYNC_EVIDENCE_COMPACTED|EVIDENCE_NOT_FULLY_READ|OUTPUT_NOT_WRITTEN)\b/g,
    code => t(`sync.error.${code}`),
    );
  }).join('；');
}
module.exports = { syncActivityText, syncErrorText };
