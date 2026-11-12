// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { CreateDirForm } = require('../../src/client/components/CreateDirForm.js');
const { ToastContainer } = require('../../src/client/components/shared/ToastContainer.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); });
const click = async node => act(async () => node.click());
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
async function render(status, fetchOther = async () => ({ ok: true, json: async () => ({}) })) {
  const onClose = vi.fn(), onExisting = vi.fn(), onCreated = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url, options) => url.includes('/create-status') ? { ok: true, json: async () => status } : fetchOther(url, options)));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(CreateDirForm, { workspaceId: 'w', docsDir: 'docs', onClose, onExisting, onCreated }), React.createElement(ToastContainer))));
  return { onClose, onExisting, onCreated };
}
it('hides the form and delegates the existing branch/directory notice before closing', async () => {
  const req = { id: '2026-10-28-ST', path: 'alice/2026-10-28-ST' };
  const { onClose, onExisting } = await render({ branch: 'feature/alice/2026-10-28-ST', existingRequirement: req });
  expect(container.querySelector('input')).toBeNull(); expect(onExisting).toHaveBeenCalledWith(req, 'feature/alice/2026-10-28-ST'); expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain('请先更换工作区');
});
it('closes only after successful creation and keeps the chosen letter case', async () => {
  const sent = [];
  const { onClose, onCreated } = await render({ branch: 'feature/alice/2026-10-28-ST', existingRequirement: null }, async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ path: 'alice/2026-10-28-ST' }) }; });
  await click(button('创建')); expect(sent[0].title).toBe('ST'); expect(onCreated).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1);
});
it.each(['main', 'master'])('offers explicit %s update and sends the expected branch and version', async branch => {
  const sent = [];
  await render({ branch, canUpdateMain: true, head: 'a'.repeat(40) }, async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ updated: true }) }; });
  await click(button(`更新 ${branch}`));
  expect(sent).toEqual([{ workspaceId: 'w', expectedHead: 'a'.repeat(40), branch }]); expect(document.body.textContent).toContain(`本地 ${branch} 已更新`);
});
it('keeps the main update visible and explains why dirty workspaces cannot update', async () => {
  await render({ branch: 'main', canUpdateMain: false, dirty: true });
  expect(button('更新 main').disabled).toBe(true);
  expect(container.textContent).toContain('有未提交改动，处理后刷新。');
  await click(button('更新 main'));
  expect(fetch.mock.calls.some(([url]) => url.includes('/update-main'))).toBe(false);
});

it.each([
  ['CREATE_MAIN_IN_PROGRESS', 'Git 操作未完成，处理后刷新。'],
  ['CREATE_MAIN_NOT_ROOT', '当前工作区不是仓库根目录，无法更新。'],
])('shows the Host blocking reason %s beside the disabled action', async (reason, hint) => {
  await render({ branch: 'master', canUpdateMain: false, mainUpdateBlockedReason: reason });
  const update = button('更新 master');
  expect(update.disabled).toBe(true);
  expect(document.getElementById(update.getAttribute('aria-describedby')).textContent).toBe(hint);
});

it('rechecks eligibility explicitly before allowing main update', async () => {
  const status = { branch: 'main', canUpdateMain: false, dirty: true };
  await render(status);
  expect(button('更新 main').disabled).toBe(true);
  status.dirty = false;
  status.canUpdateMain = true;
  await click(button('刷新状态'));
  expect(button('更新 main').disabled).toBe(false);
  expect(fetch.mock.calls.filter(([url]) => url.includes('/create-status'))).toHaveLength(2);
  expect(fetch.mock.calls.some(([url]) => url.includes('/update-main'))).toBe(false);
});

it('prefills the configured default username when opening a new requirement', async () => {
  await render({ branch: 'main' }, async (url) => ({
    ok: true, json: async () => url.endsWith('/config') ? { defaultUsername: 'alice-smith' } : {},
  }));
  expect(container.querySelector('input[id$="-developer"]').value).toBe('alice-smith');
});
