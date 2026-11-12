// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { PagedList } = require('../../src/client/components/shared/PagedList.js');
const { Disclosure } = require('../../src/client/components/shared/Disclosure.js');
const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container, root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const records = (count) =>
  Array.from({ length: count }, (_, i) =>
    h('article', { key: i }, h('h3', null, `Record ${i + 1}`), h('p', null, `Metadata ${i + 1}`)),
  );
async function render(children, props = {}) {
  await act(async () => root.render(h(PagedList, props, children)));
}
async function click(label) {
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === label)
      .click(),
  );
}
const titles = () =>
  [...container.querySelectorAll('[role="listitem"] h3')].map((el) => el.textContent);

it('keeps ten records per page regardless of panel height and resets scroll on navigation', async () => {
  await render(records(14));
  expect(titles()).toHaveLength(10);
  const list = container.querySelector('[role="list"]');
  list.scrollTop = 200;
  await click('下一页');
  expect(titles()).toEqual(['Record 11', 'Record 12', 'Record 13', 'Record 14']);
  expect(list.scrollTop).toBe(0);
  expect(container.textContent).toContain('第 2 / 2 页 · 11–14 条 · 共 14 条');
  await click('上一页');
  expect(titles()[0]).toBe('Record 1');
});

it('loads the next cursor once and keeps the current page intact on failure', async () => {
  let finish;
  const onMore = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render(records(10), { hasMore: true, onMore });
  await click('下一页');
  await click('下一页');
  expect(onMore).toHaveBeenCalledTimes(1);
  expect(titles()).toHaveLength(10);
  await act(async () => {
    root.render(h(PagedList, { hasMore: false, onMore }, records(20)));
    finish();
  });
  expect(titles()).toEqual(records(10).map((_, i) => `Record ${i + 11}`));
  const failed = vi.fn(async () => {
    throw new Error('offline');
  });
  await render(records(20), { hasMore: true, onMore: failed });
  await click('下一页');
  expect(container.querySelector('[role="alert"]').textContent).toContain('翻页失败');
  expect(titles()[0]).toBe('Record 11');
  expect(failed).toHaveBeenCalledOnce();
});

it('resets after filtering and clamps deleted pages', async () => {
  await render(records(14), { resetKey: 'all' });
  await click('下一页');
  await render(records(2), { resetKey: 'all' });
  expect(titles()).toEqual(['Record 1', 'Record 2']);
  await render(records(14), { resetKey: 'all' });
  await click('下一页');
  await render(records(14), { resetKey: 'filtered' });
  expect(titles()[0]).toBe('Record 1');
});

it('opens full details outside rows and returns focus on Escape', async () => {
  await render([h('article', { key: 'record' }, 'Full record')]);
  const trigger = container.querySelector('[aria-label="查看完整记录"]');
  expect(trigger.tagName).toBe('DIV');
  expect(trigger.querySelector('button')).toBeNull();
  trigger.focus();
  await act(async () => trigger.click());
  expect(document.querySelector('[role="dialog"]').textContent).toContain('Full record');
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('opens long disclosures without expanding the bounded list', async () => {
  await render([h(Disclosure, { key: 'record', title: 'Details' }, 'Long full details')]);
  await act(async () => container.querySelector('[data-rh-disclosure-trigger]').click());
  expect(document.querySelector('[role="dialog"]').textContent).toContain('Long full details');
  expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
  expect(container.querySelector('nav')).toBeNull();
});

it.each(['mask', 'close', 'Escape'])(
  'closes a record disclosure once with %s without opening the parent record',
  async (method) => {
    await render([
      h(
        'article',
        { key: 'event' },
        h('p', null, 'Published event'),
        h(Disclosure, { title: 'Event details' }, h('pre', null, '{"actor":"automatic"}')),
      ),
    ]);
    const trigger = container.querySelector('[data-rh-disclosure-trigger]');
    trigger.focus();
    await act(async () => trigger.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.querySelector('h2').textContent).toBe('Event details');
    await act(async () => dialog.querySelector('pre').click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await act(async () => {
      if (method === 'mask') {
        document.querySelector('[data-rh-modal] > [aria-hidden="true"]').click();
      } else if (method === 'close') {
        [...dialog.querySelectorAll('button')].find((node) => node.textContent === '关闭').click();
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  },
);

it('keeps open editors synchronized with the current record props', async () => {
  function Editor() {
    const [value, setValue] = React.useState('old');
    return h(
      PagedList,
      null,
      h(
        'article',
        { key: 'editor' },
        h('input', {
          value,
          onChange: (event) => setValue(event.target.value),
          'aria-label': 'Edit',
        }),
      ),
    );
  }
  await act(async () => root.render(h(Editor)));
  await act(async () => container.querySelector('[aria-label="查看完整记录"]').click());
  const input = document.querySelector('[role="dialog"] input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      'new',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(document.querySelector('[role="dialog"] input').value).toBe('new');
});

async function inputValue(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('offers only 10, 20 and 50 records per page and returns to the first page on size change', async () => {
  await render(records(65));
  await click('下一页');
  for (const size of [20, 50, 10]) {
    await act(async () => container.querySelector('[aria-label="每页条数"]').click());
    const options = [...document.querySelectorAll('[role="menuitem"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      '10 条/页',
      '20 条/页',
      '50 条/页',
    ]);
    await act(async () => options.find((option) => option.textContent === `${size} 条/页`).click());
    expect(titles()).toHaveLength(size);
    expect(titles()[0]).toBe('Record 1');
  }
});

it('jumps to a valid loaded page and rejects invalid page numbers', async () => {
  await render(records(31));
  const input = container.querySelector('[aria-label="跳转页码"]');
  await inputValue(input, '4');
  await act(async () =>
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(titles()).toEqual(['Record 31']);
  for (const value of ['0', '5', '1.5', '']) {
    await inputValue(input, value);
    expect(
      [...container.querySelectorAll('button')].find((button) => button.textContent === '跳转')
        .disabled,
    ).toBe(true);
    await act(async () =>
      input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(titles()).toEqual(['Record 31']);
  }
});

it('preserves row actions and navigation without opening a second dialog', async () => {
  const action = vi.fn();
  await render([
    h('article', { key: 'action' }, h('button', { onClick: action }, 'Action')),
    h('button', { key: 'navigation', onClick: action }, 'Navigate'),
  ]);
  await click('Action');
  await click('Navigate');
  expect(action).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const row = container.querySelector('[role="listitem"]');
  await act(async () =>
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

it('ignores a stale cursor completion after the filter changes', async () => {
  let finish;
  const onMore = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render(records(10), { resetKey: 'old', hasMore: true, onMore });
  await click('下一页');
  await render(records(25), { resetKey: 'new' });
  await act(async () => finish());
  expect(titles()[0]).toBe('Record 1');
  expect(container.querySelector('[role="list"]').getAttribute('aria-busy')).toBe('false');
});

it('distinguishes loaded pages from the total and handles an empty list', async () => {
  await render(records(12), { hasMore: true, onMore: vi.fn() });
  expect(container.textContent).toContain('已加载 2 页');
  expect(container.textContent).toContain('还有更多');
  expect(container.textContent).not.toContain('共 12 条');
  await render([]);
  expect(container.querySelector('nav')).toBeNull();
  expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(0);
});
