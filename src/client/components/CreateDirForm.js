'use strict';
const { Checkbox } = require('./shared/controls.js');
const { t } = require('../locale.js');
const css = require('./CreateDirForm.module.css').default;
const { cssValue } = require('./shared/presentation.js');
const { Input } = require('./shared/Input.js');
const { Button } = require('./shared/Button.js');
const { ModalFrame } = require('./shared/ModalFrame.js');

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;

const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');

// 解析分支名，返回 { developer, date, title, requirementId } 或 null
// 与服务端 src/server/utils.js 的 parseBranchName 保持一致
// 支持格式：
// 1. feature/{developer}/{YYYY-MM-DD}-{title}  (新格式)
// 2. feature/{developer}-{YYYY-MM-DD}-{title}  (旧格式)
// 3. {YYYY-MM-DD}-{title}  (无开发者前缀)
function parseBranchName(branch) {
  if (!branch) return null;

  // 格式 1 & 2: feature/{developer}[/-]{YYYY-MM-DD}-{title}
  const match1 = branch.match(/^(?:feature\/)?([^/-]+)[/-](\d{4}-\d{2}-\d{2})-(.+)$/);
  if (match1) {
    const [, developer, date, title] = match1;
    return { developer, date, title, requirementId: `${date}-${title}` };
  }

  // 格式 3: {YYYY-MM-DD}-{title}  (无开发者前缀)
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
 * a new Git branch. Covers features 4.2, 4.11, 4.12, 4.13.
 * @param {Object} props - Component props
 * @param {string} props.workspaceId - The unique identifier of the workspace
 * @param {string} props.docsDir - The path to the documents directory
 * @param {Function} props.onClose - Callback invoked when the form is closed
 * @param {boolean} [props.initialCreateBranch=false] - Whether to initially check the "create branch" option
 * @param {Function} [props.onCreated] - Callback invoked after successful directory creation with requirement info
 * @returns {JSX.Element} A form with developer, date, title fields and branch creation options
 */
function CreateDirForm({ workspaceId, docsDir, onClose, initialCreateBranch, onCreated }) {
  const [developer, setDeveloper] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const { refreshTree } = React.useContext(DocsViewerContext);

  // 新建分支相关状态
  const [createBranch, setCreateBranch] = useState(!!initialCreateBranch);
  const [currentBranch, setCurrentBranch] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  // Fetch current git branch and auto-fill form
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${ROUTE}/git-branch?workspaceId=${encodeURIComponent(workspaceId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.branch) return;

        setCurrentBranch(data.branch);

        // 使用统一的分支名解析函数
        const parsed = parseBranchName(data.branch);
        if (parsed) {
          if (parsed.developer) setDeveloper(parsed.developer);
          setDate(parsed.date);
          setTitle(parsed.title);
        }
      } catch { /* ignore */ }
    })();
  }, [workspaceId]);

  // 根据表单字段自动生成分支名（只读，不允许用户修改）
  const generatedBranchName = (developer && date && title)
    ? `feature/${developer}/${date}-${title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\u4e00-\u9fa5\-_]/g, '').toLowerCase()}`
    : '';

  const previewPath = developer && date && title
    ? `${docsDir}/${developer}/${date}-${title}/`
    : null;

  // 点击创建按钮 → 如果勾选了新建分支，先弹二次确认
  const handleCreateClick = () => {
    if (!developer || !date || !title) {
      setError(t("CreateDirForm.message001"));
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
        setError(data.error || t("CreateDirForm.message002"));
      } else {
        let msg = t("CreateDirForm.message003", { value0: data.path });
        if (data.branch && data.branch.created) {
          msg = t("CreateDirForm.message004", { value0: data.branch.branchName, value1: data.branch.fromBranch, value2: msg });
          // 更新当前分支显示
          setCurrentBranch(data.branch.branchName);
        }
        setSuccess(msg);
        refreshTree();
        // 通知父组件创建成功，传递新创建的需求信息
        if (onCreated) {
          onCreated({ developer, date, title, requirementId: `${date}-${title}`, branchName: createBranch ? generatedBranchName : null });
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return h('div', { className: ('rh-op-panel') + ' ' + css.pane },
    h('div', { className: 'rh-op-hint' }, t("CreateDirForm.message005")),

    // 表单网格：开发者 + 日期 并排，需求简述 跨两列
    h('div', { className: css.spacing },
      // 开发者
      h('div', { className: css.size },
        h('label', { className: ('rh-form-label') + ' ' + css.spacing2 }, t("CreateDirForm.message006")),
        h(Input, {
          className: 'rh-form-input',
          type: 'text',
          placeholder: t("create.developerExample"),
          value: developer,
          onChange: e => setDeveloper(e.target.value),
        })
      ),
      // 日期
      h('div', { className: css.size },
        h('label', { className: ('rh-form-label') + ' ' + css.spacing2 }, t("CreateDirForm.message007")),
        h('input', {
          className: 'rh-form-input',
          type: 'date',
          value: date,
          onChange: e => setDate(e.target.value),
        })
      ),
      // 需求简述（跨两列）
      h('div', { className: css.size2 },
        h('label', { className: ('rh-form-label') + ' ' + css.spacing2 }, t("CreateDirForm.message008")),
        h(Input, {
          className: 'rh-form-input',
          type: 'text',
          placeholder: t("CreateDirForm.message009"),
          value: title,
          onChange: e => setTitle(e.target.value),
        })
      )
    ),

    // 新建分支开关 + 当前分支信息
    h('div', {
      className: css.section
    },
      h('div', {
        className: css.row, style: { "--rh-margin-bottom-6": cssValue(currentBranch ? 6 : 0) }
      }, h(Checkbox, { checked: createBranch, onChange: checked => setCreateBranch(checked), label: t("CreateDirForm.message010") })),
      currentBranch && h('div', {
        className: css.mutedText
      }, t("CreateDirForm.message011"), h('code', { className: css.content }, currentBranch))
    ),

    // 预览信息卡片
    (generatedBranchName || previewPath) && h('div', {
      className: css.section2
    },
      // 分支预览
      generatedBranchName && h('div', {
        className: css.row2, style: { "--rh-color-3": cssValue(createBranch ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)'), "--rh-margin-bottom-4": cssValue(previewPath ? 6 : 0) }
      },

        h('span', null, createBranch ? t("CreateDirForm.message012") : t("CreateDirForm.message013")),
        h('code', {
          className: css.pane2, style: { "--rh-color-1": cssValue(createBranch ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-primary)') }
        }, generatedBranchName)
      ),
      // 目录预览
      previewPath && h('div', {
        className: css.row3
      },

        h('span', null, t("CreateDirForm.message014")),
        h('code', {
          className: css.pane3
        }, previewPath)
      )
    ),

    // 错误/成功提示
    error && h('div', {
      className: css.row4
    }, error),
    success && h('div', {
      className: css.section3
    }, success),

    // 操作按钮
    h('div', { className: css.row5 },
      h(Button, { className: ('rh-btn rh-btn-primary') + ' ' + css.content2, onClick: handleCreateClick, disabled: loading },
        loading ? t("CreateDirForm.message015") : t("CreateDirForm.message016")),
      h(Button, { className: ('rh-btn') + ' ' + css.content2, onClick: onClose }, t("common.cancel"))
    ),

    // 二次确认弹窗
    showConfirm && h(ModalFrame, {
      className: 'rh-modal-overlay',
      onClick: () => setShowConfirm(false),
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-label': t("CreateDirForm.message018"),
    },
      h('div', {
        className: 'rh-modal',
        onClick: e => e.stopPropagation(),
      },
        h('div', { className: 'rh-modal-title' }, t("CreateDirForm.message019")),
        h('div', { className: css.spacing3 },
          h('div', null, t("CreateDirForm.message020")),
          h('div', { className: css.spacing4 },
            h('div', null, t("CreateDirForm.message021"), h('code', null, currentBranch || t("CreateDirForm.message022")), t("CreateDirForm.message023"), h('code', { className: css.content3 }, generatedBranchName)),
            h('div', { className: css.spacing5 }, t("CreateDirForm.message024")),
            h('div', { className: css.spacing5 }, t("CreateDirForm.message025"), h('code', null, `${developer}/${date}-${title}`))
          )
        ),
        h('div', { className: 'rh-modal-actions' },
          h(Button, { className: 'rh-btn', onClick: () => setShowConfirm(false) }, t("common.cancel")),
          h(Button, { className: 'rh-btn rh-btn-primary', onClick: doCreate }, t("CreateDirForm.message026"))
        )
      )
    )
  );
}

module.exports = { CreateDirForm };
