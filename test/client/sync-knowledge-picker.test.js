// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { KnowledgeContextPicker } = require('../../src/client/components/KnowledgeContextPicker.js');
const { act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root, container, fetchMock, changes;
const scopes = [
  { id: 'orders', title: '订单业务' },
  { id: 'platform', title: '平台规范' },
];
const button = (name) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent.trim() === name);
const click = async (node) => act(async () => node.click());
function Fixture({ disabled = false }) {
  const [ids, setIds] = React.useState([]);
  return React.createElement(KnowledgeContextPicker, {
    workspaceId: 'ws',
    scopeIds: ids,
    disabled,
    onChange: (value) => {
      changes(value);
      setIds(value);
    },
  });
}
beforeEach(() => {
  changes = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ scopes }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('keeps explanation visible while collapsed and supports search, selection and clearing without review requests', async () => {
  await act(async () => root.render(React.createElement(Fixture)));
  const explanation = [...container.querySelectorAll('p')].find((node) =>
    node.textContent.includes('不作为实现证据'),
  );
  expect(explanation.closest('[hidden]')).toBeNull();
  await click(
    [...container.querySelectorAll('button')].find((node) =>
      node.textContent.includes('参考知识库'),
    ),
  );
  expect(button('清空选择').disabled).toBe(true);
  await click(container.querySelector('input[type="checkbox"]'));
  expect(changes).toHaveBeenLastCalledWith(['orders']);
  const input = container.querySelector('[aria-label="搜索知识库名称"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      '平台',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  expect(container.querySelector('input[type="checkbox"]').checked).toBe(false);
  expect(changes).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('已选 1');
  await click(button('清空选择'));
  expect(changes).toHaveBeenLastCalledWith([]);
  expect(fetchMock.mock.calls.every(([url]) => url.endsWith('/writing/options'))).toBe(true);
  expect(container.textContent).not.toContain('推荐关联文档');
});

it('preserves selected scopes on refresh failure and locks edits during sync', async () => {
  await act(async () => root.render(React.createElement(Fixture)));
  await click(
    [...container.querySelectorAll('button')].find((node) =>
      node.textContent.includes('参考知识库'),
    ),
  );
  await click(container.querySelector('input[type="checkbox"]'));
  fetchMock.mockRejectedValueOnce(new Error('OFFLINE'));
  await click(button('刷新'));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('input[type="checkbox"]').checked).toBe(true);
  expect(changes).toHaveBeenCalledTimes(1);
  await act(async () => root.render(React.createElement(Fixture, { disabled: true })));
  expect(button('清空选择').disabled).toBe(true);
  expect(container.querySelector('[aria-label="搜索知识库名称"]').disabled).toBe(true);
  expect(container.querySelector('input[type="checkbox"]').disabled).toBe(true);
});
