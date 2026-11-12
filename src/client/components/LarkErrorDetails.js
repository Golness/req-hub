'use strict';
const React = require('react');
const { t } = require('../locale.js');
const css = require('./shared/SettingsForm.module.css').default;
const h = React.createElement;

/**
 * Explain safe CLI diagnostic fields without rendering raw upstream messages.
 * @param props - Stable error code and the Host's sanitized diagnostic fields.
 * @returns Localized identity, upstream code and alternative permission scopes.
 */
function LarkErrorDetails({ code, details }) {
  if (!details) {
    return null;
  }
  const scopesRequired = ['LARK_APP_SCOPE_REQUIRED', 'LARK_USER_SCOPE_REQUIRED'].includes(code);
  const showResourceHelp = scopesRequired || code === 'LARK_TARGET_ACCESS_FAILED';
  const stages = [
    'workspace-path',
    'configuration',
    'authentication',
    'list-nodes',
    'create-node',
    'verify-node',
    'save-bindings',
  ];
  return h(
    React.Fragment,
    null,
    stages.includes(details.stage) &&
      h(
        'p',
        { className: css.muted },
        t('lark.errorStage', { stage: t(`lark.stage.${details.stage}`) }),
      ),
    Number.isSafeInteger(details.exitCode) &&
      h('p', { className: css.muted }, t('lark.errorExitCode', { code: details.exitCode })),
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ENOSPC'].includes(details.filesystemCode) &&
      h(
        'p',
        { className: css.muted },
        t('lark.errorFilesystem', { reason: t(`lark.filesystem.${details.filesystemCode}`) }),
      ),
    ['bot', 'user'].includes(details.identity) &&
      h(
        'p',
        { className: css.muted },
        t('lark.errorIdentity', {
          identity: details.identity === 'bot' ? t('lark.bot') : t('lark.user'),
        }),
      ),
    Number.isSafeInteger(details.upstreamCode) &&
      h('p', { className: css.muted }, t('lark.errorCode', { code: details.upstreamCode })),
    scopesRequired &&
      details.missingScopes?.length > 0 &&
      h(
        'p',
        { className: css.muted },
        t('lark.errorScopes', { scopes: details.missingScopes.join(' / ') }),
      ),
    details.batch &&
      h(
        'p',
        { className: css.muted },
        t('lark.defaultWikiBatchFailure', {
          completed: details.batch.completed,
          total: details.batch.total,
          created: details.batch.created,
          name: details.batch.failedWorkspace || t('lark.targetSave'),
        }),
      ),
    details.remoteChangePossible === true &&
      h('p', { className: css.muted }, t('lark.defaultWikiIncomplete')),
    showResourceHelp &&
      details.identity === 'bot' &&
      h('p', { className: css.muted }, t('lark.botResourceHelp')),
  );
}
module.exports = { LarkErrorDetails };
