'use strict';
const { Checkbox } = require('./shared/controls.js');
const { t } = require('../locale.js');
const css = require('./CreateDirForm.module.css').default;
const { cssValue } = require('./shared/presentation.js');
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
 * @param {Function} [props.onCreated] - Callback invoked after successful directory creation with requirement info
 * @returns {JSX.Element} A form with developer, date, title fields and branch creation options
 */
function CreateDirForm({
  workspaceId,
  docsDir,
  onClose,
  initialCreateBranch,
  onCreated,
  onExisting,
}) {
  const formId = React.useId();
  const [developer, setDeveloper] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
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
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `${ROUTE}/create-status?workspaceId=${encodeURIComponent(workspaceId)}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          throw new Error('CREATE_FAILED');
        }
        const data = await res.json();
        if (controller.signal.aborted) {
          return;
        }
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
            setDeveloper(parsed.developer);
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
  }, [workspaceId, checkRevision]);

  const updateMain = async () => {
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
    h('div', { className: 'rh-op-hint' }, t('CreateDirForm.message005')),
    creation.canUpdateMain &&
      h(
        'div',
        { className: css.mainActions },
        h(
          Button,
          { disabled: loading, onClick: updateMain },
          t(updatingMain ? 'create.updatingMain' : 'create.updateMain', {
            branch: creation.branch,
          }),
        ),
        h('small', null, t('create.updateMainHint', { branch: creation.branch })),
      ),

    h(
      'div',
      { className: css.spacing },

      h(
        'div',
        { className: css.size },
        h(
          'label',
          { htmlFor: `${formId}-developer`, className: 'rh-form-label' + ' ' + css.spacing2 },
          t('CreateDirForm.message006'),
        ),
        h(Input, {
          id: `${formId}-developer`,
          className: 'rh-form-input',
          type: 'text',
          placeholder: t('create.developerExample'),
          value: developer,
          onChange: (e) => setDeveloper(e.target.value),
        }),
      ),

      h(
        'div',
        { className: css.size },
        h(
          'label',
          { htmlFor: `${formId}-date`, className: 'rh-form-label' + ' ' + css.spacing2 },
          t('CreateDirForm.message007'),
        ),
        h(DatePicker, {
          id: `${formId}-date`,
          label: t('CreateDirForm.message007'),
          value: date,
          onChange: (e) => setDate(e.target.value),
        }),
      ),

      h(
        'div',
        { className: css.size2 },
        h(
          'label',
          { htmlFor: `${formId}-title`, className: 'rh-form-label' + ' ' + css.spacing2 },
          t('CreateDirForm.message008'),
        ),
        h(Input, {
          id: `${formId}-title`,
          className: 'rh-form-input',
          type: 'text',
          placeholder: t('CreateDirForm.message009'),
          value: title,
          onChange: (e) => setTitle(e.target.value),
        }),
      ),
    ),

    h(
      'div',
      {
        className: css.section,
      },
      h(
        'div',
        {
          className: css.row,
          style: { '--rh-margin-bottom-6': cssValue(currentBranch ? 6 : 0) },
        },
        h(Checkbox, {
          checked: createBranch,
          onChange: (checked) => setCreateBranch(checked),
          label: t('CreateDirForm.message010'),
        }),
      ),
      currentBranch &&
        h(
          'div',
          {
            className: css.mutedText,
          },
          t('CreateDirForm.message011'),
          h('code', { className: css.content }, currentBranch),
        ),
    ),

    (generatedBranchName || previewPath) &&
      h(
        'div',
        {
          className: css.section2,
        },

        generatedBranchName &&
          h(
            'div',
            {
              className: css.row2,
              style: {
                '--rh-color-3': cssValue(
                  createBranch
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-label-secondary)',
                ),
                '--rh-margin-bottom-4': cssValue(previewPath ? 6 : 0),
              },
            },

            h(
              'span',
              null,
              createBranch ? t('CreateDirForm.message012') : t('CreateDirForm.message013'),
            ),
            h(
              'code',
              {
                title: generatedBranchName,
                className: css.pane2,
                style: {
                  '--rh-color-1': cssValue(
                    createBranch
                      ? 'var(--dsw-alias-state-success-primary)'
                      : 'var(--dsw-alias-label-primary)',
                  ),
                },
              },
              generatedBranchName,
            ),
          ),

        previewPath &&
          h(
            'div',
            {
              title: previewPath,
              className: css.row3,
            },

            h('span', null, t('CreateDirForm.message014')),
            h(
              'code',
              {
                className: css.pane3,
              },
              previewPath,
            ),
          ),
      ),

    error &&
      h(
        'div',
        {
          className: css.row4,
        },
        error,
      ),
    success &&
      h(
        'div',
        {
          className: css.section3,
        },
        success,
      ),

    h(
      'div',
      { className: css.row5 },
      h(
        Button,
        {
          className: 'rh-btn rh-btn-primary' + ' ' + css.content2,
          onClick: handleCreateClick,
          disabled: loading,
        },
        loading ? t('CreateDirForm.message015') : t('CreateDirForm.message016'),
      ),
      h(Button, { className: 'rh-btn' + ' ' + css.content2, onClick: onClose }, t('common.cancel')),
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

module.exports = { CreateDirForm };
