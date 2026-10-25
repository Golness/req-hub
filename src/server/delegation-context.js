import { AsyncLocalStorage } from 'node:async_hooks';

// Only the Host's subagents.start call can publish this identity. User text is
// never used as an authority to associate an LLM request with a runtime.
export const delegationContext = new AsyncLocalStorage();
export function bindOwnedSession(runtime, sessionId) {
  if (!sessionId || runtime.closed || runtime.sessionId && runtime.sessionId !== sessionId) throw new Error('DELEGATION_SESSION_DENIED');
  runtime.sessionId = sessionId;
  runtime.bindSession?.(sessionId);
}

/** Associate only a published Host child of the delegating parent, never a
 * background title/model request that happens to share the async call chain. */
export function runtimeForRequest(ctx, runtimes, request) {
  const runtime = delegationContext.getStore();
  if (!runtime || runtimes.get(runtime.id) !== runtime || !request.sessionId || !runtime.parentSessionId) return;
  const child = ctx.agents?.get(request.sessionId);
  if (child?.session?.header?.parentSession !== runtime.parentSessionId) return;
  bindOwnedSession(runtime, request.sessionId);
  return runtime;
}
