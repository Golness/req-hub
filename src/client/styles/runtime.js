'use strict';

const { styles } = require('./manifest.cjs');

/**
 * Mount plugin CSS only during activation, sharing nodes across overlapping activations.
 * @returns A disposer that releases only nodes acquired by this activation.
 */
function installStyles() {
  const owned = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const tag of owned) {
      tag.reqHubOwners -= 1;
      if (!tag.reqHubOwners) {
        tag.remove();
      }
    }
  };
  try {
    for (const [id, css] of styles) {
      let tag = Array.from(document.querySelectorAll('style[data-req-hub-style]')).find(
        (node) => node.dataset.reqHubStyle === id && node.textContent === css,
      );
      if (!tag) {
        tag = document.createElement('style');
        tag.dataset.reqHubStyle = id;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
      tag.reqHubOwners = (tag.reqHubOwners || 0) + 1;
      owned.push(tag);
    }
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

module.exports = { installStyles };
