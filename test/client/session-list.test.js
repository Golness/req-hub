// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { SessionList } = require('../../src/client/components/shared/SessionList.js');
const { act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
const session = (id, extra = {}) => ({
  id,
  title: id,
  snapshotVersion: 'v1',
  turnCount: 2,
  syncTurnCount: 1,
  createdAt: '2026-09-29T10:00:00Z',
  ...extra,
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = async (props) => {
  await act(async () =>
    root.render(
      React.createElement(SessionList, {
        selectedIds: [],
        onToggle: vi.fn(),
        onView: vi.fn(),
        ...props,
      }),
    ),
  );
};
const rows = () => [...container.querySelectorAll('.rh-session-row')];

it.each(['', ' Codex '])(
  'orders %s sessions by source activity without changing input',
  async (source) => {
    const sessions = [
      session('old'),
      session('unknown', { updatedAt: 'bad', createdAt: null }),
      session('new', { createdAt: Date.parse('2026-09-30T10:00:00Z') }),
      session('active', { updatedAt: '2026-11-02T10:00:00Z' }),
      session('fallback', { updatedAt: 'bad', createdAt: '2026-10-30T10:00:00Z' }),
    ];
    const original = sessions.map((item) => item.id);
    await render({ sessions, source });
    expect(rows().map((row) => row.querySelector('.rh-session-title').textContent)).toEqual([
      'active',
      'fallback',
      'new',
      'old',
      'unknown',
    ]);
    expect(sessions.map((item) => item.id)).toEqual(original);
    expect(rows()[0].textContent).toContain(new Date('2026-11-02T10:00:00Z').toLocaleDateString());
  },
);

it('explains unavailable choices and keeps incomplete-session previews usable', async () => {
  const onToggle = vi.fn();
  const onView = vi.fn();
  const sessions = [
    session('ready'),
    session('unfinished', { syncTurnCount: 0 }),
    session('failed', { snapshotVersion: null, snapshotError: 'SNAPSHOT_FAILED' }),
    session('pending', { snapshotVersion: null }),
  ];
  await render({ sessions, onToggle, onView });
  const [ready, unfinished, failed, pending] = rows();
  expect(ready.dataset.unavailable).toBe('false');
  expect(ready.textContent).toContain('可同步');
  for (const [row, reason] of [
    [unfinished, '无完整轮次'],
    [failed, '读取失败'],
    [pending, '未就绪'],
  ]) {
    const input = row.querySelector('input');
    expect(row.dataset.unavailable).toBe('true');
    expect(input.disabled).toBe(true);
    expect(document.getElementById(input.getAttribute('aria-describedby')).textContent).toBe(
      reason,
    );
    await act(async () => input.click());
  }
  expect(onToggle).not.toHaveBeenCalled();
  expect(failed.querySelector('button').disabled).toBe(true);
  expect(unfinished.querySelector('button').disabled).toBe(false);
  await act(async () => unfinished.querySelector('button').click());
  expect(onView).toHaveBeenCalledWith(sessions[1]);
  await act(async () => ready.querySelector('input').click());
  expect(onToggle).toHaveBeenCalledWith('ready');
});

it('allows removal of an unavailable selection and distinguishes temporary locking', async () => {
  const onToggle = vi.fn();
  const sessions = [session('selected', { syncTurnCount: 0 }), session('ready')];
  await render({ sessions, selectedIds: ['selected'], onToggle });
  expect(rows()[0].querySelector('input').disabled).toBe(false);
  await act(async () => rows()[0].querySelector('input').click());
  expect(onToggle).toHaveBeenCalledWith('selected');
  await render({ sessions, selectedIds: ['selected'], disabled: true });
  expect(rows().every((row) => row.querySelector('input').disabled)).toBe(true);
  expect(rows()[1].textContent).toContain('暂不可选');
});
