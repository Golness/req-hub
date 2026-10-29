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
  await click(button(`拉取并合并远端 ${branch}`));
  expect(sent).toEqual([{ workspaceId: 'w', expectedHead: 'a'.repeat(40), branch }]); expect(document.body.textContent).toContain(`本地 ${branch} 已更新`);
});
it('does not offer main update for dirty workspaces or other branches', async () => {
  await render({ branch: 'main', canUpdateMain: false, dirty: true });
  expect(button('拉取并合并远端 main')).toBeUndefined();
});
