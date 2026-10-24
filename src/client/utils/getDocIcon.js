'use strict';

/**
 * @module getDocIcon
 * @description Utility for mapping document types to their corresponding icon components.
 * Provides a factory function that returns the appropriate React icon element for a given document type.
 */

const React = require('react');
const h = React.createElement;
const { createIconComponents } = require('../icons.js');

const { IconClipboard, IconDesign, IconReview, IconApi, IconTest, IconFile, IconFolder } = createIconComponents(h);

/**
 * Returns a React icon element corresponding to the given document type.
 * @param {string} type - The document type. Supported values: 'requirement', 'design', 'cr', 'other', 'prd', 'tech', 'api', 'test', 'folder'.
 * @param {number} [size=14] - The size of the icon in pixels. Defaults to 14.
 * @returns {React.ReactElement} A React element representing the icon for the specified document type.
 */
function getDocIcon(type, size) {
  const iconMap = {
    requirement: IconClipboard,
    design: IconDesign,
    cr: IconReview,
    other: IconFile,
    prd: IconClipboard,
    tech: IconDesign,
    api: IconApi,
    test: IconTest,
    folder: IconFolder,
  };
  const Icon = iconMap[type] || IconFile;
  return h(Icon, { size: size || 14 });
}

module.exports = { getDocIcon };
