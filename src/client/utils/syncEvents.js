'use strict';

// Parse transport data separately from business events: server errors must never
// be swallowed by a JSON parsing catch, including the last unterminated line.
async function readSyncEvents(body, onEvent) {
  if (!body) throw new Error('同步响应缺少事件流');
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const line = async text => {
    text = text.replace(/\r$/, '');
    if (!text.startsWith('data:')) return;
    let event;
    try { event = JSON.parse(text.slice(5).trimStart()); }
    catch { throw new Error('同步事件格式错误，请刷新任务状态'); }
    await onEvent(event);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { const text = buffer.slice(0, index); buffer = buffer.slice(index + 1); await line(text); }
      if (done) break;
    }
    if (buffer.trim()) await line(buffer);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
module.exports = { readSyncEvents };
