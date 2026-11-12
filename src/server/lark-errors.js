/**
 * Convert a CLI error envelope into a stable, credential-free failure.
 * @param payload - Bounded stderr JSON or a parsed error envelope.
 * @param identity - Explicit identity from validated connection settings.
 * @returns An Error with safe diagnostic fields; raw messages and hints are discarded.
 */
export function larkCliError(payload, identity) {
  let envelope = payload;
  if (typeof payload === 'string') {
    try {
      envelope = JSON.parse(payload);
    } catch {
      return new Error('LARK_CHECK_FAILED');
    }
  }
  if (envelope?.ok !== false || !envelope.error) {
    return new Error('LARK_CHECK_FAILED');
  }
  const source = envelope.error;
  let code = 'LARK_CHECK_FAILED';
  if (source.subtype === 'app_scope_not_applied' || source.code === 99991672) {
    code = 'LARK_APP_SCOPE_REQUIRED';
  } else if (source.subtype === 'missing_scope') {
    code = identity === 'bot' ? 'LARK_APP_SCOPE_REQUIRED' : 'LARK_USER_SCOPE_REQUIRED';
  } else if (source.type === 'network') {
    code = 'LARK_NETWORK_FAILED';
  } else if (source.type === 'authentication') {
    code = identity === 'user' ? 'LARK_LOGIN_REQUIRED' : 'LARK_AUTH_UNVERIFIED';
  } else if (source.type === 'authorization') {
    code = 'LARK_TARGET_ACCESS_FAILED';
  }
  const failure = new Error(code);
  const scopes = Array.isArray(source.missing_scopes) ? source.missing_scopes : [];
  failure.details = {
    identity,
    upstreamCode: Number.isSafeInteger(source.code) ? source.code : null,
    missingScopes:
      scopes.length <= 32
        ? [
            ...new Set(
              scopes.filter(
                (scope) =>
                  typeof scope === 'string' &&
                  scope.length <= 160 &&
                  /^[a-z][a-z0-9_]*(?::[a-z0-9_.-]+)+$/.test(scope),
              ),
            ),
          ]
        : [],
  };
  return failure;
}
