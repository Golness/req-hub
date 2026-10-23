'use strict';

const React = require('react');
const h = React.createElement;
const { useState } = React;
const { ROUTE } = require('../constants.js');
const { InputModal } = require('./InputModal.js');
const { createIconComponents } = require('../icons.js');

const { IconFolderOpen, IconTarget } = createIconComponents(h);

/**
 * @component
 * Top navigation bar displaying workspace selector, project docs path, and current
 * requirement. Provides actions to switch workspaces, modify the docs directory path,
 * select a requirement directory, locate the current session's requirement, and open
 * the requirement folder in the system file explorer.
 * @param {Object} props - Component props
 * @param {string} props.docsDir - Current project docs directory path
 * @param {Object|null} props.currentWorkspace - Currently active workspace object
 * @param {Object|null} props.currentReq - Currently selected requirement object
 * @param {Function} props.onEditDocsDir - Callback invoked after the docs directory is modified
 * @param {Function} props.onChangeWorkspace - Callback invoked to open the workspace selector
 * @param {Function} props.onChangeReq - Callback invoked to open the requirement directory selector
 * @param {Function} props.onLocateSessionReq - Callback invoked to auto-locate the current session's requirement
 * @returns {JSX.Element}
 */
function TopBar({ docsDir, currentWorkspace, currentReq, onEditDocsDir, onChangeWorkspace, onChangeReq, onLocateSessionReq }) {
  const [showPathModal, setShowPathModal] = useState(false);

  const handlePathConfirm = async (newDir) => {
    if (!newDir) return;
    try {
      const res = await fetch(`${ROUTE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docsDir: newDir }),
      });
      if (res.ok) {
        setShowPathModal(false);
        onEditDocsDir();
      }
    } catch { /* ignore */ }
  };

  const handleOpenInExplorer = async () => {
    if (!currentWorkspace || !currentReq) return;
    try {
      const res = await fetch(`${ROUTE}/open-in-explorer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: currentWorkspace.id,
          requirementId: currentReq.id
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || '打开失败');
      }
    } catch (e) {
      alert('打开失败: ' + e.message);
    }
  };

  return h('div', { className: 'rh-topbar' },
    h('div', { className: 'rh-topbar-locate' },
      // 定位到当前会话需求目录按钮
      h('button', {
        className: 'rh-rail-btn',
        type: 'button',
        onClick: onLocateSessionReq,
        title: '自动定位到当前 DSH 会话对应的需求文档目录',
        'aria-label': '定位到当前会话需求',
      },
        h('span', null, h(IconTarget, { size: 18 })),
        h('span', { className: 'rh-rail-label' }, '定位')
      )
    ),
    h('div', { className: 'rh-topbar-left' },
      // 工作区
      h('span', { className: 'rh-topbar-label' }, '工作区:'),
      h('span', {
          className: `rh-topbar-value${currentWorkspace ? ' selected' : ' unselected'}`,
          onClick: onChangeWorkspace,
          title: '点击切换工作区',
          role: 'button',
          'aria-label': `工作区: ${currentWorkspace?.title || currentWorkspace?.id || '未选择'}`,
        }, currentWorkspace?.title || currentWorkspace?.id || '(未选择)'),

      // 项目路径
      h('span', { className: 'rh-topbar-label' }, '项目路径:'),
      h('span', {
          className: 'rh-topbar-value selected',
          onClick: () => setShowPathModal(true),
          title: '点击修改项目 docs 路径',
          role: 'button',
          'aria-label': `项目路径: ${docsDir}`,
        }, docsDir),

      // 需求目录
      h('span', { className: 'rh-topbar-label' }, '需求目录:'),
      h('span', {
          className: `rh-topbar-value${currentReq ? ' selected' : ' unselected'}`,
          onClick: onChangeReq,
          title: '点击选择需求目录',
        }, currentReq ? `${currentReq.date?.slice(5)} ${currentReq.title}` : '(未选择)'),

      // 在文件资源管理器中打开按钮
      currentReq && h('button', {
        className: 'rh-btn',
        onClick: handleOpenInExplorer,
        title: '在文件资源管理器中打开此需求目录',
        style: { marginLeft: 8, padding: '2px 8px', fontSize: 'var(--rh-font-size-sm)', display: 'flex', alignItems: 'center', gap: 4 }
      }, h(IconFolderOpen, { size: 14 }))
    ),

    // 项目路径输入弹框
    showPathModal && h(InputModal, {
      title: '修改项目路径',
      value: docsDir,
      placeholder: '请输入 docs 目录路径',
      onConfirm: handlePathConfirm,
      onCancel: () => setShowPathModal(false),
    })
  );
}

module.exports = { TopBar };
