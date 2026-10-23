'use strict';
const React = require('react');
const h = React.createElement;
const { Toast } = require('./Toast.js');

/**
 * @module ToastContainer
 * @description Global toast notification manager and container component.
 * Provides a showToast function for triggering notifications from anywhere in the app,
 * and a ToastContainer component that renders active toasts in the component tree.
 */

// Global toast notification manager
let toastListeners = [];

/**
 * Displays a toast notification by dispatching it to all registered listeners.
 * @param {Object} config - Toast configuration object.
 * @param {string} config.text - The notification message text.
 * @param {'success'|'error'|'warning'|'info'} config.tone - The visual tone/severity.
 * @param {number} [config.holdMs] - Duration in milliseconds to display the toast.
 * @param {Array} [config.actions] - Array of action button configurations.
 * @returns {number} A unique toast ID for tracking purposes.
 */
function showToast(config) {
  const id = Date.now() + Math.random();
  toastListeners.forEach(listener => listener({ id, ...config }));
  return id;
}

/**
 * @component ToastContainer
 * @description Container component that manages and renders active toast notifications.
 * Should be placed in the root component tree. Listens for toast events and renders
 * Toast components for each active notification.
 * @returns {JSX.Element} The toast container element wrapping all active toasts.
 */
function ToastContainer() {
  const [toasts, setToasts] = React.useState([]);

  React.useEffect(() => {
    const listener = (toast) => {
      setToasts(prev => [...prev, toast]);
    };
    toastListeners.push(listener);
    return () => {
      toastListeners = toastListeners.filter(l => l !== listener);
    };
  }, []);

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return h('div', { className: 'rh-toast-container' },
    toasts.map(toast =>
      h(Toast, {
        key: toast.id,
        text: toast.text,
        tone: toast.tone,
        holdMs: toast.holdMs,
        actions: toast.actions,
        onDone: () => removeToast(toast.id),
      })
    )
  );
}

module.exports = { ToastContainer, showToast };
