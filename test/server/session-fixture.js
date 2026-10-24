export function sessionEvents({ intermediate = '我先检查接口。', final = '确认采用新规则。', turn = 1 } = {}) {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '用户明确确认新规则' }, { type: 'image', data: 'IMAGE_SECRET' }] } },
    { type: 'user/message', data: { source: { kind: 'injected' }, content: 'INJECTED_SECRET' } },
    { type: 'system/message', data: { content: 'SYSTEM_SECRET' } },
    { type: 'assistant/message', data: { turn, step: 0, message: { content: [{ type: 'reasoning', text: 'THINKING_SECRET' }, { type: 'text', text: intermediate }, { type: 'tool-call', name: 'read', arguments: 'TOOL_SECRET' }] } } },
    { type: 'tool/result', data: { content: 'RESULT_SECRET' } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: '保留旧接口。' } },
    { type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: final }] }, stream: ['STREAM_SECRET'], usage: { inputTokens: 999 } } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ];
}
