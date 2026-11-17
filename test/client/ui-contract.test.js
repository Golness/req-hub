// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
const require = createRequire(import.meta.url),
  React = require('react'),
  { act } = React;
const { createRoot } = require('react-dom/client');
const { Button } = require('../../src/client/components/shared/Button.js');
const { WorkspaceModal } = require('../../src/client/components/WorkspaceModal.js');
const {
  ToastContainer,
  showToast,
} = require('../../src/client/components/shared/ToastContainer.js');
const { t, installLocale } = require('../../src/client/locale.js');
const zh = require('../../src/client/locales/zh.js');
const en = require('../../src/client/locales/en.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, container;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = null;
  vi.useRealTimers();
});
async function render(element) {
  if (!root) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root.render(element));
}
it('maps action roles and compact sizing to the host Button', async () => {
  await render(
    React.createElement(
      Button,
      { className: 'rh-btn rh-btn-ghost rh-btn-sm', disabled: true },
      t('common.save'),
    ),
  );
  expect(container.querySelector('button').dataset).toMatchObject({
    rhButton: 'ghost',
    rhSize: 'sm',
  });
  expect(container.querySelector('button').disabled).toBe(true);
});

it('keeps semantic action tones in shared controls for both explicit and legacy callers', async () => {
  await render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Button, { tone: 'danger' }, 'Delete'),
      React.createElement(Button, { tone: 'warning' }, 'Stop'),
      React.createElement(Button, { tone: 'business' }, 'Retry'),
      React.createElement(Button, { className: 'rh-btn-danger' }, 'Legacy delete'),
    ),
  );
  expect([...container.querySelectorAll('button')].map((button) => button.dataset.rhTone)).toEqual([
    'danger',
    'warning',
    'business',
    'danger',
  ]);
  const style = readFileSync(
    resolve(import.meta.dirname, '../../src/client/components/shared/controls.module.css'),
    'utf8',
  );
  for (const token of ['state-error-primary', 'state-warn-label', 'state-business-primary']) {
    expect(style).toContain(`var(--dsw-alias-${token})`);
  }
  expect(style).not.toMatch(/\.dark\b|data-theme|#[\da-f]{3,8}\b/);
});

it('keeps sync action alignment and compact lists on the shared layout contract', () => {
  for (const [file, selector] of [
    ['SyncProgress.module.css', 'footer'],
    ['SyncSetup.module.css', 'footer'],
    ['SyncSetup.module.css', 'start'],
    ['SyncHistory.module.css', 'recordActions'],
  ]) {
    const style = readFileSync(
      resolve(import.meta.dirname, `../../src/client/components/${file}`),
      'utf8',
    );
    const body = new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`).exec(style)?.[1] || '';
    expect(body, `${file}: use the shared ActionBar for control layout`).not.toMatch(
      /(?:padding|gap|justify-content|height|min-height)\s*:/,
    );
  }
  const steps = readFileSync(
    resolve(import.meta.dirname, '../../src/client/components/SyncSteps.js'),
    'utf8',
  );
  expect(steps).not.toContain('PagedList');
  const details = readFileSync(
    resolve(import.meta.dirname, '../../src/client/components/SyncChunkDetails.js'),
    'utf8',
  );
  expect(details).not.toContain('.slice(');
  for (const path of files(client).filter((path) => /\.(js|css)$/.test(path))) {
    expect(readFileSync(path, 'utf8'), path).not.toContain('--dsw-alias-state-warning-primary');
  }
});
it('delegates modal dismissal and selection to the host dialog without nesting custom masks', async () => {
  const onClose = vi.fn(),
    onSelect = vi.fn();
  await render(
    React.createElement(WorkspaceModal, {
      workspaces: [{ id: 'one', title: 'Fixture' }],
      selectedId: 'one',
      onClose,
      onSelect,
    }),
  );
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('.rh-modal-overlay')).toBeNull();
  await act(async () =>
    [...document.querySelectorAll('[role="dialog"] button')]
      .find((button) => button.textContent === 'Fixture')
      .click(),
  );
  expect(onSelect).toHaveBeenCalledWith({ id: 'one', title: 'Fixture' });
  expect(onClose).toHaveBeenCalled();
});
it('keeps host toasts alive while the reporting operation panel is replaced', async () => {
  vi.useFakeTimers();
  const page = (text) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ToastContainer),
      React.createElement('main', null, text),
    );
  await render(page('first'));
  await act(async () => showToast({ text: 'Fixture toast', tone: 'success', holdMs: 2000 }));
  await act(async () => showToast({ text: 'Next outcome', tone: 'error', holdMs: 2000 }));
  await render(page('second'));
  expect(document.querySelectorAll('[data-rh-toast]')).toHaveLength(1);
  expect(document.querySelector('[data-rh-toast]').textContent).toContain('Fixture toast');
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(document.querySelector('[data-rh-toast]').textContent).toContain('Next outcome');
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(document.querySelector('[data-rh-toast]')).toBeNull();
});
it('registers the plugin-owned namespace and preserves Chinese fallback and interpolation', () => {
  const dispose = vi.fn(),
    register = vi.fn(() => dispose);
  const stop = installLocale({
    locale: { register, bind: () => (key) => (key === 'common.save' ? 'Host translation' : key) },
  });
  try {
    expect(register).toHaveBeenCalledWith('reqHub', { zh, en });
    expect(t('common.save')).toBe('Host translation');
    expect(t('SessionList.message004', { value0: 4, value1: 3 })).toContain('4');
    expect(t('common.cancel')).toBe(zh['common.cancel']);
  } finally {
    stop();
  }
  expect(dispose).toHaveBeenCalledOnce();
  expect(t('common.save')).toBe(zh['common.save']);
});
it('owns notifications in the shell overlay rather than a workspace panel', () => {
  const entry = require('../../src/client/index.js');
  const slots = [];
  const ctx = {
    effect: (factory) => factory(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, setup) => setup(),
      register: (options, component) => {
        slots.push({ options, component });
        return () => {};
      },
    },
    sidebarRightTabs: { register: () => () => {} },
  };
  const stop = entry.apply(ctx);
  try {
    expect(entry.inject).toContain('locale');
    expect(slots.find((slot) => slot.options.name === 'shell.overlay')?.component).toBe(
      ToastContainer,
    );
  } finally {
    stop();
  }
});

it('prompts for a mounted session and opens the panel after a session becomes available', async () => {
  const entry = require('../../src/client/index.js');
  const slots = [];
  let sessionId;
  const openTab = vi.fn();
  const ctx = {
    effect: (factory) => factory(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, setup) => setup(),
      register: (options, component) => {
        slots.push({ options, component });
        return () => {};
      },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { mounted: { getSnapshot: () => sessionId }, openTab },
  };
  const stop = entry.apply(ctx);
  try {
    const Trigger = slots.find((slot) => slot.options.id === 'req-hub-trigger').component;
    await render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ToastContainer),
        React.createElement(Trigger, { wide: false }),
      ),
    );
    const button = container.querySelector('button');
    await act(async () => button.click());
    expect(openTab).not.toHaveBeenCalled();
    expect(document.querySelector('[data-rh-toast]').textContent).toContain(
      t('trigger.sessionRequired'),
    );
    sessionId = 'mounted-session';
    await act(async () => button.click());
    expect(openTab).toHaveBeenCalledOnce();
    expect(openTab).toHaveBeenCalledWith(require('../../src/client/constants.js').TAB_KIND);
    sessionId = undefined;
    await act(async () => button.click());
    expect(openTab).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it('renders incompatible retry diagnostics without crashing the sync status surface', async () => {
  const { SyncStatusBar } = require('../../src/client/components/SyncStatusBar.js');
  await render(
    React.createElement(SyncStatusBar, {
      monitor: {
        notification: {
          id: 'failed-retry',
          requirementId: 'fixture',
          status: 'failed',
          error: 'SYNC_RETRY_INPUT_CHANGED: code-0；SYNC_RETRY_INPUT_CHANGED: discussion-0',
        },
        dismiss: vi.fn(),
      },
      onOpen: vi.fn(),
    }),
  );
  expect(container.querySelector('[role="status"]').textContent).toContain('请重新发起同步');
  expect(container.textContent).toContain('code-0');
  expect(container.textContent).toContain('discussion-0');
});

const client = resolve(import.meta.dirname, '../../src/client');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
it('keeps Host URLs, transport readers and context ownership inside their declared boundaries', () => {
  const violations = [];
  for (const path of files(client).filter((path) => /\.js$/.test(path))) {
    const source = readFileSync(path, 'utf8');
    if (/__DSH_CTX__/.test(source)) violations.push(path + ': global ctx');
    if (!path.startsWith(join(client, 'api') + sep)) {
      if (
        /\bfetch\s*\(|\.getReader\s*\(|\bROUTE\b/.test(source) &&
        path !== join(client, 'constants.js')
      ) {
        violations.push(path + ': API transport');
      }
    }
  }
  expect(violations).toEqual([]);
});
it('preserves destination names and safe diagnostic parameters in both dictionaries', () => {
  const parameters = {
    'lark.browseChoose': ['title'],
    'lark.browseOpen': ['title'],
    'lark.browseSelected': ['path'],
    'lark.removeWorkspaceBinding': ['name'],
    'lark.workspaceUnbound': ['name'],
    'lark.workspaceList': ['count'],
    'lark.spacePage': ['page'],
    'lark.defaultWikiResult': ['created', 'reused', 'total'],
    'lark.defaultWikiBatchFailure': ['completed', 'created', 'name', 'total'],
    'lark.errorCode': ['code'],
    'lark.errorExitCode': ['code'],
    'lark.errorFilesystem': ['reason'],
    'lark.errorIdentity': ['identity'],
    'lark.errorScopes': ['scopes'],
    'lark.errorStage': ['stage'],
  };
  for (const dictionary of [zh, en]) {
    for (const [key, expected] of Object.entries(parameters)) {
      expect(
        [...dictionary[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(),
        key,
      ).toEqual(expected);
    }
    for (const stage of [
      'workspace-path',
      'configuration',
      'authentication',
      'list-nodes',
      'create-node',
      'verify-node',
      'save-bindings',
    ]) {
      expect(dictionary[`lark.stage.${stage}`]).toBeTruthy();
    }
    for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ENOSPC']) {
      expect(dictionary[`lark.filesystem.${code}`]).toBeTruthy();
    }
  }
});
it('keeps fixed presentation out of React style objects and feature weights within 500', () => {
  const violations = [];
  for (const path of files(client).filter((path) => /\.(?:js|mjs|css)$/.test(path))) {
    const text = readFileSync(path, 'utf8');
    if (/font-weight:\s*(?:[6-9]00|bold)\b|fontWeight:\s*[6-9]00\b/.test(text))
      violations.push(path + ': weight');
    if (/style:\s*\{\s*[a-zA-Z_$][\w$]*\s*:/.test(text)) violations.push(path + ': static style');
  }
  expect(violations).toEqual([]);
});
it('resolves every component message through the owned dictionary', () => {
  const missing = [],
    hardcoded = [];
  for (const path of files(join(client, 'components')).filter((path) => /\.(js|mjs)$/.test(path))) {
    const text = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const match of text.matchAll(/\bt\(['"]([^'"]+)['"]/g))
      if (!(match[1] in zh)) missing.push(match[1]);
    if (/[\u3400-\u9fff]/.test(text)) hardcoded.push(path);
  }
  expect(missing).toEqual([]);
  expect(hardcoded).toEqual([]);
});

it('loads no Harness Client runtime packages in source or built output', () => {
  const violations = [];
  for (const path of files(client).filter((path) => /\.(?:js|mjs|cjs)$/.test(path))) {
    if (
      /(?:require|import)\s*\(\s*['"]@deepseek-ai\/dsh-client-|from\s*['"]@deepseek-ai\/dsh-client-/.test(
        readFileSync(path, 'utf8'),
      )
    )
      violations.push(path);
  }
  const built = resolve(client, '../../lib/client.js');
  if (
    existsSync(built) &&
    /(?:require|import)\s*\(\s*['"]@deepseek-ai\/dsh-client-/.test(readFileSync(built, 'utf8'))
  )
    violations.push(built);
  expect(violations).toEqual([]);
});
it('exposes full long directory and breadcrumb labels on focus without changing navigation', async () => {
  const { TopBar } = require('../../src/client/components/TopBar.js');
  const { Breadcrumb } = require('../../src/client/components/shared/Breadcrumb.js');
  const label = '2026-10-28-' + 'LongRequirementSTAndTPM'.repeat(12),
    change = vi.fn();
  await render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(TopBar, {
        docsDir: 'docs',
        currentWorkspace: { id: 'w', title: 'Work' },
        currentReq: { id: label, title: label, date: '2026-10-28' },
        onChangeReq: change,
      }),
      React.createElement(Breadcrumb, {
        items: [{ label, onClick: change }, { label: 'requirement.md' }],
      }),
    ),
  );
  const directory = [...container.querySelectorAll('.rh-topbar-value')].find((node) =>
    node.textContent.includes(label),
  );
  await act(async () => directory.focus());
  expect(document.querySelector('[role=tooltip]').textContent).toBe(label);
  await act(async () => directory.click());
  expect(change).toHaveBeenCalledTimes(1);
  const breadcrumb = container.querySelector('.rh-breadcrumb-link');
  await act(async () => breadcrumb.focus());
  expect(
    [...document.querySelectorAll('[role=tooltip]')].some((node) => node.textContent === label),
  ).toBe(true);
  await act(async () => breadcrumb.click());
  expect(change).toHaveBeenCalledTimes(2);
});
