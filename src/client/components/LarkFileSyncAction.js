'use strict';
const clientApi = require('../api/index.js');
const React = require('react');
const { t, hasLocaleKey } = require('../locale.js');
const { Button } = require('./shared/Button.js');
const { showToast } = require('./shared/ToastContainer.js');
const h = React.createElement;

/**
 * Map a stable Lark error code to user-facing text without echoing CLI output.
 * @param code - Public LARK_* code returned by Host.
 * @returns Localized message.
 */
function errorText(code) {
  const key = `lark.${code}`;
  return hasLocaleKey(key) ? t(key) : t('lark.sync.failed');
}

/**
 * Publish the saved document into the workspace's bound Lark parent. Host owns
 * directory creation and the create-vs-update decision for the same file name.
 * @param props - {workspaceId, path, name, dirty} from the preview header.
 * @returns One ghost action button.
 */
function LarkFileSyncAction({ workspaceId, path, name, dirty }) {
  const [busy, setBusy] = React.useState(false);
  const sync = async () => {
    setBusy(true);
    try {
      const response = await clientApi.request(clientApi.endpoint('lark/file-sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, path }),
      });
      const data = await response.json();
      if (!response.ok || !data.synced) {
        showToast({
          tone: 'error',
          text: errorText(data.code || 'LARK_SYNC_FAILED'),
          holdMs: 4000,
        });
        return;
      }
      showToast({
        tone: 'success',
        text: t(data.action === 'updated' ? 'lark.sync.updated' : 'lark.sync.created', {
          path: data.path,
        }),
        holdMs: 3000,
      });
    } catch {
      showToast({ tone: 'error', text: t('lark.sync.failed'), holdMs: 3000 });
    } finally {
      setBusy(false);
    }
  };
  return h(
    Button,
    {
      variant: 'ghost',
      size: 'sm',
      disabled: busy || dirty,
      title: dirty ? t('lark.sync.saveFirst') : t('lark.sync.title', { name: name || path }),
      onClick: sync,
    },
    busy ? t('lark.sync.busy') : t('lark.sync.action'),
  );
}
module.exports = { LarkFileSyncAction };
