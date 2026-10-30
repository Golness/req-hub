'use strict';
const { ROUTE } = require('../constants.js');
/**
 * Resolve authorized writing assets and reject dangerous image schemes.
 * @param src - The original Markdown image source.
 * @param context - The workspace and requirement owning writing assets.
 * @returns An allowed image URL, or an empty string for a blocked scheme.
 */
function markdownImageUrl(src, context) {
  const match = /^(?:\.\/)?assets\/images\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/.exec(src || '');
  if (match && context?.workspaceId && context?.requirementPath) {
    return `${ROUTE}/writing/assets/${match[1]}?${new URLSearchParams({ workspaceId: context.workspaceId, requirementPath: context.requirementPath })}`;
  }
  return /^(?:javascript|vbscript|file):/i.test(src || '') ||
    /^data:(?!image\/(?:png|jpeg|gif|webp);base64,)/i.test(src || '')
    ? ''
    : src;
}
/**
 * Create an image node view using the current requirement context.
 * @param node - The current ProseMirror image node.
 * @param getContext - Callback reading the current image ownership context.
 * @returns The image DOM, update handler and mutation policy.
 */
function imageNodeView(node, getContext) {
  const dom = document.createElement('img');
  const update = (next) => {
    if (next.type.name !== 'image') {
      return false;
    }
    dom.setAttribute('src', markdownImageUrl(next.attrs.src, getContext()) || '');
    dom.setAttribute('alt', next.attrs.alt || '');
    if (next.attrs.title) {
      dom.setAttribute('title', next.attrs.title);
    } else {
      dom.removeAttribute('title');
    }
    return true;
  };
  update(node);
  return { dom, update, ignoreMutation: (mutation) => mutation.type === 'attributes' };
}
module.exports = { markdownImageUrl, imageNodeView };
