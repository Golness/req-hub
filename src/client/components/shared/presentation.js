'use strict';
// React adds px to numeric lengths; preserve that rule for local CSS variables.
/**
 * Preserve React numeric-length semantics when passing local CSS variables.
 * @param value - The value to format.
 * @returns A CSS length for numbers, otherwise the original value.
 */
function cssValue(value) {
  return typeof value === 'number' ? `${value}px` : value;
}
module.exports = { cssValue };
