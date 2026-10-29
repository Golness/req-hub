'use strict';
const css = require('./clipboard.module.css').default;
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  const previous = document.activeElement, input = document.createElement('textarea');
  input.value = text; input.readOnly = true; input.className = css.copySource;
  document.body.append(input);
  try { input.select(); if (!document.execCommand('copy')) throw new Error('CLIPBOARD_FAILED'); }
  finally { input.remove(); if (previous?.isConnected) previous.focus?.(); }
}
module.exports = { writeClipboard };
