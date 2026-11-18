'use strict';
const React = require('react');
const { EnhancementSettings } = require('./ContextAssist.js');
const { LarkCliSettings } = require('./LarkCliSettings.js');
const { SettingsTabs } = require('./shared/SettingsTabs.js');
const { t } = require('../locale.js');
const h = React.createElement;
/**
 * Keep dependency pages and drafts in the shared fixed-tab layout.
 * @param props - Workspace identity and optional shortcut destination.
 * @returns Dependency tabs sharing the owning settings action dock.
 */
function DependencySettings({ workspaceId, initialTab = 'gitnexus' }) {
  return h(SettingsTabs, {
    label: t('dependencies.tabs'),
    initialTab,
    tabs: [
      {
        id: 'gitnexus',
        label: t('dependencies.gitnexus'),
        render: () => h(EnhancementSettings, { key: workspaceId, workspaceId }),
      },
      {
        id: 'lark',
        label: t('dependencies.lark'),
        nested: true,
        render: () => h(LarkCliSettings, { workspaceId }),
      },
    ],
  });
}
module.exports = { DependencySettings };
