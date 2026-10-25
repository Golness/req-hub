'use strict';
// React adds px to numeric lengths; preserve that rule for local CSS variables.
function cssValue(value) { return typeof value === 'number' ? `${value}px` : value; }
module.exports = { cssValue };
