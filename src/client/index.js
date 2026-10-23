/**
 * ReqHub - Requirements Hub
 * DSH (Developer Service Hub) plugin entry file.
 *
 * Architecture: Multi-file, CommonJS format.
 * - CSS handled by Rolldown plugin (styles/ directory)
 * - Components loaded on demand (components/ directory)
 * - Module wrapping handled automatically by tsdown banner/footer
 *
 * @module req-hub/client
 */

'use strict';

const React = require('react');
const h = React.createElement;

// CSS（由 Rolldown 插件处理，构建时注入）
require('./styles/tokens.css');
require('./styles/base.css');
require('./styles/layout.css');
require('./styles/components.css');
require('./styles/markdown.css');
require('./styles/animations.css');

// 共享模块
const { TAB_ID, TAB_KIND } = require('./constants.js');
const { createIconComponents } = require('./icons.js');

// 同步加载的组件（入口需要）
const { TabBodyWrapper } = require('./components/TabBodyWrapper.js');
const { TabTitle } = require('./components/TabTitle.js');
const { TriggerButton } = require('./components/TriggerButton.js');

// 创建图标组件
const icons = createIconComponents(h);

/**
 * Cordis Plugin Descriptor for ReqHub.
 *
 * @constant {Object} pluginDescriptor
 * @property {string[]} inject - List of Cordis DI services required by this plugin.
 * @property {Function} apply - Plugin activation function that registers tabs, slots, and sidebar actions.
 * @property {Function} apply.dispose - Cleanup function returned by apply that disposes all registrations.
 */
module.exports = {
  inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'layout'],
  apply(ctx) {
    const disposers = [];

    // Store context globally for components to access
    window.__DSH_CTX__ = ctx;

    // 注册右侧边栏 Tab
    disposers.push(ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      multiple: false,
      priority: 'user',
      title: () => 'Req Hub',
    }));

    // 注册 Tab 内容
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
    }, TabBodyWrapper)));

    // 注册 Tab 标题
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: TAB_ID,
    }, TabTitle)));

    // 注册侧边栏触发按钮
    disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'req-hub-trigger',
      order: 10,
      label: 'Req Hub',
    }, ({ wide }) => {
      const handleClick = () => {
        ctx.layout.openRightbar(true, false);
        ctx.sidebarRight.openTab(TAB_KIND);
      };
      return h(TriggerButton, { onClick: handleClick, wide });
    })));

    // 清理函数
    return () => {
      for (const d of disposers) d();
      delete window.__DSH_CTX__;
    };
  },
};
