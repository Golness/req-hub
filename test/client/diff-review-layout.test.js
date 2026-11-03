// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { DiffReviewPage } = require('../../src/client/components/shared/DiffReviewPage.js');
const { act } = React;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = (props) => act(async () => root.render(React.createElement(DiffReviewPage, props)));

it('announces identical versions before metadata without rendering duplicate document bodies', async () => {
  await render({
    fileName: 'design.md',
    oldContent: 'same document\n'.repeat(100),
    newContent: 'same document\n'.repeat(100),
    oldLabel: 'old version',
    newLabel: 'new version',
    onBack: () => {},
  });
  const status = [...container.querySelectorAll('[role="status"]')].find((node) =>
    node.textContent.includes('两个版本内容相同'),
  );
  expect(status.parentElement.firstElementChild).toBe(status);
  expect(container.textContent).not.toContain('待处理');
  expect(container.textContent).toContain('old version');
  expect(container.textContent).toContain('new version');
  expect(container.querySelector('pre')).toBeNull();
  const toggle = container.querySelector('[data-rh-disclosure-trigger]');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await act(async () => toggle.click());
  expect(container.querySelectorAll('pre')).toHaveLength(1);
  expect(container.querySelector('pre').textContent).toBe('same document\n'.repeat(100));
});

it('can hide unchanged context without removing either side of a change', async () => {
  await render({
    oldContent: 'unchanged\nold\n',
    newContent: 'unchanged\nnew\n',
    onBack: () => {},
  });
  expect([...container.querySelectorAll('pre')].map((node) => node.textContent)).toEqual([
    'unchanged\n',
    'unchanged\n',
    'old\n',
    'new\n',
  ]);
  const toggle = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === '仅看变更',
  );
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect([...container.querySelectorAll('pre')].map((node) => node.textContent)).toEqual([
    'old\n',
    'new\n',
  ]);
  await act(async () => toggle.click());
  expect(container.querySelectorAll('pre')).toHaveLength(4);
});
