import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

/**
 * Create an independent, empty delegation owner in exactly one authorized workspace.
 * The caller must await dispose after all delegated work has stopped.
 * @param ctx - Host services accessed through the plugin's owning context.
 * @param workspace - Authorized workspace entity.
 * @param signal - Task lifetime cancellation, including asynchronous creation.
 * @returns An owned Agent handle; no visible user session is resumed or borrowed.
 */
export async function createWorkspaceTaskAgent(ctx, workspace, signal) {
  signal.throwIfAborted();
  const cwd = await realpath(workspace.path);
  signal.throwIfAborted();
  const preset = await ctx.agentPresets.resolve();
  const selection = ctx.agentDefaultModel.currentSelection();
  const handle = await ctx.agents.create({
    sessionId: `reqhub-background-${randomUUID()}`,
    signal,
    meta: { cwd, agentPreset: preset.id, origin: 'subagent' },
    agentOptions: { ...selection },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, preset.id);
    },
  });
  try {
    signal.throwIfAborted();
    return handle;
  } catch (error) {
    await handle.dispose();
    throw error;
  }
}
