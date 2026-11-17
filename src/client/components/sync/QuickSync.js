'use strict';
const { PhasedSyncUI } = require('./PhasedSyncUI.js');
const clientApi = require('../../api/index.js');
const { t } = require('../../locale.js');
const css = require('../SyncPanel.module.css').default;
const { Button } = require('../shared/Button.js');
const React = require('react');
const h = React.createElement;
const { useState, useEffect, useRef } = React;
const { DocsViewerContext, SessionSelectionContext } = require('../../context.js');
const { SyncBranchPicker } = require('../SyncBranchPicker.js');
const { parseBranchName } = require('../CreateDirForm.js');
const { createIconComponents } = require('../../icons.js');
const { IconSync, IconError, IconCheck, IconCancel, IconChevronDown } = createIconComponents(h);
/**
 * Resolve the branch's directory through existing Host operations before syncing.
 * @param props - The workspace owning the local feature branch.
 * @returns The quick entry or the existing phased sync view without conversations.
 */
function QuickSync({ workspaceId, onRequirementReady, active }) {
  const [branch, setBranch] = useState('');
  const [requirement, setRequirement] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const request = useRef(null);
  const { refreshTree } = React.useContext(DocsViewerContext);
  useEffect(() => () => request.current?.abort(), []);

  const start = async () => {
    if (busy || !branch) {
      return;
    }
    const parsed = parseBranchName(branch.trim());
    if (!parsed?.developer) {
      setError(t('sync.quick.branchInvalid'));
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    const read = async (url, options = {}) => {
      return clientApi.requestJson(url, { ...options, signal: controller.signal });
    };
    try {
      const params = new URLSearchParams({
        workspaceId,
        requirementId: parsed.requirementId,
        targetBranch: branch.trim(),
      });
      const info = await read(clientApi.endpoint('sync-branch-info', `${params}`));
      if (info.targetBranch !== branch.trim() || info.targetBranchError) {
        throw new Error(t('sync.quick.branchInvalid'));
      }
      if (!info.baseBranch) {
        throw new Error(t('sync.quick.baseMissing'));
      }
      const find = async () => {
        const data = await read(
          clientApi.endpoint('tree', `${new URLSearchParams({ workspaceId })}`),
        );
        for (const developer of data.tree.developers) {
          const item = developer.requirements.find((req) => req.id === parsed.requirementId);
          if (item) {
            return { ...item, developer: developer.name };
          }
        }
        return null;
      };
      let found = await find();
      if (!found) {
        try {
          await read(clientApi.endpoint('create-dir'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, ...parsed, createBranch: false }),
          });
        } catch (creationError) {
          found = await find();
          if (!found) {
            throw creationError;
          }
        }
        found ||= await find();
        if (!found) {
          throw new Error(t('sync.quick.directoryMissing'));
        }
        refreshTree?.();
      }
      onRequirementReady?.(found);
      setRequirement({ ...found, targetBranch: branch.trim() });
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.message);
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  };

  if (requirement) {
    return h(PhasedSyncUI, {
      workspaceId,
      selectedReq: requirement,
      activeTab: 'requirement',
      quick: true,
      syncing,
      setSyncing,
      refreshTree,
      onClose: () => setRequirement(null),
    });
  }
  return h(
    'div',
    { className: css.quickForm },
    h('p', { className: css.quickDescription }, t('sync.quick.description')),
    h(
      'div',
      { className: css.quickRow },
      h(
        'div',
        { className: css.quickField },
        h(SyncBranchPicker, {
          workspaceId,
          value: branch,
          onChange: setBranch,
          disabled: busy,
          active,
        }),
      ),
      h(
        Button,
        {
          className: css.quickAction,
          variant: 'primary',
          disabled: busy || !branch,
          onClick: start,
        },
        h(IconSync, { size: 16 }),
        busy ? t('common.loading') : t('sync.quick.start'),
      ),
    ),
    error && h('p', { className: 'rh-error', role: 'alert' }, error),
  );
}

module.exports = { QuickSync };
