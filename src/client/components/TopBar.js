'use strict';
const { showToast } = require('./shared/ToastContainer.js');
const { t } = require('../locale.js');
const { Button } = require('./shared/Button.js');

const React = require('react');
const h = React.createElement;
const { useState } = React;
const { ROUTE } = require('../constants.js');
const { InputModal } = require('./InputModal.js');
const { createIconComponents } = require('../icons.js');

const { IconFolderExternal, IconTarget } = createIconComponents(h);

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
        showToast({ tone: 'error', text: data.error || t("TopBar.message001") });
      }
    } catch (e) {
      showToast({ tone: 'error', text: t("TopBar.message002") + e.message });
    }
  };

  return h('div', { className: 'rh-topbar' },
    h('div', { className: 'rh-topbar-locate' },
      // 定位到当前会话需求目录按钮
      h('button', {
        className: 'rh-rail-btn',
        type: 'button',
        onClick: onLocateSessionReq,
        title: t("TopBar.message003"),
        'aria-label': t("TopBar.message004"),
      },
        h('span', null, h(IconTarget, { size: 18 })),
        h('span', { className: 'rh-rail-label' }, t("TopBar.message005"))
      )
    ),
    h('div', { className: 'rh-topbar-left' },
      // 工作区
      h('span', { className: 'rh-topbar-label' }, t("TopBar.message006")),
      h(Button, {
          type: 'button',
          className: `rh-btn rh-btn-sm rh-topbar-value${currentWorkspace ? ' selected' : ' unselected'}`,
          onClick: onChangeWorkspace,
          title: t("TopBar.message007"),
          'aria-label': t("TopBar.message009", { value0: currentWorkspace?.title || currentWorkspace?.id || t("TopBar.message008") }),
        }, currentWorkspace?.title || currentWorkspace?.id || t("TopBar.message010")),

      // 项目路径
      h('span', { className: 'rh-topbar-label' }, t("TopBar.message011")),
      h(Button, {
          type: 'button',
          className: 'rh-btn rh-btn-sm rh-topbar-value selected',
          onClick: () => setShowPathModal(true),
          title: t("TopBar.message012"),
          'aria-label': t("TopBar.message013", { value0: docsDir }),
        }, docsDir),

      // 需求目录
      h('span', { className: 'rh-topbar-label' }, t("TopBar.message014")),
      h(Button, {
          type: 'button',
          className: `rh-btn rh-btn-sm rh-topbar-value${currentReq ? ' selected' : ' unselected'}`,
          onClick: onChangeReq,
          title: t("TopBar.message015"),
        }, currentReq ? `${currentReq.date?.slice(5)} ${currentReq.title}` : t("TopBar.message010")),

      // 在文件资源管理器中打开按钮
      currentReq && h(Button, {
        className: 'rh-btn rh-btn-sm rh-btn-icon rh-open-directory',
        onClick: handleOpenInExplorer,
        title: t("TopBar.message016"),
        'aria-label': t("TopBar.message017"),
      }, h(IconFolderExternal, { size: 16 }))
    ),

    // 项目路径输入弹框
    showPathModal && h(InputModal, {
      title: t("TopBar.message018"),
      value: docsDir,
      placeholder: t("TopBar.message019"),
      onConfirm: handlePathConfirm,
      onCancel: () => setShowPathModal(false),
    })
  );
}

module.exports = { TopBar };
