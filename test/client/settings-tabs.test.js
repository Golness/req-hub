// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { SettingsTabs } = require('../../src/client/components/shared/SettingsTabs.js');
const { SettingsActionBar } = require('../../src/client/components/shared/SettingsActionBar.js');
const { Modal } = require('../../src/client/components/shared/controls.js');
const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

function Draft({ name }) {
  const [draft, setDraft] = React.useState('');
  return h(
    React.Fragment,
    null,
    h('input', {
      'aria-label': name,
      value: draft,
      onChange: (event) => setDraft(event.target.value),
    }),
    h(
      SettingsActionBar,
      { placement: 'page', leading: h('button', null, `Reset ${name}`) },
      h('button', null, `Save ${name}`),
    ),
  );
}

it('keeps only active actions outside scrolling pages and retains drafts across keyboard navigation', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      h(SettingsTabs, {
        label: 'Settings',
        tabs: ['A', 'B'].map((name) => ({
          id: name,
          label: name,
          render: () => h(Draft, { name }),
        })),
      }),
    ),
  );
  const input = container.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      'draft',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const tabs = container.querySelectorAll('[role="tab"]');
  await act(async () =>
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect(document.activeElement).toBe(tabs[1]);
  const dock = container.querySelector('[data-settings-dock]');
  expect(dock.closest('[role="tabpanel"]')).toBeNull();
  expect(dock.textContent).toBe('Reset BSave B');
  expect(container.querySelectorAll('[data-settings-actions="page"]')).toHaveLength(1);
  expect(container.querySelector('[role="tabpanel"] [data-settings-actions]')).toBeNull();
  await act(async () =>
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })),
  );
  expect(container.querySelector('input').value).toBe('draft');
  expect(dock.textContent).toBe('Reset ASave A');
});

it('keeps modal actions outside its scrolling body and restores trigger focus on dismissal', async () => {
  function Example() {
    const [open, setOpen] = React.useState(false);
    return h(
      React.Fragment,
      null,
      h('button', { onClick: () => setOpen(true) }, 'Open'),
      h(
        Modal,
        {
          open,
          title: 'Details',
          onClose: () => setOpen(false),
          footer: h('button', null, 'Apply'),
        },
        h('pre', null, 'Long output\n'.repeat(1000)),
      ),
    );
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(h(Example)));
  const trigger = container.querySelector('button');
  trigger.focus();
  await act(async () => trigger.click());
  const dialog = document.querySelector('[role="dialog"]');
  const footer = dialog.querySelector('[data-rh-modal-footer]');
  expect(footer.textContent).toBe('Apply');
  expect(footer.parentElement).toBe(dialog);
  expect(dialog.querySelector('[data-rh-modal-body]').contains(footer)).toBe(false);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
