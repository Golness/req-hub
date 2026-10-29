// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url), React = require('react'), { act } = React;
const { createRoot } = require('react-dom/client');
const { DiffReviewPage, DiffReviewProvider, useDiffReview } = require('../../src/client/components/shared/DiffReviewPage.js');
const { DiffViewer } = require('../../src/client/components/shared/DiffViewer.js');
const { AiTaskStatus } = require('../../src/client/components/shared/AiTaskStatus.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
const render = element => act(async () => root.render(element));
const button = text => [...container.querySelectorAll('button')].find(node => node.textContent === text);
const click = node => act(async () => node.click());
it('shows overview apart from edits and saves mixed choices when the last change is decided', async () => {
  const complete = vi.fn();
  await render(React.createElement(DiffReviewPage, { oldContent: 'old\r\nstable\r\nlast\r\n', newContent: 'new\r\nstable\r\nend\r\n', overview: 'Explanation only', onComplete: complete, onBack: vi.fn() }));
  expect(container.querySelector('section').textContent).toContain('Explanation only');
  expect([...container.querySelectorAll('pre')].some(node => node.textContent.includes('Explanation only'))).toBe(false);
  expect(button('完成并返回')).toBeUndefined();
  const header = container.querySelector('header');
  expect([...header.querySelectorAll('button')].map(node => node.textContent)).toEqual(['全部采用', '全部保留原文', '返回']);
  await click(button('采用此项'));
  expect(complete).not.toHaveBeenCalled();
  await click([...container.querySelectorAll('button')].filter(node => node.textContent === '保留原文')[1]);
  expect(complete).toHaveBeenCalledWith('new\r\nstable\r\nlast\r\n');
  await click(button('全部保留原文'));
  expect(complete).toHaveBeenLastCalledWith('old\r\nstable\r\nlast\r\n');
});
it('keeps origin state mounted, returns with Escape and restores launcher focus', async () => {
  let mounted = 0, disposed = 0;
  function Origin() {
    const review = useDiffReview(), [text, setText] = React.useState('kept');
    React.useEffect(() => { mounted++; return () => { disposed++; }; }, []);
    return React.createElement('div', null,
      React.createElement('input', { value: text, onChange: event => setText(event.target.value) }),
      React.createElement('button', { onClick: () => review.open({ oldContent: 'one', newContent: 'two' }) }, 'Launch'));
  }
  await render(React.createElement(DiffReviewProvider, null, React.createElement(Origin)));
  const launcher = button('Launch'); launcher.focus(); await click(launcher);
  expect(container.querySelector('[hidden] input').value).toBe('kept');
  expect(mounted).toBe(1); expect(disposed).toBe(0);
  expect(document.activeElement.textContent).toBe('返回');
  await act(async () => container.querySelector('section').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container.querySelector('[aria-label="差异审阅"]')).toBeNull();
  expect(document.activeElement).toBe(launcher);
});
it.each([['全部采用', 'new'], ['全部保留原文', 'old']])('%s saves once and returns to the origin', async (action, expected) => {
  const complete = vi.fn();
  await render(React.createElement(DiffReviewProvider, null, React.createElement(function Origin() {
    const review = useDiffReview();
    return React.createElement('button', { onClick: () => review.open({ oldContent: 'old', newContent: 'new', onComplete: complete }) }, 'Launch');
  })));
  const launcher = button('Launch'); launcher.focus(); await click(launcher);
  await click(button(action));
  expect(complete).toHaveBeenCalledExactlyOnceWith(expected);
  expect(container.querySelector('[aria-label="差异审阅"]')).toBeNull();
  expect(document.activeElement).toBe(launcher);
});
it('opens comparison through the shared page and never adds apply controls to read-only history', async () => {
  await render(React.createElement(DiffReviewProvider, null, React.createElement(DiffViewer, { oldContent: '<script>bad</script>', newContent: 'safe', fileName: 'requirement.md' })));
  expect(container.querySelector('pre')).toBeNull();
  await click(button('打开差异审阅'));
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('pre').textContent).toBe('<script>bad</script>');
  expect(button('采用此项')).toBeUndefined();
  await click(button('返回'));
  expect(button('打开差异审阅')).toBeDefined();
});
it('refuses applying when the source changed and retains decisions until returning', async () => {
  await render(React.createElement(DiffReviewProvider, null, React.createElement(function Origin() {
    const review = useDiffReview();
    return React.createElement('button', { onClick: () => review.open({ oldContent: 'old', newContent: 'new', onComplete: () => false }) }, 'Launch');
  })));
  await click(button('Launch')); await click(button('全部采用'));
  expect(container.querySelector('[role="alert"]').textContent).toContain('草稿已在分析后修改');
  expect(container.querySelector('button[aria-pressed="true"]')).not.toBeNull();
});
it('displays truthful elapsed time for ISO timestamps and clears its timer on unmount', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T03:01:00Z'));
  await render(React.createElement(AiTaskStatus, { startedAt: '2026-10-28T03:00:00Z', stage: 'reading', searched: 2, read: 3 }));
  expect(container.textContent).toContain('已用时 1 分 0 秒');
  expect(container.textContent).toContain('完整读取 3 篇资料');
  expect(container.querySelector('progress')).toBeNull();
  await act(async () => vi.advanceTimersByTime(2000));
  expect(container.textContent).toContain('1 分 2 秒');
  await render(null); expect(vi.getTimerCount()).toBe(0);
});
it('starts with a compact status and preserves an explicitly expanded detail view across updates', async () => {
  const props = { startedAt: Date.now(), stage: 'reading', searched: 2, read: 3, sessionId: 'child', activity: { searches: 4 } };
  await render(React.createElement(AiTaskStatus, props));
  const toggle = container.querySelector('button[aria-controls]');
  const details = document.getElementById(toggle.getAttribute('aria-controls'));
  expect(details.hidden).toBe(true);
  expect(container.querySelector('[role=status]').textContent).toContain('AI 正在阅读');
  await act(async () => toggle.click());
  expect(details.hidden).toBe(false);
  expect([...details.querySelectorAll('dt')].map(node => node.textContent)).toEqual(['知识库读取', '最近活动', '模型输出', '检索情况', 'DSH 子会话']);
  await render(React.createElement(AiTaskStatus, { ...props, read: 4 }));
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain('完整读取 4 篇资料');
  await act(async () => toggle.click());
  expect(details.hidden).toBe(true);
});

it('warns after two minutes without execution evidence and recovers on a real update', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T01:00:00Z'));
  const startedAt = Date.now();
  await render(React.createElement(AiTaskStatus, { startedAt, stage: 'waiting_model', activity: {}, sessionId: 'actual-child' }));
  expect(container.textContent).toContain('等待模型响应');
  await act(async () => vi.advanceTimersByTime(121000));
  expect(container.textContent).toContain('无法确认任务仍在推进');
  expect(container.textContent).toContain('actual-child');
  await render(React.createElement(AiTaskStatus, { startedAt, stage: 'thinking', activity: { lastActivityAt: Date.now(), reasoningCharacters: 10 } }));
  expect(container.textContent).not.toContain('无法确认任务仍在推进');
  expect(container.textContent).toContain('推理 10 字符');
});
