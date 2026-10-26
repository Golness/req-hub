// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { ConversationManager } = require('../../src/client/components/ConversationManager.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); root = null; vi.unstubAllGlobals(); });
const entry = { conversationId: 'one', title: 'Fixture conversation', source: 'dsh', sourceStatus: 'active', workspaceTitle: 'Workspace', snapshotVersion: 'version-one' };
const detail = { entry, versions: [{ version: 'version-one', created_at: '2026-10-25', references_count: 1 }], snapshot: { version: 'version-one', turns: [{ messages: [{ label: '用户输入', text: 'User text' }, { label: '助手中间回复', text: 'Intermediate text' }, { label: '助手最终回复', text: 'Final text' }] }] } };
async function render(onChanged = vi.fn()) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(React.createElement(ConversationManager, { workspaceId: 'ws', onClose: vi.fn(), onChanged })));
}
it('loads the shared workspace library and previews full replies and immutable version references', async () => {
  const fetch = vi.fn(async url => ({ ok: true, json: async () => String(url).includes('-list?') ? { sessions: [entry] } : String(url).includes('-jobs?') ? { jobs: [] } : detail }));
  vi.stubGlobal('fetch', fetch); await render();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === entry.title).click());
  expect(document.querySelector('pre').textContent).toContain('Intermediate text');
  expect(document.querySelector('pre').textContent).toContain('Final text');
  expect(document.body.textContent).toContain('1 个任务引用');
  expect(fetch.mock.calls.every(([url]) => String(url).includes('workspaceId=ws'))).toBe(true);
});
it('confirms local deletion and reports referenced-version rejection without changing the selection', async () => {
  const onChanged = vi.fn(), fetch = vi.fn(async (url, options) => ({ ok: !String(url).endsWith('-delete'), json: async () => options?.method === 'POST' ? { error: 'SESSION_VERSION_IN_USE' } : String(url).includes('-list?') ? { sessions: [entry] } : { jobs: [] } }));
  vi.stubGlobal('fetch', fetch); await render(onChanged);
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '删除本地副本').click());
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await act(async () => [...document.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent === '确认').click());
  expect(document.querySelector('[role="alert"]').textContent).toContain('被同步任务引用');
  expect(onChanged).not.toHaveBeenCalled();
  const body = JSON.parse(fetch.mock.calls.find(([url]) => String(url).endsWith('-delete'))[1].body);
  expect(body).toEqual({ workspaceId: 'ws', id: 'one' });
});

it('shows capacity, cleans through the shared endpoint and refreshes the list',async()=>{
 const onChanged=vi.fn(),usage={conversations:1,versions:2,objectBytes:1048576,projectionBytes:2097152,pinnedVersions:1};
 const fetch=vi.fn(async url=>({ok:true,json:async()=>String(url).includes('-list?')?{sessions:[entry]}:String(url).includes('-jobs?')?{jobs:[]}:String(url).includes('-storage?')?{usage}:{success:true}}));vi.stubGlobal('fetch',fetch);await render(onChanged);expect(document.body.textContent).toContain('正文 1.0 MB');
 await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='清理过期数据').click());expect(onChanged).toHaveBeenCalledOnce();const request=fetch.mock.calls.find(([url])=>url.endsWith('-cleanup'));expect(JSON.parse(request[1].body)).toEqual({workspaceId:'ws'});expect(fetch.mock.calls.filter(([url])=>url.includes('-list?'))).toHaveLength(2);
});
