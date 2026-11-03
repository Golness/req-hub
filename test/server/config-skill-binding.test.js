import { it, expect, vi } from 'vitest';
const save = vi.hoisted(() => vi.fn());
vi.mock('../../src/server/config.js', () => ({
  loadConfig: async () => ({ workspaceId: 'saved', ai: { skillBindings: { writing: null } } }),
  autoDefaultConfig: async (config) => config,
  saveConfig: save,
}));
import { createConfigRoutes } from '../../src/server/routes/config-routes.js';
it('discovers effective bindings in the same live session and workspace scope without saving them', async () => {
  const parent = { session: { id: 'parent' } };
  const get = vi.fn(async (_name, lookup) => {
    expect(lookup).toMatchObject({ cwd: '/active', scope: parent });
    return {
      content: 'Keep original facts.',
      invocation: { userInvocable: true, modelInvocable: false },
    };
  });
  const globalGet = vi.fn();
  const routes = createConfigRoutes(
    {
      list: () => [
        { id: 'saved', path: '/saved' },
        { id: 'active', path: '/active' },
      ],
    },
    {},
    {
      agents: { get: (id) => (id === 'parent' ? parent : null) },
      agentPresets: {
        serviceFor: (agent) => {
          expect(agent).toBe(parent);
          return { get };
        },
      },
      skills: { get: globalGet },
    },
  );
  let body;
  const response = {
    writeHead: vi.fn(),
    end: (text) => {
      body = JSON.parse(text);
    },
  };
  await routes
    .find((route) => route.path === '/req-hub/config')
    .handler(
      { method: 'GET', headers: { 'x-session-id': 'parent', 'x-workspace-id': 'active' } },
      response,
    );
  expect(body.ai.skillBindings.writing).toBeNull();
  expect(body.ai.syncV2.skillBindings['phased-discussion-analysis-requirement']).toBe('asd-ste100');
  expect(get).toHaveBeenCalledOnce();
  expect(globalGet).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
