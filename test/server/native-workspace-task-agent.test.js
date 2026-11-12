import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkspaceTaskAgent } from '../../src/server/workspace-task-agent.js';
const dsh = resolve(import.meta.dirname, '../../../deepseek-harness');
const available = existsSync(join(dsh, 'packages/preset/agent-preset-registry/lib/index.js'));
const load = (file) => import(/* @vite-ignore */ pathToFileURL(file).href);

it.skipIf(!available)(
  'creates and drains a background owner using the real DSH factory and preset',
  async () => {
    const requireHost = createRequire(
      join(dsh, 'packages/test-support/agent-loop-testkit/package.json'),
    );
    const requirePreset = createRequire(
      join(dsh, 'packages/preset/agent-preset-registry/package.json'),
    );
    const { Context } = await load(requireHost.resolve('@deepseek-ai/cordis'));
    const { mountAgentLoopTestDependencies } = await load(
      join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'),
    );
    const { default: AgentLoop } = await load(requireHost.resolve('@deepseek-ai/dsh-agent-loop'));
    const { default: Loader } = await load(
      requirePreset.resolve('@deepseek-ai/cordis-plugin-loader'),
    );
    const { default: Group } = await load(
      requirePreset.resolve('@deepseek-ai/cordis-plugin-group'),
    );
    const { default: Presets } = await load(
      join(dsh, 'packages/preset/agent-preset-registry/lib/index.js'),
    );
    const { default: DefaultModel } = await load(
      join(dsh, 'packages/core/agent-default-model/lib/index.js'),
    );
    const ctx = new Context();
    let handle;
    try {
      await mountAgentLoopTestDependencies(ctx);
      await ctx.plugin(Loader);
      ctx.loader.builtins.group = Group;
      await ctx.plugin(AgentLoop, { agents: [] });
      await ctx.plugin(Presets, { default: 'background' });
      await ctx.plugin(DefaultModel, { provider: 'mock', model: 'mock' });
      await ctx.agentPresets.register({ id: 'background', plugins: [] });
      expect(ctx.agents.list()).toHaveLength(0);
      handle = await createWorkspaceTaskAgent(ctx, { path: dsh }, new AbortController().signal);
      expect(handle.agent.session.header).toMatchObject({ cwd: dsh, origin: 'subagent' });
      expect(ctx.agentPresets.composedPreset(handle.agent.ctx)).toBe('background');
      expect(handle.agent.options).toMatchObject({ provider: 'mock', model: 'mock' });
      const id = handle.agent.session.id;
      expect(ctx.agents.get(id)).toBe(handle.agent);
      await handle.dispose();
      expect(ctx.agents.get(id)).toBeUndefined();
      expect(ctx.sessions.get(id)).toBeUndefined();
    } finally {
      await handle?.dispose();
      await ctx.fiber.dispose();
    }
  },
  20000,
);
