'use strict';

const React = require('react');
const h = React.createElement;
const { useState, useEffect } = React;

const { ROUTE } = require('../constants.js');
const { DocsViewerContext } = require('../context.js');
const { createIconComponents } = require('../icons.js');

const { IconFolder, IconError, IconMerge } = createIconComponents(h);

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
    ? `feature/${developer}/${date}-${title.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9一-龥\-_]/g, '').toLowerCase()}`
    : '';

  const previewPath = developer && date && title
    ? `${docsDir}/${developer}/${date}-${title}/`
    : null;

  // 点击创建按钮 → 如果勾选了新建分支，先弹二次确认
  const handleCreateClick = () => {
    if (!developer || !date || !title) {
      setError('请填写所有字段');
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
        setError(data.error || '创建失败');
      } else {
        let msg = `目录创建成功: ${data.path}`;
        if (data.branch && data.branch.created) {
          msg = `分支 ${data.branch.branchName} 创建成功（从 ${data.branch.fromBranch}）\n${msg}`;
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

  return h('div', { className: 'rh-op-panel', style: { maxWidth: '100%', overflow: 'hidden' } },
    h('div', { className: 'rh-op-hint' }, '基于 Git 分支命名规范创建需求文档目录'),

    // 表单网格：开发者 + 日期 并排，需求简述 跨两列
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 } },
      // 开发者
      h('div', { style: { minWidth: 0 } },
        h('label', { className: 'rh-form-label', style: { display: 'block', marginBottom: 4 } }, '开发者'),
        h('input', {
          className: 'rh-form-input',
          type: 'text',
          placeholder: 'zhangsan',
          value: developer,
          onChange: e => setDeveloper(e.target.value),
        })
      ),
      // 日期
      h('div', { style: { minWidth: 0 } },
        h('label', { className: 'rh-form-label', style: { display: 'block', marginBottom: 4 } }, '日期'),
        h('input', {
          className: 'rh-form-input',
          type: 'date',
          value: date,
          onChange: e => setDate(e.target.value),
        })
      ),
      // 需求简述（跨两列）
      h('div', { style: { gridColumn: '1 / -1', minWidth: 0 } },
        h('label', { className: 'rh-form-label', style: { display: 'block', marginBottom: 4 } }, '需求简述'),
        h('input', {
          className: 'rh-form-input',
          type: 'text',
          placeholder: '新增报表导出功能',
          value: title,
          onChange: e => setTitle(e.target.value),
        })
      )
    ),

    // 新建分支开关 + 当前分支信息
    h('div', {
      style: {
        padding: '10px 12px',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 6,
        marginBottom: 12,
      }
    },
      h('label', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          fontSize: 'var(--rh-font-size)',
          color: 'var(--dsw-alias-label-primary)',
          marginBottom: currentBranch ? 6 : 0,
        }
      },
        h('input', {
          type: 'checkbox',
          checked: createBranch,
          onChange: e => setCreateBranch(e.target.checked),
          style: { width: 16, height: 16, cursor: 'pointer' },
        }),
        h('span', { style: { fontWeight: 500 } }, '同时新建 Git 分支')
      ),
      currentBranch && h('div', {
        style: {
          fontSize: 'var(--rh-font-size)',
          color: 'var(--dsw-alias-label-secondary)',
          paddingLeft: 24,
        }
      }, '当前分支: ', h('code', { style: { color: 'var(--rh-accent)' } }, currentBranch))
    ),

    // 预览信息卡片
    (generatedBranchName || previewPath) && h('div', {
      style: {
        padding: '10px 12px',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 6,
        marginBottom: 12,
        fontSize: 'var(--rh-font-size)',
        lineHeight: 1.6,
      }
    },
      // 分支预览
      generatedBranchName && h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: createBranch ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
          marginBottom: previewPath ? 6 : 0,
        }
      },
        h('span', { style: { display: 'flex', alignItems: 'center' } },
          h(IconMerge, { size: 12, style: { marginRight: 4 } })
        ),
        h('span', null, createBranch ? '将创建分支:' : '分支名:'),
        h('code', {
          style: {
            flex: 1,
            color: createBranch ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-1)',
            padding: '2px 6px',
            borderRadius: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }
        }, generatedBranchName)
      ),
      // 目录预览
      previewPath && h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--dsw-alias-label-secondary)',
        }
      },
        h('span', { style: { display: 'flex', alignItems: 'center' } },
          h(IconFolder, { size: 12, style: { marginRight: 4 } })
        ),
        h('span', null, '将创建目录:'),
        h('code', {
          style: {
            flex: 1,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-1)',
            padding: '2px 6px',
            borderRadius: 3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }
        }, previewPath)
      )
    ),

    // 错误/成功提示
    error && h('div', {
      style: {
        padding: '8px 12px',
        background: 'var(--dsw-alias-state-error-bg)',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: 6,
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 'var(--rh-font-size)',
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }
    }, h(IconError, { size: 14 }), error),
    success && h('div', {
      style: {
        padding: '8px 12px',
        background: 'var(--dsw-alias-state-success-bg)',
        border: '1px solid var(--dsw-alias-state-success-primary)',
        borderRadius: 6,
        color: 'var(--dsw-alias-state-success-primary)',
        fontSize: 'var(--rh-font-size)',
        marginBottom: 12,
        whiteSpace: 'pre-line',
      }
    }, success),

    // 操作按钮
    h('div', { style: { display: 'flex', gap: 12 } },
      h('button', { className: 'rh-btn rh-btn-primary', onClick: handleCreateClick, disabled: loading, style: { flex: 1 } },
        loading ? '创建中...' : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h(IconFolder, { size: 14 }), ' 创建')),
      h('button', { className: 'rh-btn', onClick: onClose, style: { flex: 1 } }, '取消')
    ),

    // 二次确认弹窗
    showConfirm && h('div', {
      className: 'rh-modal-overlay',
      onClick: () => setShowConfirm(false),
      role: 'alertdialog',
      'aria-modal': 'true',
      'aria-label': '确认新建分支',
    },
      h('div', {
        className: 'rh-modal',
        onClick: e => e.stopPropagation(),
      },
        h('div', { className: 'rh-modal-title' }, '确认新建 Git 分支'),
        h('div', { style: { fontSize: 'var(--rh-font-size)', color: 'var(--dsw-alias-label-primary)', lineHeight: 1.6, marginBottom: 16 } },
          h('div', null, '即将执行以下操作：'),
          h('div', { style: { marginTop: 8, paddingLeft: 12 } },
            h('div', null, '1. 从 ', h('code', null, currentBranch || '当前分支'), ' 创建新分支 ', h('code', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, generatedBranchName)),
            h('div', { style: { marginTop: 4 } }, '2. 切换到新分支（未提交的修改会自动带过去）'),
            h('div', { style: { marginTop: 4 } }, '3. 创建需求目录 ', h('code', null, `${developer}/${date}-${title}`))
          )
        ),
        h('div', { className: 'rh-modal-actions' },
          h('button', { className: 'rh-btn', onClick: () => setShowConfirm(false) }, '取消'),
          h('button', { className: 'rh-btn rh-btn-primary', onClick: doCreate }, '确认创建')
        )
      )
    )
  );
}

module.exports = { CreateDirForm };
