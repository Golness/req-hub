'use strict';
const { formatDate, useTimeZone } = require('../time.js');
const { Checkbox } = require('./shared/controls.js');
const { t } = require('../locale.js');
const css = require('./CreateDirForm.module.css').default;
const { Input } = require('./shared/Input.js');
const { DatePicker } = require('./shared/DatePicker.js');
const { Button } = require('./shared/Button.js');
const { showToast } = require('./shared/ToastContainer.js');
const { ModalFrame } = require('./shared/ModalFrame.js');

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;

const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');

/**
 * Parse developer/date-title or developer-date-title, optionally prefixed with feature/.
 * A bare YYYY-MM-DD-title is also accepted. Keep parsing aligned with server/utils.js.
 * @param {string} branch - The current Git branch name.
 * @returns {Object|null} Requirement identity, or null when the branch is unrecognized.
 */
function parseBranchName(branch) {
  if (!branch) {
    return null;
  }

  const feature = branch.match(/^feature\/(?:([^/]+)\/)?(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (feature) {
    const [, developer, date, title] = feature;
    return { developer: developer || null, date, title, requirementId: `${date}-${title}` };
  }
  const match1 = branch.match(/^(?:feature\/)?([^/-]+)[/-](\d{4}-\d{2}-\d{2})-(.+)$/);
  if (match1) {
    const [, developer, date, title] = match1;
    return { developer, date, title, requirementId: `${date}-${title}` };
  }

  const match2 = branch.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (match2) {
    const [, date, title] = match2;
    return { developer: null, date, title, requirementId: `${date}-${title}` };
  }

  return null;
}

/**
 * @component CreateDirForm
 * @description Form for creating requirement document directories following Git branch naming conventions.
 * Supports auto-filling from current branch, generating branch names, and optionally creating
 * a new Git branch.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The unique identifier of the workspace
 * @param {string} props.docsDir - The path to the documents directory
 * @param {Function} props.onClose - Callback invoked when the form is closed
 * @param {boolean} [props.initialCreateBranch=false] - Whether to initially check the "create branch" option
 * @param {number} [props.refreshVersion=0] - Refresh branch status after explicit navigation.
 * @param {Function} [props.onCreated] - Callback invoked after successful directory creation with requirement info
 * @returns {JSX.Element} A form with developer, date, title fields and branch creation options
 */
function CreateDirForm({
  workspaceId,
  docsDir,
  onClose,
  initialCreateBranch,
  refreshVersion = 0,
  onCreated,
  onExisting,
}) {
  useTimeZone();
  const formId = React.useId();
  const [developer, setDeveloper] = useState('');
  const [date, setDate] = useState(formatDate(new Date()));
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const { refreshTree } = React.useContext(DocsViewerContext);

  const [createBranch, setCreateBranch] = useState(!!initialCreateBranch);
  const [currentBranch, setCurrentBranch] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [checking, setChecking] = useState(true);
  const [creation, setCreation] = useState(null);
  const [checkRevision, setCheckRevision] = useState(0);
  const callbacks = React.useRef({ onClose, onExisting });
  callbacks.current = { onClose, onExisting };
  const pullRef = React.useRef(null);
  const [updatingMain, setUpdatingMain] = useState(false);
  useEffect(() => () => pullRef.current?.abort(), []);

  // Fetch current git branch and auto-fill form
  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setCreation(null);
    setCurrentBranch('');
    setError(null);
    (async () => {
      try {
        const [res, defaults] = await Promise.all([
          fetch(`${ROUTE}/create-status?workspaceId=${encodeURIComponent(workspaceId)}`, {
            signal: controller.signal,
            cache: 'no-store',
          }),
          fetch(`${ROUTE}/config`, { signal: controller.signal, cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : {}))
            .catch(() => ({})),
        ]);
        if (!res.ok) {
          throw new Error('CREATE_FAILED');
        }
        const data = await res.json();
        if (controller.signal.aborted) {
          return;
        }
        setDeveloper((value) => value || defaults.defaultUsername || '');
        if (data.existingRequirement) {
          if (!callbacks.current.onExisting) {
            showToast({
              tone: 'info',
              text: t('create.alreadyExists', {
                branch: data.branch,
                path: data.existingRequirement.path,
              }),
              holdMs: 6000,
            });
          }
          await callbacks.current.onExisting?.(data.existingRequirement, data.branch);
          callbacks.current.onClose?.();
          return;
        }
        setCreation(data);
        if (!data.branch) {
          return;
        }

        setCurrentBranch(data.branch);

        const parsed = parseBranchName(data.branch);
        if (parsed) {
          if (parsed.developer) {
            setDeveloper((value) => value || parsed.developer);
          }
          setDate(parsed.date);
          setTitle(parsed.title);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(t('create.statusFailed'));
        }
      } finally {
        if (!controller.signal.aborted) {
          setChecking(false);
        }
      }
    })();
    return () => controller.abort();
  }, [workspaceId, checkRevision, refreshVersion]);

  const updateMain = async () => {
    if (loading || !creation?.canUpdateMain) {
      return;
    }
    const controller = new AbortController();
    pullRef.current = controller;
    setLoading(true);
    setUpdatingMain(true);
    setError(null);
    try {
      const response = await fetch(`${ROUTE}/update-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, expectedHead: creation.head, branch: creation.branch }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (controller.signal.aborted) {
        return;
      }
      if (!response.ok) {
        const codes = {
          CREATE_MAIN_CHANGED: 'create.mainChanged',
          CREATE_MAIN_REMOTE_MISSING: 'create.remoteMissing',
          CREATE_MAIN_FETCH_FAILED: 'create.fetchFailed',
          CREATE_MAIN_MERGE_FAILED: 'create.mergeFailed',
        };
        throw new Error(
          t(codes[result.error] || 'create.updateFailed', { branch: creation.branch }),
        );
      }
      showToast({
        tone: 'success',
        text: t(result.updated ? 'create.mainUpdated' : 'create.mainCurrent', {
          branch: result.branch || creation.branch,
        }),
      });
      setCheckRevision((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error.message);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setUpdatingMain(false);
      }
    }
  };

  // The branch name is derived from the form and cannot be edited independently.
  const generatedBranchName =
    developer && date && title
      ? `feature/${developer}/${date}-${title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\u4e00-\u9fa5\-_]/g, '')}`
      : '';

  const previewPath =
    developer && date && title ? `${docsDir}/${developer}/${date}-${title}/` : null;

  const isMainBranch = ['main', 'master'].includes(currentBranch);
  const blockedReasons = {
    CREATE_MAIN_NOT_ROOT: 'create.mainNotRoot',
    CREATE_MAIN_IN_PROGRESS: 'create.mainInProgress',
    CREATE_MAIN_DIRTY: 'create.mainDirty',
  };
  let mainUpdateHint = t('create.updateMainHint');
  if (isMainBranch && !creation?.canUpdateMain) {
    let reason = blockedReasons[creation?.mainUpdateBlockedReason];
    if (!reason && creation?.inProgress) {
      reason = 'create.mainInProgress';
    }
    if (!reason && creation?.dirty) {
      reason = 'create.mainDirty';
    }
    mainUpdateHint = t(reason || 'create.mainUnavailable');
  }

  const handleCreateClick = () => {
    if (!developer || !date || !title) {
      setError(t('CreateDirForm.message001'));
      return;
    }
    if (createBranch) {
      setShowConfirm(true);
    } else {
      doCreate();
    }
  };

  const doCreate = async () => {
    setShowConfirm(false);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${ROUTE}/create-dir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          developer,
          date,
          title,
          createBranch,
          branchName: createBranch ? generatedBranchName : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data.error === 'CREATE_ALREADY_EXISTS'
            ? t('create.alreadyExists', { branch: data.branch, path: data.requirement.path })
            : data.error || t('CreateDirForm.message002'),
        );
      } else {
        let msg = t('CreateDirForm.message003', { value0: data.path });
        if (data.branch && data.branch.created) {
          msg = t('CreateDirForm.message004', {
            value0: data.branch.branchName,
            value1: data.branch.fromBranch,
            value2: msg,
          });

          setCurrentBranch(data.branch.branchName);
        }
        setSuccess(msg);
        showToast({ tone: 'success', text: msg });
        refreshTree();

        try {
          await onCreated?.({
            developer,
            date,
            title,
            requirementId: `${date}-${title}`,
            branchName: createBranch ? generatedBranchName : null,
          });
        } catch {
          showToast({ tone: 'warning', text: t('create.selectionRefreshFailed') });
        } finally {
          onClose?.();
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  if (checking) {
    return h('div', { className: 'rh-op-panel', role: 'status' }, t('common.loading'));
  }
  if (!creation) {
    return h(
      'div',
      { className: 'rh-op-panel' },
      h('p', { role: 'alert' }, error),
      h(Button, { onClick: () => setCheckRevision((value) => value + 1) }, t('create.retry')),
    );
  }
  return h(
    'div',
    { className: 'rh-op-panel' + ' ' + css.pane },
    h(
      'section',
      { className: css.card, 'aria-label': t('create.gitStatus') },
      h(
        'div',
        { className: css.cardHeader },
        h(
          'div',
          { className: css.branchIdentity },
          h('h3', null, t('create.gitStatus')),
          h('code', null, currentBranch || t('create.noBranch')),
        ),
        h(
          'div',
          { className: css.gitActions },
          h(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              disabled: loading,
              onClick: () => setCheckRevision((value) => value + 1),
            },
            t('create.refreshStatus'),
          ),
          isMainBranch &&
            h(
              Button,
              {
                size: 'sm',
                disabled: loading || !creation.canUpdateMain,
                'aria-describedby': `${formId}-update-hint`,
                onClick: updateMain,
              },
              t(updatingMain ? 'create.updatingMain' : 'create.updateMain', {
                branch: currentBranch,
              }),
            ),
        ),
      ),
      isMainBranch &&
        h(
          'p',
          { id: `${formId}-update-hint`, className: css.hint, role: 'status' },
          mainUpdateHint,
        ),
    ),
    h(
      'section',
      { className: css.card, 'aria-labelledby': `${formId}-info` },
      h('h3', { id: `${formId}-info` }, t('create.requirementInfo')),
      h(
        'div',
        { className: css.fields },
        h(
          'div',
          { className: css.field },
          h('label', { htmlFor: `${formId}-developer` }, t('CreateDirForm.message006')),
          h(Input, {
            id: `${formId}-developer`,
            className: 'rh-form-input',
            type: 'text',
            placeholder: t('create.developerExample'),
            value: developer,
            disabled: loading,
            onChange: (event) => setDeveloper(event.target.value),
          }),
        ),
        h(
          'div',
          { className: css.field },
          h('label', { htmlFor: `${formId}-date` }, t('CreateDirForm.message007')),
          h(DatePicker, {
            id: `${formId}-date`,
            label: t('CreateDirForm.message007'),
            value: date,
            disabled: loading,
            onChange: (event) => setDate(event.target.value),
          }),
        ),
        h(
          'div',
          { className: `${css.field} ${css.titleField}` },
          h('label', { htmlFor: `${formId}-title` }, t('CreateDirForm.message008')),
          h(Input, {
            id: `${formId}-title`,
            className: 'rh-form-input',
            type: 'text',
            placeholder: t('CreateDirForm.message009'),
            value: title,
            disabled: loading,
            onChange: (event) => setTitle(event.target.value),
          }),
        ),
      ),
      h(
        'div',
        { className: css.branchOption },
        h(Checkbox, {
          checked: createBranch,
          disabled: loading,
          onChange: (checked) => setCreateBranch(checked),
          label: t('CreateDirForm.message010'),
        }),
      ),
    ),
    h(
      'section',
      { className: css.card, 'aria-labelledby': `${formId}-preview` },
      h('h3', { id: `${formId}-preview` }, t('create.preview')),
      h(
        'dl',
        { className: css.preview },
        h('dt', null, t('create.directoryLabel')),
        h(
          'dd',
          null,
          previewPath
            ? h('code', null, previewPath)
            : h('span', { className: css.placeholder }, t('create.previewEmpty')),
        ),
        h('dt', null, t(createBranch ? 'create.newBranchLabel' : 'create.currentBranchLabel')),
        h(
          'dd',
          null,
          h(
            'code',
            null,
            (createBranch ? generatedBranchName : currentBranch) || t('create.previewEmpty'),
          ),
        ),
      ),
    ),
    error && h('div', { className: css.error, role: 'alert' }, error),
    success && h('div', { className: css.success, role: 'status' }, success),
    h(
      'footer',
      { className: css.footer },
      h(Button, { onClick: onClose, disabled: loading }, t('common.cancel')),
      h(
        Button,
        { variant: 'primary', onClick: handleCreateClick, disabled: loading },
        t(loading && !updatingMain ? 'CreateDirForm.message015' : 'CreateDirForm.message016'),
      ),
    ),
    showConfirm &&
      h(
        ModalFrame,
        {
          className: 'rh-modal-overlay',
          onClick: () => setShowConfirm(false),
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-label': t('CreateDirForm.message018'),
        },
        h(
          'div',
          {
            className: 'rh-modal',
            onClick: (e) => e.stopPropagation(),
          },
          h('div', { className: 'rh-modal-title' }, t('CreateDirForm.message019')),
          h(
            'div',
            { className: css.spacing3 },
            h('div', null, t('CreateDirForm.message020')),
            h(
              'div',
              { className: css.spacing4 },
              h(
                'div',
                null,
                t('CreateDirForm.message021'),
                h('code', null, currentBranch || t('CreateDirForm.message022')),
                t('CreateDirForm.message023'),
                h('code', { className: css.content3 }, generatedBranchName),
              ),
              h('div', { className: css.spacing5 }, t('CreateDirForm.message024')),
              h(
                'div',
                { className: css.spacing5 },
                t('CreateDirForm.message025'),
                h('code', null, `${developer}/${date}-${title}`),
              ),
            ),
          ),
          h(
            'div',
            { className: 'rh-modal-actions' },
            h(
              Button,
              { className: 'rh-btn', onClick: () => setShowConfirm(false) },
              t('common.cancel'),
            ),
            h(
              Button,
              { className: 'rh-btn rh-btn-primary', onClick: doCreate },
              t('CreateDirForm.message026'),
            ),
          ),
        ),
      ),
  );
}

module.exports = { CreateDirForm, parseBranchName };
