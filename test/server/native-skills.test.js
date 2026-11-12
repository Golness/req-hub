import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeTask } from '../../src/server/task-executor.js';
const dsh = resolve(import.meta.dirname, '../../../deepseek-harness');
const available = existsSync(join(dsh, 'packages/skill/tool-skill/lib/index.js'));
const load = (file) => import(/* @vite-ignore */ pathToFileURL(file).href);

it.skipIf(!available).each([true, false])(
  'loads bound skills through the real DSH spawn pipeline (tool-skill installed: %s)',
  async (installed) => {
    const requireHost = createRequire(
      join(dsh, 'packages/test-support/agent-loop-testkit/package.json'),
    );
    const requireSpawn = createRequire(
      join(dsh, 'packages/subagent/subagent-spawn-in-process/package.json'),
    );
    const { Context } = await load(requireHost.resolve('@deepseek-ai/cordis'));
    const { LlmAdapter } = await load(requireHost.resolve('@deepseek-ai/dsh-llm'));
    const { mountAgentLoopTestDependencies } = await load(
      join(dsh, 'packages/test-support/agent-loop-testkit/lib/index.js'),
    );
    const { default: AgentLoop } = await load(requireHost.resolve('@deepseek-ai/dsh-agent-loop'));
    const { default: Subagents } = await load(requireSpawn.resolve('@deepseek-ai/dsh-subagent'));
    const Spawn = await load(join(dsh, 'packages/subagent/subagent-spawn-in-process/lib/index.js'));
    const { default: Skills } = await load(join(dsh, 'packages/skill/skill/lib/index.js'));
    const ToolSkill = await load(join(dsh, 'packages/skill/tool-skill/lib/index.js'));
    const body = 'Preserve uncertain statements. Native skill receipt fixture.';
    const requests = [];
    const observed = [];
    class Adapter extends LlmAdapter {
      async resolveModel(provider, model) {
        return { provider, id: model, name: model, context: { contextWindow: 256000 } };
      }
      async *stream(request) {
        requests.push(request);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Done' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    const ctx = new Context();
    try {
      await mountAgentLoopTestDependencies(ctx);
      await ctx.plugin(AgentLoop, { agents: [] });
      await ctx.plugin(Subagents);
      await ctx.plugin(Spawn, { providerName: 'spawn' });
      await ctx.plugin(Skills);
      if (installed) await ctx.plugin(ToolSkill);
      ctx.skills.register({
        name: 'asd-ste100',
        description: 'Native invocation fixture',
        source: 'runtime',
        invocation: { userInvocable: true, modelInvocable: false },
        content: body,
        resourceBase: { kind: 'directory', path: '/scoped/skill-resources' },
      });
      ctx.llm.registerAdapter(['mock'], new Adapter());
      ctx.tools.register({
        name: 'req_hub_fixture',
        description: 'Scoped task capability',
        parameters: { type: 'object', properties: {} },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async () => 'fixture',
      });
      ctx.provide('sessionQuery', {
        observeSession: async (id) => {
          const session = ctx.sessions.get(id);
          const events = session.snapshotEvents();
          observed.push(...events);
          return { header: session.header, events, [Symbol.dispose]() {} };
        },
      });
      const parent = await ctx.agentLoop.create(
        'native-skill-parent',
        { provider: 'mock', model: 'mock' },
        { cwd: process.cwd() },
      );
      const result = await executeTask(
        ctx,
        ctx.llm,
        {},
        {
          parentAgent: parent,
          promptKey: 'writing',
          cwd: process.cwd(),
          variables: {
            runtimeId: 'fixture',
            docTypeName: 'requirement',
            scopes: '[]',
            instruction: 'Keep the original facts.',
            content: '# Frozen draft',
          },
          toolFilter: { allow: ['req_hub_fixture'] },
          liveness: { enabled: false },
        },
      );
      expect(result.isError, result.diagnostic).toBe(false);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0].messages)).toContain('Language contract:');
      expect(JSON.stringify(requests[0].messages)).toContain('Only final deliverable content uses');
      expect(requests[0].tools.some((tool) => tool.name === 'skill')).toBe(false);
      expect(requests[0].tools.every((tool) => tool.name === 'req_hub_fixture')).toBe(true);
      const receipt = observed.find(
        (event) => event.type === 'user/message' && event.data.source?.kind === 'skill-invocation',
      );
      if (installed) {
        expect(receipt?.data.source).toMatchObject({ name: 'asd-ste100', form: 'instructions' });
        expect(JSON.stringify(requests[0].messages)).toContain(body);
        expect(JSON.stringify(requests[0].messages)).toContain('/scoped/skill-resources');
        expect(result.skillUsed).toBe('asd-ste100');
        expect(result.skillStatus).toBe('loaded');
        const delegated = observed.find(
          (event) => event.type === 'user/message' && event.data.source?.kind === 'user',
        );
        expect(delegated.data.content[0].text).toMatch(/^\/asd-ste100\n/);
        expect(delegated.data.content[0].text).not.toContain(body);
      } else {
        expect(receipt).toBeUndefined();
        expect(JSON.stringify(requests[0].messages)).not.toContain(body);
        expect(result.skillUsed).toBeNull();
        expect(result.skillStatus).toBe('unavailable');
        expect(result.warnings.some((warning) => warning.code === 'NATIVE_SKILL_NOT_LOADED')).toBe(
          true,
        );
      }
    } finally {
      await ctx.fiber.dispose();
    }
  },
  20000,
);

