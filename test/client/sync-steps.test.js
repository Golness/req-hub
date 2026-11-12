// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { createRoot } = require('react-dom/client');
const { SyncStepList } = require('../../src/client/components/SyncSteps.js');
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
const render = async (props) => {
  await act(async () => root.render(React.createElement(SyncStepList, props)));
};
const step = (phase) => container.querySelector(`[data-sync-step="${phase}"]`);

it('follows the active step while preserving explicit collapse decisions through updates', async () => {
  const steps = [
    { phase: 'init', label: '同步检查', status: 'completed', log: 'prepared' },
    { phase: 'code', label: '代码分析', status: 'running', log: 'analysis' },
    { phase: 'edit', label: '编辑', status: 'pending', log: 'edit' },
  ];
  await render({ steps });
  expect(step('init').querySelector('button').getAttribute('aria-expanded')).toBe('false');
  expect(step('code').querySelector('button').getAttribute('aria-expanded')).toBe('true');
  await act(async () => step('code').querySelector('button').click());
  await render({ steps: steps.map((item) => ({ ...item, text: 'updated' })) });
  expect(step('code').querySelector('button').getAttribute('aria-expanded')).toBe('false');
  await render({
    steps: steps.map((item) => ({
      ...item,
      status: item.phase === 'edit' ? 'running' : 'completed',
    })),
  });
  expect(step('edit').querySelector('button').getAttribute('aria-expanded')).toBe('true');
  expect(step('code').querySelector('button').getAttribute('aria-expanded')).toBe('false');
});

it('keeps chunk evidence and logs behind disclosures without hiding chunk failures', async () => {
  await render({
    steps: [
      {
        phase: 'code',
        label: '代码分析',
        status: 'failed',
        log: 'executor log',
        chunks: [
          {
            status: 'failed',
            sessionId: 'child-session',
            tokens: 90000,
            error: 'EXECUTION_ERROR',
            files: ['src/controller/SupplierController.java'],
          },
        ],
      },
    ],
  });
  const area = step('code');
  const chunkToggle = area.querySelector('[aria-haspopup="dialog"]');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(area.textContent).toContain('1 个代码文件');
  expect(area.textContent).not.toContain('90.0k tokens');
  expect(area.textContent).toContain('子代理执行出错');
  await act(async () => chunkToggle.click());
  const openedDetail = document.querySelector('[role="dialog"]');
  expect(openedDetail).not.toBeNull();
  expect(openedDetail.textContent).toContain('child-session');
  expect(openedDetail.textContent).toContain('src/controller/SupplierController.java');
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    ),
  );
  const logToggle = [...area.querySelectorAll('button')].find((node) =>
    node.textContent.includes('执行日志'),
  );
  expect(logToggle.getAttribute('aria-expanded')).toBe('false');
  await act(async () => logToggle.click());
  expect(document.getElementById(logToggle.getAttribute('aria-controls')).hidden).toBe(false);
});

it('retains artifact preview identity and avoids duplicate phase files', async () => {
  const onViewFile = vi.fn();
  const artifact = { phase: 'edit', fileName: 'design.md', artifactId: 'artifact:design' };
  await render({
    steps: [{ phase: 'edit', label: '编辑', status: 'completed', files: ['design.md'] }],
    generatedFiles: [artifact],
    onViewFile,
  });
  await act(async () => step('edit').querySelector('button').click());
  const artifactButton = [...step('edit').querySelectorAll('button')].find(
    (button) => button.textContent === 'design.md',
  );
  expect(artifactButton).toBeDefined();
  await act(async () => artifactButton.click());
  expect(onViewFile).toHaveBeenCalledWith(artifact);
});

it('labels failed and queued steps with sync step copy without old KnowledgePanel strings', async () => {
  await render({
    steps: [
      { phase: 'code', label: '代码分析', status: 'failed' },
      { phase: 'edit', label: '编辑', status: 'pending' },
    ],
  });
  expect(step('code').textContent).toContain('失败');
  expect(step('edit').textContent).toContain('排队中');
  expect(container.textContent).not.toContain('知识库内容');
});

it('does not expose expansion controls for steps with no extra content', async () => {
  await render({
    steps: [
      { phase: 'init', status: 'completed', text: '无提交记录，输入预算检查通过' },
      { phase: 'merge', status: 'running' },
      { phase: 'validate', status: 'pending' },
    ],
  });
  expect(container.querySelector('[aria-expanded]')).toBeNull();
  expect(container.textContent).toContain('已确认同步范围，准备工作已完成');
  expect(container.textContent).not.toContain('输入预算检查通过');
  expect(container.textContent).not.toContain('展开');
});

it('shows source scope and a short task list without pagination or technical jargon', async () => {
  await render({
    task: { id: 'scope', hasUncommitted: true, sessionIds: ['conversation'] },
    steps: [
      { phase: 'init', status: 'completed' },
      {
        phase: 'code_analysis',
        status: 'running',
        chunks: [{ status: 'running', files: ['a.js'], tokens: 90000 }],
      },
    ],
  });
  expect(container.textContent).toContain('工作区中尚未提交的修改');
  expect(container.textContent).toContain('1 个会话');
  expect(container.textContent).toContain('分析任务 1');
  expect(container.querySelector('nav')).toBeNull();
  expect(container.querySelector('[data-paged-list]')).toBeNull();
  expect(container.textContent).not.toContain('90000');
});

it('keeps all file metadata available through scrolling and restores focus after closing', async () => {
  const files = Array.from({ length: 45 }, (_, i) => ({ file: `src/long/path/File${i}.java` }));
  await render({
    steps: [{ phase: 'code_analysis', status: 'running', chunks: [{ files, status: 'running' }] }],
  });
  const trigger = container.querySelector('[aria-haspopup="dialog"]');
  trigger.focus();
  await act(async () => trigger.click());
  const dialog = document.querySelector('[role="dialog"]');
  const list = dialog.querySelector('[data-rh-scroll-list]');
  expect(dialog.textContent).toContain('45 个代码文件');
  expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(20);
  await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
  expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(40);
  await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
  expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(45);
  expect(list.textContent).toContain('src/long/path/File44.java');
  expect(dialog.textContent).not.toContain('+12');
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
