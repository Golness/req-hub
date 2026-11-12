/**
 * Verify an internal application's credentials without changing CLI storage.
 * @param input - App ID, secret and official service brand; never persisted here.
 * @param timeoutMs - Maximum duration including reading the response body.
 * @param signal - Request and plugin lifetime cancellation.
 * @returns Completion after verification; tokens and upstream messages stay private.
 */
export async function verifyLarkApplication(input, timeoutMs, signal) {
  if (
    typeof input.appId !== 'string' ||
    !/^cli_[A-Za-z0-9]{1,128}$/.test(input.appId) ||
    typeof input.appSecret !== 'string' ||
    !/^[^\s\x00-\x1f\x7f]{1,512}$/.test(input.appSecret) ||
    !['feishu', 'lark'].includes(input.brand)
  ) {
    throw new Error('LARK_APP_INVALID');
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const requestSignal = AbortSignal.any([signal, timeout.signal]);
  try {
    const origin =
      input.brand === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com';
    const response = await fetch(origin + '/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
    });
    const chunks = [];
    let size = 0;
    if (!response.body) {
      throw new Error('LARK_RESPONSE_INVALID');
    }
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64000) {
        throw new Error('LARK_OUTPUT_LIMIT');
      }
      chunks.push(Buffer.from(chunk));
    }
    requestSignal.throwIfAborted();
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('LARK_RESPONSE_INVALID');
    }
    if (
      !response.ok ||
      data.code !== 0 ||
      typeof data.tenant_access_token !== 'string' ||
      !data.tenant_access_token
    ) {
      throw new Error('LARK_APP_CHECK_FAILED');
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error('LARK_CHECK_CANCELLED');
    }
    if (timeout.signal.aborted) {
      throw new Error('LARK_CHECK_TIMEOUT');
    }
    throw new Error(/^LARK_[A-Z_]+$/.test(error.message) ? error.message : 'LARK_APP_CHECK_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
