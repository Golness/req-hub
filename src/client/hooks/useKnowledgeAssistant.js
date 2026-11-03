'use strict';
const React = require('react');

/**
 * Select assistant presentation from the owning content area's width.
 * @param active - Whether this page can display its assistant.
 * @returns Shared presentation state, toolbar toggle and close actions.
 */
function useKnowledgeAssistant(active = true) {
  const [container, setContainer] = React.useState(null);
  const [mode, setMode] = React.useState('drawer');
  const [requested, setRequested] = React.useState(false);
  const [sidebarVisible, setSidebarVisible] = React.useState(true);
  React.useLayoutEffect(() => {
    if (!container) {
      return;
    }
    let disposed = false;
    const measure = () => {
      if (disposed) {
        return;
      }
      const width = container.getBoundingClientRect().width;
      if (width <= 0) {
        return;
      }
      if (width < 800) {
        setMode('drawer');
      } else if (width < 1200) {
        setMode('sidebar');
      } else {
        setMode('pinned');
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [container]);
  React.useEffect(() => {
    if (!active || mode !== 'drawer') {
      setRequested(false);
    }
  }, [active, mode]);
  const toggle = () => {
    if (mode === 'drawer') {
      setRequested((previous) => !previous);
    } else if (mode === 'sidebar') {
      setSidebarVisible((previous) => !previous);
    }
  };
  const close = () => {
    if (mode === 'pinned') {
      return;
    }
    setRequested(false);
    setSidebarVisible(false);
  };
  const open = active && mode === 'drawer' && requested;
  const visible = active && (mode === 'pinned' || (mode === 'sidebar' && sidebarVisible) || open);
  return { ref: setContainer, mode, open, visible, pinned: mode === 'pinned', toggle, close };
}
module.exports = { useKnowledgeAssistant };
