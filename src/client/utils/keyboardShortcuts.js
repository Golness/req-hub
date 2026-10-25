'use strict';
const { t } = require('../locale.js');

/**
 * @module keyboardShortcuts
 * @description Manages keyboard shortcut definitions and setup for the application.
 * Provides a registry of supported shortcuts and a setup function that attaches
 * global keydown event listeners with IME composition awareness.
 */

// Local IME handling avoids private Harness Client dependencies.
const observeComposition = null;

/**
 * Fallback IME composition guard that checks event.isComposing and keyCode 229
 * (for older engine compatibility) when DSH observeComposition is unavailable.
 * @param {KeyboardEvent} event - The keyboard event to check.
 * @returns {boolean} True if the event is part of an IME composition input sequence.
 */
function fallbackGuards(event) {
  return event.isComposing || event.keyCode === 229;
}

/**
 * @constant SHORTCUTS
 * @type {Object.<string, {action: string, description: string}>}
 * @description Registry of all supported keyboard shortcuts. Each key is a shortcut string
 * (e.g., 'Ctrl+K'), and each value is an object with an 'action' identifier and a human-readable 'description'.
 */
const SHORTCUTS = {
  'Ctrl+K': { action: 'focusSearch', description: t("keyboardShortcuts.message001") },
  'Ctrl+N': { action: 'createDir', description: t("keyboardShortcuts.message002") },
  'Ctrl+S': { action: 'sync', description: t("keyboardShortcuts.message003") },
  'Ctrl+T': { action: 'toggleFileTree', description: t("keyboardShortcuts.message004") },
  'Escape': { action: 'closePanel', description: t("keyboardShortcuts.message005") },
  'ArrowLeft': { action: 'collapseTree', description: t("keyboardShortcuts.message006") },
  'ArrowRight': { action: 'expandTree', description: t("keyboardShortcuts.message007") },
  'ArrowUp': { action: 'prevTreeItem', description: t("keyboardShortcuts.message008") },
  'ArrowDown': { action: 'nextTreeItem', description: t("keyboardShortcuts.message009") },
  'Enter': { action: 'selectTreeItem', description: t("keyboardShortcuts.message010") },
};

/**
 * Sets up global keyboard shortcut listeners with IME composition awareness.
 * Attaches a keydown event listener to the document that matches pressed keys
 * against the SHORTCUTS registry and invokes the corresponding handler.
 * Skips shortcuts during IME composition input and when focus is in input/textarea elements.
 * @param {Object.<string, Function>} handlers - A map of action names to handler functions (e.g., { focusSearch: () => {...} }).
 * @returns {Function} A cleanup function that removes the event listener and disposes of the composition observer.
 */
function setupKeyboardShortcuts(handlers) {
  // 集成 DSH observeComposition 以支持 IME 输入（中文/日文等）
  let composition = null;
  let guardsFn = fallbackGuards;  // 默认使用自建降级方案
  try {
    if (observeComposition) {
      composition = observeComposition(document);
      guardsFn = (e) => composition.guards(e);
    }
  } catch (e) {
    console.warn('observeComposition not available, using fallback');
  }

  const handleKeyDown = (e) => {
    // Respect host menus before handling plugin shortcuts, including Escape.
    if (e.defaultPrevented || e.target.closest?.('[role="menu"]')) return;
    // IME 组合输入时跳过（如中文输入）
    if (guardsFn(e)) {
      return;
    }

    // 忽略输入框内的快捷键
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }

    const key = e.key;
    const modifiers = [];
    if (e.ctrlKey || e.metaKey) modifiers.push('Ctrl');
    if (e.shiftKey) modifiers.push('Shift');
    if (e.altKey) modifiers.push('Alt');

    // 字母键统一转大写（e.key 返回小写 'k'，SHORTCUTS 定义大写 'K'）
    const normalizedKey = key.length === 1 ? key.toUpperCase() : key;
    const shortcut = [...modifiers, normalizedKey].join('+');
    const shortcutDef = SHORTCUTS[shortcut];

    if (shortcutDef) {
      const handler = handlers[shortcutDef.action];
      if (handler) {
        e.preventDefault();
        handler();
      }
    }
  };

  document.addEventListener('keydown', handleKeyDown);
  return () => {
    document.removeEventListener('keydown', handleKeyDown);
    if (composition) {
      composition.dispose();
    }
  };
}

module.exports = { SHORTCUTS, setupKeyboardShortcuts };
