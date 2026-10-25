'use strict';
const { t } = require('../locale.js');

/** Both conversation sources use the same progress and final-result protocol. */
async function readConversationResponse(response, onProgress) {
  if (!response.ok || !response.headers?.get('content-type')?.includes('application/x-ndjson')) {
    const data = await response.json();
    if (!response.ok || data.error) throw Error(data.error || t('common.loadFailed'));
    return data;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', result;
  const consume = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw Error(event.error);
    if (event.type === 'progress') onProgress?.(event);
    if (event.type === 'result') result = event.result;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(consume);
      if (done) { consume(pending); break; }
    }
  } finally { reader.releaseLock(); }
  if (!result) throw Error(t('CodexSessionsSection.message009'));
  return result;
}
module.exports = { readConversationResponse };
