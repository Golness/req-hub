'use strict';
// Functional glyphs use the private DSH snapshot; the ReqHub brand is original artwork.
const host = require('./icons-artwork.cjs');
const { BODY_PATH, BRIDGE_PATH } = require('../shared/brand.cjs');
const ICON_COMPONENTS = {
  loading: 'IconLoadingOutlineRegular',
  reqHub: 'ReqHubMonogram',
  plus: 'IconPlusOutlineRegular',
  sync: 'IconRefreshOutlineRegular',
  eye: 'IconBrowseOutlineRegular',
  books: 'IconDatabaseOutlineRegular',
  search: 'IconSearchOutlineRegular',
  trace: 'IconClockOutlineRegular',
  edit: 'IconEditOutlineRegular',
  log: 'IconFlatListOutlineRegular',
  reports: 'IconWorkspaceTreeOutlineRegular',
  settings: 'IconSettingsOutlineRegular',
  folder: 'IconFolderCloseRegular',
  folderOpen: 'IconFolderOpenRegular',
  folderExternal: 'IconRightUpOutlineRegular',
  file: 'IconDeliverDocRegular',
  clipboard: 'IconChecklistOutlineRegular',
  design: 'IconPlanOutlineRegular',
  review: 'IconCompareSplitOutlineRegular',
  api: 'IconApiOutlineRegular',
  test: 'IconInspectOutlineRegular',
  chevronRight: 'IconChevronRightOutlineRegular',
  chevronDown: 'IconChevronDownOutlineRegular',
  back: 'IconChevronLeftOutlineRegular',
  close: 'IconCloseOutlineRegular',
  check: 'IconCheckOutlineRegular',
  error: 'IconCloseCircleFillRegular',
  warning: 'IconWarningTriangleOutlineRegular',
  info: 'IconInfoOutlineRegular',
  hourglass: 'IconAlarmClockOutlineRegular',
  skip: 'IconTriangleRightFillRegular',
  cancel: 'IconStopFillRegular',
  target: 'IconGoalOutlineRegular',
};
const ICON_SIZE = { xs: 12, sm: 14, md: 16, lg: 18, xl: 20 };
/**
 * Bind the private icon snapshot to the supplied React element factory.
 * @param h - The Host React createElement function.
 * @returns Plugin-owned icon components.
 */
function createIconComponents(h) {
  const ReqHubMonogram = ({ size }) =>
    h(
      'svg',
      { width: size, height: size, viewBox: '0 0 64 64', fill: 'none', 'aria-hidden': true },
      h('path', {
        d: BODY_PATH,
        fillRule: 'evenodd',
        fill: 'var(--dsw-alias-label-primary, currentColor)',
      }),
      h('path', { d: BRIDGE_PATH, fill: 'var(--dsw-alias-state-business-primary, currentColor)' }),
    );
  return Object.fromEntries(
    Object.entries(ICON_COMPONENTS).map(([name, exported]) => [
      'Icon' + name[0].toUpperCase() + name.slice(1),
      function Icon({
        size = 16,
        className = '',
        style,
        color,
        fill,
        stroke,
        strokeWidth,
        strokeLinecap,
        strokeLinejoin,
        ...rest
      }) {
        return h(
          'span',
          {
            ...rest,
            'data-icon': name,
            className: `rh-icon ${className}`.trim(),
            'aria-hidden': true,
            style: { ...style, '--rh-icon-color': color || 'currentColor' },
          },
          h(exported === 'ReqHubMonogram' ? ReqHubMonogram : host[exported], { size }),
        );
      },
    ]),
  );
}
module.exports = { ICON_COMPONENTS, ICON_SIZE, createIconComponents };
