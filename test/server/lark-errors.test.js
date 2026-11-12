import { expect, it } from 'vitest';
import { larkCliError } from '../../src/server/lark-errors.js';
import { larkTargetCaller } from '../../src/server/lark-target.js';

it('classifies missing scope by the selected identity and filters diagnostic fields', () => {
  const error = larkCliError(
    {
      ok: false,
      error: {
        subtype: 'missing_scope',
        code: 99991679,
        missing_scopes: [
          'drive:drive:readonly',
          'drive:drive:readonly',
          '<script>',
          'private-token',
        ],
        message: 'secret',
        hint: 'private-link',
        access_token: 'credential',
      },
    },
    'bot',
  );
  expect(error.message).toBe('LARK_APP_SCOPE_REQUIRED');
  expect(error.details).toEqual({
    identity: 'bot',
    upstreamCode: 99991679,
    missingScopes: ['drive:drive:readonly'],
  });
  expect(JSON.stringify(error)).not.toMatch(/secret|private|credential|script/);
});

it('handles unknown or non-JSON diagnostics without echoing raw output', () => {
  expect(larkCliError('private raw stderr', 'user').message).toBe('LARK_CHECK_FAILED');
  expect(larkCliError({ error: { message: 'secret' } }, 'user').details).toBeUndefined();
});

it('keeps diagnostics through the target caller for either output channel', async () => {
  const envelope = {
    ok: false,
    error: {
      type: 'authorization',
      subtype: 'app_scope_not_applied',
      code: 99991672,
      missing_scopes: ['drive:drive:readonly'],
    },
  };
  const settings = { profile: '', identity: 'bot' };
  const expected = {
    message: 'LARK_APP_SCOPE_REQUIRED',
    details: {
      identity: 'bot',
      upstreamCode: 99991672,
      missingScopes: ['drive:drive:readonly'],
    },
  };
  await expect(
    larkTargetCaller(settings, async () => JSON.stringify(envelope))([]),
  ).rejects.toMatchObject(expected);
  await expect(
    larkTargetCaller(settings, async () => {
      throw larkCliError(envelope, 'bot');
    })([]),
  ).rejects.toMatchObject(expected);
});
