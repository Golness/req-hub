import { vi } from 'vitest';

/** Install the public Host creation contract without relying on a live user Agent. */
export function installWorkspaceTaskAgents(ctx) {
  ctx.agentDefaultModel = { currentSelection: () => ({ provider: 'test', model: 'test' }) };
  ctx.agentPresets = {
    resolve: async () => ({ id: 'default' }),
    mount: vi.fn(async () => ({ id: 'default' })),
  };
  ctx.agents.create = vi.fn(async (options) => {
    const agent = {
      ctx,
      status: 'idle',
      options: options.agentOptions,
      session: { id: options.sessionId, header: options.meta },
    };
    await options.setup(ctx, agent);
    return {
      agent,
      dispose: vi.fn(async () => {
        agent.status = 'stopped';
      }),
    };
  });
  return ctx;
}
