// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SyncVersionCompare } = require('../../src/client/components/shared/SyncVersionCompare.js');
let container, root;
const version = (id, docType = 'requirement', status = 'completed') => ({ id, commitHash: id.repeat(8), docType, status, completedAt: 1000, startedAt: 1000 });
const history = [version('failed', 'requirement', 'failed'), version('new'), version('old'), version('design-new', 'design'), version('design-old', 'design')];
const render = async () => act(async () => root.render(React.createElement(SyncVersionCompare, { history, workspaceId: 'workspace', requirementId: 'requirement' })));
const click = async text => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text).click());
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe('successful sync version selection', () => {
  it('defaults to oldest → newest of the latest two successes and excludes failures', async () => {
    await render();
    const selects = container.querySelectorAll('[role="combobox"]');
    expect(selects[0].textContent).toContain('oldoldol'); expect(selects[1].textContent).toContain('newnewne');
    await act(async () => selects[0].click());
    expect([...document.querySelectorAll('[role="option"] .rh-version-name')].map(option => option.textContent)).toEqual(['newnewne最新', 'oldoldol']);
    expect(document.querySelector('[role="option"][aria-selected="true"]').textContent).toContain('oldoldol');
    await click('交换'); expect(selects[0].textContent).toContain('newnewne'); expect(selects[1].textContent).toContain('oldoldol');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it('switches document types with independent defaults and rejects identical versions', async () => {
    await render(); await click('技术方案');
    const selects = container.querySelectorAll('[role="combobox"]');
    expect(selects[0].textContent).toContain('design-o'); expect(selects[1].textContent).toContain('design-n');
    await act(async () => selects[0].click());
    await act(async () => document.querySelector('[role="option"]').click());
    expect([...container.querySelectorAll('button')].find(button => button.textContent === '查看差异').disabled).toBe(true);
    expect(container.textContent).toContain('请选择两个不同版本');
  });
  it('sends explicit base and target versions and reports errors inline', async () => {
    fetch.mockResolvedValue({ ok: false, json: async () => ({ error: '成功版本快照缺失' }) });
    await render(); await click('查看差异');
    const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('syncId1')).toBe('old'); expect(url.searchParams.get('syncId2')).toBe('new');
    expect(container.querySelector('[role="alert"]').textContent).toBe('成功版本快照缺失');
  });
  it('discards a pending response after the document type changes', async () => {
    let resolve;
    fetch.mockReturnValue(new Promise(done => { resolve = done; }));
    await render(); await click('查看差异'); await click('技术方案');
    await act(async () => resolve({ ok: false, json: async () => ({ error: 'stale response' }) }));
    expect(container.textContent).not.toContain('stale response');
  });

  it('supports keyboard selection, Escape, Tab, and outside dismissal', async () => {
    await render();
    const trigger = container.querySelector('[role="combobox"]');
    const key = async value => act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
    await key('ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[role="listbox"]').parentElement).toBe(document.body);
    await key('Home'); await key('Enter');
    expect(trigger.textContent).toContain('newnewne');
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await key('ArrowUp'); await key('Escape');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await key('ArrowDown'); await key('Tab');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => trigger.click());
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('positions the menu above the trigger near the bottom and removes it on unmount', async () => {
    await render();
    const trigger = container.querySelector('[role="combobox"]');
    trigger.getBoundingClientRect = () => ({ width: 220, left: 20, top: innerHeight - 70, bottom: innerHeight - 12 });
    await act(async () => trigger.click());
    const menu = document.querySelector('[role="listbox"]');
    expect(menu.style.bottom).toBe('76px');
    expect(menu.style.width).toBe('220px');
    await act(async () => root.render(null));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
