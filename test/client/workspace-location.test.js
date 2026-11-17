// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const {
  TabBodyWrapper: ViewerComponent,
} = require('../../src/client/components/TabBodyWrapper.js');

const { SessionSelectionContext } = require('../../src/client/context.js');
let selectedSession = () => null;
function TabBodyWrapper(props) {
  return React.createElement(
    SessionSelectionContext.Provider,
    { value: () => selectedSession() },
    React.createElement(ViewerComponent, props),
  );
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const workspaces = [
  { id: 'first', title: 'First workspace', path: 'D:/first' },
  { id: 'second', title: 'Second workspace', path: 'D:/second' },
];
const requirement = {
  id: '2026-11-03-orders',
  title: 'Orders',
  path: 'alice/2026-11-03-orders',
};
const fallback = { id: '2026-10-01-other', title: 'Other', path: 'alice/2026-10-01-other' };
const response = (data) => ({ ok: true, json: async () => data });
let root, container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  selectedSession = () =>
    ({
      get: () => ({ selection: { getSnapshot: () => ({ sessionId: 'current' }) } }),
    })
      .get('uiWorkspace')
      ?.selection?.getSnapshot()?.sessionId || null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  selectedSession = () => null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup({
  branch = 'feature/alice/2026-11-03-orders',
  requirements = [fallback, requirement],
} = {}) {
  let config = { workspaceId: 'first', docsDir: 'docs' };
  let resolveBranch;
  const branchResult = new Promise((resolve) => {
    resolveBranch = () => resolve(response({ branch }));
  });
  const fetch = vi.fn(async (url, options) => {
    const parsed = new URL(String(url), 'http://localhost');
    const path = parsed.pathname;
    if (path.endsWith('/workspaces')) {
      return response(workspaces);
    }
    if (path.endsWith('/config')) {
      if (options?.method === 'POST') {
        config = { ...config, ...JSON.parse(options.body) };
      }
      return response(config);
    }
    if (path.endsWith('/session-info')) {
      return response({ session: { cwd: 'D:\\second' } });
    }
    if (path.endsWith('/git-branch')) {
      return branchResult;
    }
    if (path.endsWith('/tree')) {
      return response({ tree: { developers: [{ name: 'alice', requirements }] } });
    }
    if (path.endsWith('/create-status')) {
      return response({ branch, existingRequirement: null });
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, resolveBranch };
}

const mount = () => act(async () => root.render(React.createElement(TabBodyWrapper)));
const locate = () =>
  act(async () => container.querySelector('[aria-label="定位到当前会话需求"]').click());
const topbar = () => container.querySelector('.rh-topbar');

it('finishes a delayed location before switching keyed workspaces and selects the matching directory on one click', async () => {
  const { fetch, resolveBranch } = setup();
  await mount();
  await locate();
  expect(topbar().textContent).toContain('First workspace');
  await act(async () => resolveBranch());
  expect(topbar().textContent).toContain('Second workspace');
  expect(topbar().querySelector(`[aria-label="需求目录: ${requirement.path}"]`)).not.toBeNull();
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/session-info?'))).toHaveLength(
    1,
  );
  const saves = fetch.mock.calls
    .filter(([, options]) => options?.method === 'POST')
    .map(([, options]) => JSON.parse(options.body));
  expect(saves).toContainEqual({
    workspaceId: 'second',
    developerName: 'alice',
    requirementId: requirement.id,
  });
});

it('carries an unrecognized branch into the new workspace creation page without selecting a fallback directory', async () => {
  const { resolveBranch } = setup({ branch: 'main' });
  await mount();
  await locate();
  await act(async () => resolveBranch());
  expect(topbar().textContent).toContain('Second workspace');
  expect(topbar().textContent).not.toContain('Other');
  expect([...container.querySelectorAll('code')].some((node) => node.textContent === 'main')).toBe(
    true,
  );
});

it('carries a missing requirement confirmation across the workspace remount', async () => {
  const { resolveBranch } = setup({ requirements: [fallback] });
  await mount();
  await locate();
  await act(async () => resolveBranch());
  expect(topbar().textContent).toContain('Second workspace');
  expect(topbar().textContent).not.toContain('Other');
  expect(document.querySelector('[role="dialog"]').textContent).toContain(requirement.id);
});

it('does not apply a delayed location after the user manually switches workspaces', async () => {
  const { fetch, resolveBranch } = setup();
  await mount();
  await locate();
  await act(async () => container.querySelector('[aria-label="工作区: First workspace"]').click());
  const target = [...document.querySelectorAll('[role="dialog"] button')].find(
    (button) => button.textContent === 'Second workspace',
  );
  await act(async () => target.click());
  expect(topbar().textContent).toContain('Second workspace');
  await act(async () => resolveBranch());
  expect(topbar().textContent).toContain('Other');
  expect(
    fetch.mock.calls.some(
      ([, options]) =>
        options?.method === 'POST' && JSON.parse(options.body).requirementId === requirement.id,
    ),
  ).toBe(false);
});

it('transfers report artifact navigation across the keyed workspace remount', async () => {
  const { fetch } = setup();
  const fallbackFetch = fetch.getMockImplementation();
  fetch.mockImplementation(async (url, options) => {
    const parsed = new URL(String(url), 'http://localhost');
    if (parsed.pathname.endsWith('/task-reports')) {
      if (!parsed.searchParams.has('id'))
        return response({
          items: [
            {
              id: 'report',
              status: 'completed',
              day: '2026-11-04',
              startedAt: '2026-11-04T03:00:00Z',
            },
          ],
        });
      return response({
        id: 'report',
        status: 'completed',
        workspaces: [
          {
            id: 'second',
            title: 'Second workspace',
            items: [
              {
                key: 'branch',
                kind: 'branch',
                status: 'completed',
                branch: 'feature/alice/' + requirement.id,
                tasks: [
                  {
                    id: 'sync',
                    workspaceId: 'second',
                    requirementId: requirement.id,
                    requirementPath: requirement.path,
                    docType: 'design',
                    status: 'completed',
                    snapshotDir: 'snapshot',
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    if (parsed.pathname.endsWith('/read'))
      return response({ content: '# Report artifact', type: 'md' });
    return fallbackFetch(url, options);
  });
  await mount();
  const button = (text) =>
    [...container.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
  await act(async () => button('任务报告').click());
  await act(async () => button('报告详情').click());
  await act(async () => button('产物').click());
  expect(topbar().textContent).toContain('Second workspace');
  expect(topbar().querySelector(`[aria-label="需求目录: ${requirement.path}"]`)).not.toBeNull();
  expect(
    fetch.mock.calls.some(([url]) => {
      const parsed = new URL(String(url), 'http://localhost');
      return (
        parsed.pathname.endsWith('/read') &&
        parsed.searchParams.get('workspaceId') === 'second' &&
        parsed.searchParams.get('path') === requirement.path + '/design.md'
      );
    }),
  ).toBe(true);
});
