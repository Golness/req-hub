/**
 * Register against a published child's context; both plugin and Agent may revoke the listener.
 * @param ctx - Plugin-owned Host context used only for lookup and legacy adapter fallback.
 * @param sessionId - Child identity already authorized by bindOwnedSession.
 * @param event - Scoped Agent event supported by the current Host contract.
 * @param listener - Handler that retains its runtime ownership and cancellation guards.
 * @returns An idempotent disposer retained by the plugin runtime.
 */
export function ownedAgentListener(ctx, sessionId, event, listener) {
  const agent = ctx.agents?.get?.(sessionId);
  const scopedListener = (payload) => {
    if (payload.agent?.session?.id === sessionId) {
      return listener(payload);
    }
  };
  // Legacy adapters expose no scoped context; their handlers still filter exact owned sessions.
  const dispose = agent?.ctx?.on
    ? agent.ctx.on(event, scopedListener)
    : ctx.on(event, scopedListener, { global: true });
  let active = true;
  return () => {
    if (active) {
      active = false;
      dispose();
    }
  };
}
