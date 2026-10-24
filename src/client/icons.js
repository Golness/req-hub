/**
 * SVG Icon Components for ReqHub.
 * Uses inline SVG instead of emoji for better accessibility and style control.
 *
 * Note: This file exports icon path data. The actual React components are created
 * inside the DSH ModuleLoader factory to ensure React's require happens within
 * the factory context.
 *
 * @module req-hub/client/icons
 */

'use strict';

/**
 * Predefined icon sizes in pixels.
 * @constant {Object.<string, number>}
 * @property {number} xs - Extra small: 12px
 * @property {number} sm - Small: 14px
 * @property {number} md - Medium: 16px (default)
 * @property {number} lg - Large: 18px
 * @property {number} xl - Extra large: 20px
 */
const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
};

/**
 * SVG path data for each icon (maps to the SVG path `d` attribute).
 * All icons use a 24x24 viewBox.
 * @constant {Object.<string, string>}
 */
const ICON_PATHS = {
  "reqHub": "M3 3h11v18H3z M6 7h5 M6 11h5 M6 15h3 M14 12h4 M18 5v14 M18 5h3 M18 19h3",
  "plus": "M12 4v16 M4 12h16",
  "sync": "M20 7a8 8 0 0 0-14-2L3 8 M3 3v5h5 M4 17a8 8 0 0 0 14 2l3-3 M21 21v-5h-5",
  "eye": "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  "books": "M3 4h4v16H3z M10 4h4v16h-4z M16 5l4-1 3 15-4 1z M3 8h4 M10 8h4",
  "search": "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M14.5 14.5 21 21",
  "trace": "M3 5v5h5 M3 10a9 9 0 1 1 2 8 M12 7v5l4 2",
  "edit": "M4 16 16 4l4 4L8 20H4z M13 7l4 4",
  "log": "M3 4h18v16H3z M6 8l3 3-3 3 M12 15h5",
  "settings": "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  "folder": "M3 6h7l2 2h9v12H3z",
  "folderOpen": "M3 8V5h7l2 3h8v3 M3 11h19l-3 9H3z",
  "folderExternal": "M3 6h7l2 2h2 M3 6v14h18v-7 M16 3h6v6 M22 3l-9 9",
  "file": "M5 3h9l5 5v13H5z M14 3v6h5",
  "clipboard": "M8 5H5v16h14V5h-3 M8 3h8v4H8z M8 12h1 M12 12h4 M8 16h1 M12 16h4",
  "design": "M3 21 21 3v18z M10 17l7-7v7z M9 15l2 2 M13 11l2 2",
  "review": "M2 4h8v16H2z M14 4h8v16h-8z M4 10h4 M16 12l2 2 3-4",
  "api": "M7 4H5v6l-3 2 3 2v6h2 M17 4h2v6l3 2-3 2v6h-2 M10 9l4 6 M14 9l-4 6",
  "test": "M9 3h6 M10 3v6L4 19c-.6 1 .1 2 1.3 2h13.4c1.2 0 1.9-1 1.3-2L14 9V3 M8 15h8",
  "chevronRight": "M9 5l7 7-7 7",
  "chevronDown": "M5 9l7 7 7-7",
  "back": "M20 12H4 M10 6l-6 6 6 6",
  "close": "M6 6l12 12 M18 6 6 18",
  "check": "M4 12l5 5L20 6",
  "error": "M8 2h8l6 6v8l-6 6H8l-6-6V8z M8 8l8 8 M16 8l-8 8",
  "warning": "M12 3 2 21h20z M12 9v5 M12 17v1",
  "info": "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M12 11v6 M12 7v1",
  "hourglass": "M6 3h12 M6 21h12 M7 3v4l5 5-5 5v4 M17 3v4l-5 5 5 5v4",
  "skip": "M4 6l10 6-10 6z M19 5v14",
  "cancel": "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M5 19 19 5",
  "target": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 1v4 M12 19v4 M1 12h4 M19 12h4"
};

/**
 * Factory function that creates React icon components from SVG path data.
 * Must be called inside the DSH ModuleLoader factory with a valid createElement function.
 *
 * @param {Function} createElement - React.createElement function for creating elements.
 * @returns {Object.<string, React.FC>} An object mapping icon names (e.g., "IconFolder") to React components.
 */
function createIconComponents(createElement) {
  const components = {};

  for (const [name, path] of Object.entries(ICON_PATHS)) {
    const capitalizedName = name.charAt(0).toUpperCase() + name.slice(1);
    /**
     * SVG Icon component.
     * @component
     * @param {Object} props - Component props.
     * @param {number} [props.size=ICON_SIZE.md] - Icon size in pixels.
     * @param {string} [props.className=''] - Additional CSS class names.
     * @param {React.CSSProperties} [props.style={}] - Inline styles to apply.
     * @param {...*} [props...rest] - Additional props passed to the SVG element.
     * @returns {React.ReactElement} An SVG icon element.
     */
    components[`Icon${capitalizedName}`] = function Icon({ size = ICON_SIZE.md, className = '', style = {}, ...props }) {
      return createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        focusable: 'false',
        'data-icon': name,
        className: `rh-icon ${className}`.trim(),
        style: { display: 'inline-block', verticalAlign: 'middle', ...style },
        'aria-hidden': 'true',
        ...props,
      }, createElement('path', { d: path }));
    };
  }

  return components;
}

module.exports = {
  ICON_SIZE,
  ICON_PATHS,
  createIconComponents,
};
