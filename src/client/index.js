'use strict';
const { installStyles } = require('./styles/runtime.js');
const { t, installLocale } = require('./locale.js');
const { installTimeZone } = require('./time.js');
const { installUiLanguage, useUiLanguage } = require('./ui-language.js');
/**
 * ReqHub - Requirements Hub
 * DSH (Developer Service Hub) plugin entry file.
 *
 * Architecture: Multi-file, CommonJS format.
 * - CSS handled by Rolldown plugin (styles/ directory)
 * - Components loaded on demand (components/ directory)
 * - Module wrapping handled automatically by tsdown banner/footer
 *
 * @module req-hub/client
 */

const React = require('react');
const h = React.createElement;
const { SessionSelectionContext } = require('./context.js');

// CSS imports are bundled into plugin-owned styles.
require('./styles/tokens.css');
require('./styles/base.css');
require('./styles/layout.css');
require('./styles/components.css');
require('./styles/buttons.css');
require('./styles/selects.css');
require('./styles/markdown.css');
require('./styles/animations.css');

const { TAB_ID, TAB_KIND } = require('./constants.js');

const { TabBodyWrapper } = require('./components/TabBodyWrapper.js');
const { TabTitle } = require('./components/TabTitle.js');
const { ToastContainer, showToast } = require('./components/shared/ToastContainer.js');
const { TriggerButton } = require('./components/TriggerButton.js');

/**
 * Cordis Plugin Descriptor for ReqHub.
 *
 * @constant {Object} pluginDescriptor
 * @property {string[]} inject - List of Cordis DI services required by this plugin.
 * @property {Function} apply - Plugin activation function that registers tabs, slots, and sidebar actions.
 * @property {Function} apply.dispose - Cleanup function returned by apply that disposes all registrations.
 */
module.exports = {
  inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'locale'],
  apply(ctx) {
    const disposers = [];
    let disposed = false;
    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const errors = [];
      for (const dispose of disposers.toReversed()) {
        try {
          dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (window.__DSH_CTX__ === ctx) {
        delete window.__DSH_CTX__;
      }
      if (errors.length) {
        throw new AggregateError(errors, 'ReqHub Client cleanup failed');
      }
    };
    ctx.effect(() => cleanup, 'req-hub: client lifecycle');
    try {
      disposers.push(ctx.effect(() => installStyles()));
      disposers.push(ctx.effect(() => installLocale(ctx)));
      disposers.push(ctx.effect(() => installTimeZone()));
      disposers.push(ctx.effect(() => installUiLanguage()));

      // Store context globally for components to access
      window.__DSH_CTX__ = ctx;

      disposers.push(
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'req-hub-notifications' },
            ToastContainer,
          ),
        ),
      );

      disposers.push(
        ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          multiple: false,
          priority: 'user',
          title: () => t('common.brand'),
        }),
      );

      const currentSessionId = () => {
        try {
          return ctx.get?.('uiWorkspace')?.selection?.getSnapshot?.()?.sessionId || null;
        } catch {
          return null;
        }
      };
      function LocalizedTabBody() {
        React.useSyncExternalStore(
          (listener) => ctx.locale.subscribe(listener),
          () => ctx.locale.getSnapshot(),
        );
        useUiLanguage();
        return h(
          SessionSelectionContext.Provider,
          { value: currentSessionId },
          h(
            require('./components/shared/DiffReviewPage.js').DiffReviewProvider,
            null,
            h(TabBodyWrapper),
          ),
        );
      }

      disposers.push(
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
            },
            LocalizedTabBody,
          ),
        ),
      );

      disposers.push(
        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab.title',
              key: TAB_ID,
            },
            TabTitle,
          ),
        ),
      );

      disposers.push(
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'req-hub-trigger',
              order: 10,
              label: t('common.brand'),
            },
            ({ wide }) => {
              const handleClick = () => {
                if (!ctx.sidebarRight.mounted.getSnapshot()) {
                  showToast({ text: t('trigger.sessionRequired'), tone: 'info' });
                  return;
                }
                ctx.sidebarRight.openTab(TAB_KIND);
              };
              return h(TriggerButton, { onClick: handleClick, wide });
            },
          ),
        ),
      );

      return cleanup;
    } catch (cause) {
      try {
        cleanup();
      } catch (error) {
        throw new AggregateError([cause, error], 'ReqHub Client initialization failed');
      }
      throw cause;
    }
  },
};
