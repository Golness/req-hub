'use strict';
// Semantic aliases use a private copy of the DSH artwork; see DSH-UI-NOTICE.md.
const host = require('./icons-artwork.cjs');
const ICON_COMPONENTS = {
  loading: 'IconLoadingOutlineRegular', reqHub: 'IconCordisPluginOutlineRegular', plus: 'IconPlusOutlineRegular', sync: 'IconRefreshOutlineRegular',
  eye: 'IconBrowseOutlineRegular', books: 'IconDatabaseOutlineRegular', search: 'IconSearchOutlineRegular',
  trace: 'IconClockOutlineRegular', edit: 'IconEditOutlineRegular', log: 'IconFlatListOutlineRegular',
  settings: 'IconSettingsOutlineRegular', folder: 'IconFolderCloseRegular', folderOpen: 'IconFolderOpenRegular',
  folderExternal: 'IconRightUpOutlineRegular', file: 'IconDeliverDocRegular', clipboard: 'IconChecklistOutlineRegular',
  design: 'IconPlanOutlineRegular', review: 'IconCompareSplitOutlineRegular', api: 'IconApiOutlineRegular',
  test: 'IconInspectOutlineRegular', chevronRight: 'IconChevronRightOutlineRegular', chevronDown: 'IconChevronDownOutlineRegular',
  back: 'IconChevronLeftOutlineRegular', close: 'IconCloseOutlineRegular', check: 'IconCheckOutlineRegular',
  error: 'IconCloseCircleFillRegular', warning: 'IconWarningTriangleOutlineRegular', info: 'IconInfoOutlineRegular',
  hourglass: 'IconAlarmClockOutlineRegular', skip: 'IconTriangleRightFillRegular', cancel: 'IconStopFillRegular', target: 'IconGoalOutlineRegular',
};
const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 18, xl: 20 };
function createIconComponents(h) {
  return Object.fromEntries(Object.entries(ICON_COMPONENTS).map(([name, exported]) => [
    'Icon' + name[0].toUpperCase() + name.slice(1),
    function Icon({ size = 16, className = '', style, color, fill, stroke, strokeWidth, strokeLinecap, strokeLinejoin, ...rest }) {
      return h('span', { ...rest, 'data-icon': name, className: `rh-icon ${className}`.trim(), 'aria-hidden': true,
        style: { ...style, '--rh-icon-color': color || 'currentColor' } }, h(host[exported], { size }));
    },
  ]));
}
module.exports = { ICON_COMPONENTS, ICON_SIZE, createIconComponents };
