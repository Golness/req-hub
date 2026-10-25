// Private DSH icon artwork snapshot (MIT). See DSH-UI-NOTICE.md.
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region ../deepseek-harness/packages/client/ui-primitives/src/icons/shared-artwork.tsx
/**
* Render shared code-bracket geometry for product and link icons.
* @param props - Size, optional CSS class, and inherited stroke width.
* @returns The decorative SVG artwork.
*/
const CodeBracketsArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.67398 4.25061L1.36094 7.86484C1.29085 7.9413 1.29085 8.05866 1.36094 8.13513L4.67398 11.7494",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M11.3262 4.25061L14.6392 7.86484C14.7093 7.9413 14.7093 8.05866 14.6392 8.13513L11.3262 11.7494",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M9.56222 3.62573L6.43774 12.3743",
			stroke: "currentColor"
		})
	]
});
/**
* Render shared document-browse geometry for product and reference icons.
* @param props - Size, optional CSS class, and inherited stroke width.
* @returns The decorative SVG artwork.
*/
const BrowseOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.9375 5.90295H11.0625",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.9375 9.02991H8.27841",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V13.2246C13.9996 14.0489 13.3036 14.6738 12.5 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5ZM3.5 2.32617C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H12.5C12.8004 13.6738 12.9996 13.4489 13 13.2246V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5Z",
			fill: "currentColor"
		})
	]
});
/**
* Render shared closed-folder geometry for product, reference, and link icons.
* @param props - Size, optional CSS class, and inherited stroke width.
* @returns The decorative SVG artwork.
*/
const FolderCloseArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M3.63501 7.66614H12.3647",
		stroke: "currentColor"
	})]
});
const IconSearchOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M10.2991 10.3933L14.7783 14.8725",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconSearchOutline artwork. */
const IconSearchOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconSearchOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconSettingsOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z",
		stroke: "currentColor",
		strokeMiterlimit: "10"
	})]
});
/** Regular one-pixel IconSettingsOutline artwork. */
const IconSettingsOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconSettingsOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconPlusOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M8 2V14",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M2 8H14",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconPlusOutline artwork. */
const IconPlusOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlusOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconCheckOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4",
		stroke: "currentColor"
	})
});
/** Regular one-pixel IconCheckOutline artwork. */
const IconCheckOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCheckOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconChevronDownOutlineArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6",
		stroke: "currentColor"
	})
});
/** Regular one-pixel IconChevronDownOutline artwork. */
const IconChevronDownOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconChevronDownOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconChevronLeftOutlineArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12",
		stroke: "currentColor"
	})
});
/** Regular one-pixel IconChevronLeftOutline artwork. */
const IconChevronLeftOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconChevronLeftOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconChevronRightOutlineArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4",
		stroke: "currentColor"
	})
});
/** Regular one-pixel IconChevronRightOutline artwork. */
const IconChevronRightOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconChevronRightOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconTriangleRightFillArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z",
		fill: "currentColor"
	})
});
/** Regular IconTriangleRightFill artwork; its fill-only geometry is weight-independent. */
const IconTriangleRightFillRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTriangleRightFillArtwork, {
	...props,
	strokeWidth: 1
});
const IconCloseOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M2.5 2.5L13.5 13.5",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M13.5 2.5L2.5 13.5",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconCloseOutline artwork. */
const IconCloseOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCloseOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconCloseCircleFillArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		fillRule: "evenodd",
		clipRule: "evenodd",
		d: "M15 8A7 7 0 1 1 1 8A7 7 0 1 1 15 8ZM6.409 10.652L5.348 9.591L6.939 8L5.348 6.409L6.409 5.348L8 6.939L9.591 5.348L10.652 6.409L9.061 8L10.652 9.591L9.591 10.652L8 9.061Z",
		fill: "currentColor"
	})
});
/** Regular IconCloseCircleFill artwork (cross knocked out of a filled disc); its fill-only geometry is weight-independent. */
const IconCloseCircleFillRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCloseCircleFillArtwork, {
	...props,
	strokeWidth: 1
});
const IconRefreshOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M14.4999 1.5V5.1H10.8999",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconRefreshOutline artwork. */
const IconRefreshOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRefreshOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconDeliverDocArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M6.15479 4.91687H9.84543",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M11.8798 9.55347V2.71525C11.8798 2.37416 11.564 2.09766 11.1744 2.09766H4.82577C4.43618 2.09766 4.12036 2.37416 4.12036 2.71525V9.55347",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M2.28735 13.8022V8.84792C2.28735 8.77514 2.36262 8.72673 2.42884 8.75693L13.2936 13.7112C13.3914 13.7558 13.3596 13.9022 13.2521 13.9022H2.38735C2.33213 13.9022 2.28735 13.8575 2.28735 13.8022Z",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M7.46929 10.979L13.5783 8.7416C13.6435 8.7177 13.7126 8.76601 13.7126 8.83551L13.7125 13.8022C13.7125 13.8574 13.6678 13.9022 13.6125 13.9022H7.99999",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M6.15479 7.2395H9.05644",
			stroke: "currentColor"
		})
	]
});
/** Regular one-pixel IconDeliverDoc artwork. */
const IconDeliverDocRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDeliverDocArtwork, {
	...props,
	strokeWidth: 1
});
const IconEditOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z",
		fill: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M7.7849 8.23878L13.888 2.13574",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconEditOutline artwork. */
const IconEditOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconEditOutlineArtwork, {
	...props,
	strokeWidth: 1
});
/** Regular one-pixel IconBrowseOutline artwork. */
const IconBrowseOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BrowseOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconRightUpOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M11.7256 2.77441C12.5538 2.77469 13.2256 3.44616 13.2256 4.27441V10.1416H12.2256V4.27441C12.2256 3.99844 12.0015 3.77469 11.7256 3.77441H5.7207V2.77441H11.7256Z",
		fill: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M2.77441 13.2255L12.3756 3.62427",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconRightUpOutline artwork. */
const IconRightUpOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRightUpOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconWarningTriangleOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	strokeLinecap: "round",
	strokeLinejoin: "round",
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M6.87 2.6a1.33 1.33 0 0 1 2.26 0l5.34 9.33A1.33 1.33 0 0 1 13.33 14H2.67a1.33 1.33 0 0 1-1.14-2.07Z",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M8 6v3m0 2.33h.01",
		stroke: "currentColor"
	})]
});
/** Regular rounded warning triangle with an exclamation mark. */
const IconWarningTriangleOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconWarningTriangleOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconStopFillArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M12.5 2.5H3.5C2.94772 2.5 2.5 2.94772 2.5 3.5V12.5C2.5 13.0523 2.94772 13.5 3.5 13.5H12.5C13.0523 13.5 13.5 13.0523 13.5 12.5V3.5C13.5 2.94772 13.0523 2.5 12.5 2.5Z",
		fill: "currentColor"
	})
});
/** Regular IconStopFill artwork; its fill-only geometry is weight-independent. */
const IconStopFillRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconStopFillArtwork, {
	...props,
	strokeWidth: 1
});
const IconLoadingOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M12.596 12.596C11.687 13.5049 10.5288 14.1239 9.26798 14.3747C8.00716 14.6255 6.70028 14.4968 5.51261 14.0048C4.32494 13.5129 3.30981 12.6798 2.59557 11.611C1.88134 10.5421 1.50008 9.2855 1.5 7.99998C1.50008 6.71446 1.88134 5.45783 2.59557 4.38898C3.30981 3.32013 4.32494 2.48707 5.51261 1.99513C6.70028 1.50319 8.00716 1.37447 9.26798 1.62524C10.5288 1.87602 11.687 2.49502 12.596 3.40398",
		stroke: "currentColor"
	})
});
/** Regular one-pixel IconLoadingOutline artwork. */
const IconLoadingOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconLoadingOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconCordisPluginOutlineArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M3.16143 6.59068L1.75205 8.00006L3.10619 9.35419L2.39908 10.0613L0.832948 8.49517C0.559581 8.2218 0.559582 7.77831 0.832948 7.50494L2.45432 5.88357L3.16143 6.59068ZM8.49511 15.1671C8.22176 15.4405 7.77826 15.4404 7.50489 15.1671L5.93461 13.5968L6.64172 12.8897L8 14.248L9.40938 12.8386L10.1165 13.5457L8.49511 15.1671ZM15.1671 7.50494C15.4403 7.7782 15.4401 8.22179 15.1671 8.49517L13.652 10.0102L12.9449 9.30309L14.248 8.00006L12.8897 6.64178L13.5968 5.93467L15.1671 7.50494ZM9.35414 3.10624L8 1.7521L6.69696 3.05514L5.98986 2.34803L7.50489 0.833003C7.77828 0.559981 8.22186 0.559752 8.49511 0.833003L10.0612 2.39913L9.35414 3.10624Z",
		fill: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
		cx: "8",
		cy: "8",
		r: "1.76221",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconCordisPluginOutline artwork. */
const IconCordisPluginOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCordisPluginOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconApiOutlineArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M3 4L7 8L3 12",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M9 12H13",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconApiOutline artwork. */
const IconApiOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconApiOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconFolderOpenArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z",
			fill: "currentColor",
			opacity: "0.16"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z",
			fill: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z",
			fill: "currentColor"
		})
	]
});
/** Regular IconFolderOpen artwork; its fill-only geometry is weight-independent. */
const IconFolderOpenRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconFolderOpenArtwork, {
	...props,
	strokeWidth: 1
});
/** Regular one-pixel IconFolderClose artwork. */
const IconFolderCloseRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FolderCloseArtwork, {
	...props,
	strokeWidth: 1
});
const IconDatabaseOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M2 3.80371V11.7848",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M14 3.80371V11.7848",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847",
			stroke: "currentColor"
		})
	]
});
/** Regular one-pixel IconDatabaseOutline artwork. */
const IconDatabaseOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconDatabaseOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconClockOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M8 4.31V8.46L11 10.08",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconClockOutline artwork. */
const IconClockOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconClockOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconChecklistOutlineArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M7.5 4.5H13.5",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M7.5 11.5H13.5",
			stroke: "currentColor"
		})
	]
});
/** Regular one-pixel IconChecklistOutline artwork. */
const IconChecklistOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconChecklistOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconListPenOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.9375 5.90295H11.0625",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.9375 9.02991H8.27841",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z",
			fill: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z",
			fill: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z",
			fill: "currentColor"
		})
	]
});
const IconGoalOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M11.5 8C11.5001 8.69227 11.2948 9.36901 10.9102 9.94463C10.5257 10.5202 9.97901 10.9689 9.33944 11.2338C8.69986 11.4987 7.99609 11.5681 7.31712 11.433C6.63816 11.2979 6.01449 10.9645 5.52501 10.475C5.03548 9.98552 4.70209 9.36185 4.56702 8.68289C4.43195 8.00392 4.50127 7.30015 4.76619 6.66057C5.03112 6.021 5.47976 5.47436 6.05538 5.08978C6.631 4.70519 7.30774 4.49995 8.00001 4.5",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M8.00024 7.99976L11.2 4.80005",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M12.4719 5.62245C12.4246 5.66972 12.3569 5.69025 12.2913 5.67715L10.7814 5.37555C10.7022 5.35972 10.6402 5.29781 10.6244 5.2186L10.3228 3.70866C10.3097 3.6431 10.3302 3.57533 10.3775 3.52806L12.1826 1.723C12.2863 1.61929 12.4627 1.65879 12.5122 1.79684L12.9271 2.95225C12.9472 3.00847 12.9915 3.05272 13.0477 3.07291L14.2031 3.48774C14.3412 3.5373 14.3807 3.71368 14.277 3.81739L12.4719 5.62245Z",
			stroke: "currentColor"
		})
	]
});
/** Regular one-pixel IconGoalOutline artwork. */
const IconGoalOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconGoalOutlineArtwork, {
	...props,
	strokeWidth: 1
});
/** Regular one-pixel IconInspectOutline artwork. */
const IconInspectOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodeBracketsArtwork, {
	...props,
	size: props.size ?? 12,
	strokeWidth: 1
});
const IconInfoOutlineArtwork = ({ size = 14, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 14 14",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z",
			fill: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z",
			fill: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z",
			fill: "currentColor"
		})
	]
});
/** Regular IconInfoOutline artwork; its fill-only geometry is weight-independent. */
const IconInfoOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconInfoOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconAlarmClockOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 17 17",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M4.09372 11.9895L3.11865 14.0387",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M12.1392 11.9895L13.1143 14.0387",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M8.11646 4.78442V8.03442L10.6165 9.53442",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M8.11646 13.4094C11.154 13.4094 13.6165 10.947 13.6165 7.90942C13.6165 4.87186 11.154 2.40942 8.11646 2.40942C5.07889 2.40942 2.61646 4.87186 2.61646 7.90942C2.61646 10.947 5.07889 13.4094 8.11646 13.4094Z",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M1.75952 4.74323C2.30657 3.65639 3.12646 2.73047 4.12926 2.05542",
			stroke: "currentColor"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M14.3345 4.74323C13.7874 3.65639 12.9675 2.73047 11.9647 2.05542",
			stroke: "currentColor"
		})
	]
});
/** Regular one-pixel IconAlarmClockOutline artwork. */
const IconAlarmClockOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconAlarmClockOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconCompareSplitOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	xmlns: "http://www.w3.org/2000/svg",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M6 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H6C6.55228 14.5 7 14.0523 7 13.5V2.5C7 1.94772 6.55228 1.5 6 1.5Z",
		stroke: "currentColor"
	}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
		d: "M13.5 1.5H10C9.44772 1.5 9 1.94772 9 2.5V13.5C9 14.0523 9.44772 14.5 10 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z",
		stroke: "currentColor"
	})]
});
/** Regular one-pixel IconCompareSplitOutline artwork. */
const IconCompareSplitOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCompareSplitOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconPlanOutlineArtwork = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconListPenOutlineArtwork, {
	...props,
	size: props.size ?? 14
});
/** Regular one-pixel IconPlanOutline artwork. */
const IconPlanOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlanOutlineArtwork, {
	...props,
	strokeWidth: 1
});
const IconFlatListOutlineArtwork = ({ size = 16, className, strokeWidth }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
	width: size,
	height: size,
	className,
	viewBox: "0 0 16 16",
	fill: "none",
	stroke: "currentColor",
	strokeLinecap: "round",
	"aria-hidden": "true",
	strokeWidth,
	children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 3.5h7.5M6 8h7.5M6 12.5h7.5" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.6 3.5h.01M2.6 8h.01M2.6 12.5h.01" })]
});
/** Regular one-pixel IconFlatListOutline artwork. */
const IconFlatListOutlineRegular = (props) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconFlatListOutlineArtwork, {
	...props,
	strokeWidth: 1
});
//#endregion
exports.IconAlarmClockOutlineRegular = IconAlarmClockOutlineRegular;
exports.IconApiOutlineRegular = IconApiOutlineRegular;
exports.IconBrowseOutlineRegular = IconBrowseOutlineRegular;
exports.IconCheckOutlineRegular = IconCheckOutlineRegular;
exports.IconChecklistOutlineRegular = IconChecklistOutlineRegular;
exports.IconChevronDownOutlineRegular = IconChevronDownOutlineRegular;
exports.IconChevronLeftOutlineRegular = IconChevronLeftOutlineRegular;
exports.IconChevronRightOutlineRegular = IconChevronRightOutlineRegular;
exports.IconClockOutlineRegular = IconClockOutlineRegular;
exports.IconCloseCircleFillRegular = IconCloseCircleFillRegular;
exports.IconCloseOutlineRegular = IconCloseOutlineRegular;
exports.IconCompareSplitOutlineRegular = IconCompareSplitOutlineRegular;
exports.IconCordisPluginOutlineRegular = IconCordisPluginOutlineRegular;
exports.IconDatabaseOutlineRegular = IconDatabaseOutlineRegular;
exports.IconDeliverDocRegular = IconDeliverDocRegular;
exports.IconEditOutlineRegular = IconEditOutlineRegular;
exports.IconFlatListOutlineRegular = IconFlatListOutlineRegular;
exports.IconFolderCloseRegular = IconFolderCloseRegular;
exports.IconFolderOpenRegular = IconFolderOpenRegular;
exports.IconGoalOutlineRegular = IconGoalOutlineRegular;
exports.IconInfoOutlineRegular = IconInfoOutlineRegular;
exports.IconInspectOutlineRegular = IconInspectOutlineRegular;
exports.IconLoadingOutlineRegular = IconLoadingOutlineRegular;
exports.IconPlanOutlineRegular = IconPlanOutlineRegular;
exports.IconPlusOutlineRegular = IconPlusOutlineRegular;
exports.IconRefreshOutlineRegular = IconRefreshOutlineRegular;
exports.IconRightUpOutlineRegular = IconRightUpOutlineRegular;
exports.IconSearchOutlineRegular = IconSearchOutlineRegular;
exports.IconSettingsOutlineRegular = IconSettingsOutlineRegular;
exports.IconStopFillRegular = IconStopFillRegular;
exports.IconTriangleRightFillRegular = IconTriangleRightFillRegular;
exports.IconWarningTriangleOutlineRegular = IconWarningTriangleOutlineRegular;
