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
    { phase: 'init', label: '同步检查', status: 'completed' },
    { phase: 'code', label: '代码分析', status: 'running' },
    { phase: 'edit', label: '编辑', status: 'pending' },
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
  const chunkToggle = [...area.querySelectorAll('button')].find((node) =>
    node.textContent.includes('块 1'),
  );
  const detail = document.getElementById(chunkToggle.getAttribute('aria-controls'));
  expect(detail.hidden).toBe(true);
  expect(chunkToggle.textContent).toContain('输入预算 90.0k tokens');
  expect(area.textContent).toContain('子代理执行出错');
  await act(async () => chunkToggle.click());
  expect(detail.hidden).toBe(false);
  expect(detail.textContent).toContain('child-session');
  expect(detail.textContent).toContain('src/controller/SupplierController.java');
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
  expect(step('edit').querySelectorAll('a')).toHaveLength(1);
  await act(async () => step('edit').querySelector('a').click());
  expect(onViewFile).toHaveBeenCalledWith(artifact);
});
