// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { ConversationKnowledgeImport } = require('../../src/client/components/ConversationKnowledgeImport.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); root = null; vi.unstubAllGlobals(); });
const session = { conversationId: 'conversation-one', id: 'codex:native', title: 'Fixture conversation', source: 'codex', snapshotVersion: 'v1', turnCount: 3, sourceScopeId: 'source-scope', sourceWorkspaceId: 'codex-native-workspace', sourceWorkspaceTitle: 'Same name', sourceWorkspacePaths: ['/codex/source'] };
function detail(version = 'v1') { return { entry: session, version, versions: [{ version: 'v1', created_at: '2026-10-25' }, { version: 'v0', created_at: '2026-10-24' }], turns: [1, 2, 3].map(number => ({ key: 'turn-' + number, number, knowledgeState: ['new', 'same', 'changed'][number - 1], importable: true, turn: { syncable: number !== 3, messages: [{ label: 'User', text: 'Question ' + number }, { label: 'Assistant', text: 'Reply ' + number }] } })) }; }
function api() {
  const fetch = vi.fn(async (url, options) => ({ ok: true, json: async () => String(url).includes('-options') ? { sessions: [session], targets: [{ id: 'target-kb', title: 'Same name', path: '/knowledge/target' }] } : options?.method === 'POST' ? { added: 1, updated: 1, skipped: 0 } : detail(new URL(String(url), 'http://localhost').searchParams.get('version')) }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
async function render(initialTarget) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => root.render(React.createElement(ConversationKnowledgeImport, { initialTarget, onClose: vi.fn(), onImported: vi.fn() }))); }
async function button(text) { await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === text).click()); }
it('requires an explicit destination and keeps source workspaces distinct from knowledge targets', async () => {
  api(); await render('');
  expect(document.querySelector('[role="dialog"]').classList.contains('frame')).toBe(true);
  expect(document.querySelector('.sessions')).not.toBeNull();
  expect(document.querySelector('input[type="checkbox"]').disabled).toBe(true);
  expect([...document.querySelectorAll('button')].find(button => button.textContent === '导入所选轮次').disabled).toBe(true);
  await act(async () => document.querySelector('button[aria-label="目标知识库工作区"]').click());
  await act(async () => document.querySelector('[role="menuitem"][data-value="target-kb"]').click());
  expect(document.querySelector('input[type="checkbox"]').disabled).toBe(false);
  expect(document.body.textContent).toContain('/knowledge/target');
});
it('supports session multi-selection and round deselection, submitting only the chosen frozen rounds', async () => {
  const fetch = api(); await render('target-kb');
  await act(async () => document.querySelector('input[aria-label="选择会话：Fixture conversation"]').click());
  expect(document.body.textContent).toContain('已导入，重复将跳过');
  expect(document.body.textContent).toContain('已变化，选中后更新');
  expect(document.body.textContent).toContain('未完成或已中断');
  await act(async () => document.querySelectorAll('[aria-label="会话轮次"] input')[1].click());
  expect(document.querySelector('input[aria-label="选择会话：Fixture conversation"]').indeterminate).toBe(true);
  await button('导入所选轮次');
  const call = fetch.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(JSON.parse(call[1].body)).toEqual({ targetWorkspaceId: 'target-kb', selections: [{ id: 'conversation-one', version: 'v1', turnKeys: ['turn-1', 'turn-3'] }] });
  expect(document.querySelector('[role="status"]').textContent).toContain('新增 1 轮，更新 1 轮');
});
it('clears selected rounds when changing the frozen snapshot version', async () => {
  api(); await render('target-kb');
  await act(async () => document.querySelector('input[type="checkbox"]').click());
  await act(async () => document.querySelector('button[aria-label="会话版本"]').click());
  await act(async () => document.querySelector('[role="menuitem"][data-value="v0"]').click());
  expect([...document.querySelectorAll('[aria-label="会话轮次"] input')].every(input => !input.checked)).toBe(true);
  expect([...document.querySelectorAll('button')].find(button => button.textContent === '导入所选轮次').disabled).toBe(true);
});
