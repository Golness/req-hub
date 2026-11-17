/** Session-log facts used by the controlled sync runtime; task databases remain authoritative. */
export const SYNC_SESSION_PROJECTION = 'req-hub.sync-session-facts';

/**
 * Fold only committed compaction and turn outcomes without mutating an earlier snapshot.
 * @param state - Plain JSON state for the preceding log prefix.
 * @param event - One committed Host session event.
 * @returns The original reference for unrelated or semantically unchanged events.
 */
export function foldSyncSessionFacts(state, event) {
  if (['compaction/prune', 'compaction/summary'].includes(event.type)) {
    return state.compacted ? state : { ...state, compacted: true };
  }
  if (event.type === 'turn/start') {
    return state.failure ? { ...state, failure: null } : state;
  }
  if (event.type !== 'turn/end' || event.data?.reason?.kind !== 'error') {
    return state;
  }
  const error = event.data.reason.error;
  const failure = { code: error?.code || null, message: error?.message || null };
  if (state.failure?.code === failure.code && state.failure?.message === failure.message) {
    return state;
  }
  return { ...state, failure };
}

/**
 * Register a host-only, replayable pilot using the registry's parse/init/apply contract.
 * @param registry - The injected sessionProjections service.
 * @returns A registration disposer, or undefined for isolated non-Host adapters.
 */
export function installSyncSessionProjection(registry) {
  if (!registry?.register || !registry.stateOf) {
    return;
  }
  return registry.register({
    key: SYNC_SESSION_PROJECTION,
    stateVersion: 1,
    stateSchema: {
      parse(value) {
        const validFailure =
          value?.failure === null ||
          (value?.failure &&
            ['code', 'message'].every(
              (key) => value.failure[key] === null || typeof value.failure[key] === 'string',
            ));
        if (typeof value?.compacted !== 'boolean' || !validFailure) {
          throw new Error('SYNC_PROJECTION_STATE_INVALID');
        }
        return { compacted: value.compacted, failure: value.failure && { ...value.failure } };
      },
    },
    init: () => ({ compacted: false, failure: null }),
    apply: foldSyncSessionFacts,
  });
}
