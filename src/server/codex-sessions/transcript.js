// JSONL text extraction and mirrored-message handling adapted from dsh-codex-migrate (MIT).
// See NOTICE.md. Tool results, hidden reasoning and injected context are not conversation text.
import { createHash } from 'node:crypto';
import { calculateTurnsTokens, renderSessionDocument } from '../session-utils.js';

const CONTEXT_TAGS = ['environment_context', 'recommended_plugins', 'subagent_notification', 'turn_aborted', 'app-context', 'app_context', 'skills_instructions', 'system_context', 'instructions', 'user_instructions', 'developer_context', 'codex_internal_context', 'permissions', 'context'];
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => ['text', 'input_text', 'output_text'].includes(block?.type) && typeof block.text === 'string').map(block => block.text).join('\n') : '';

function userText(value) {
  let text = value;
  for (const tag of CONTEXT_TAGS) text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  if (/^\s*# AGENTS\.md instructions\b/i.test(text)) {
    const end = text.indexOf('</INSTRUCTIONS>');
    text = end < 0 ? '' : text.slice(end + '</INSTRUCTIONS>'.length);
  }
  return text.replace(/>>>\s*TRANSCRIPT DELTA\s*START[\s\S]*?>>>\s*TRANSCRIPT DELTA\s*END/g, '').trim();
}

/** Incremental projection: preserve every visible message, deduplicating only paired event/response mirrors. */
export function createCodexTranscript(sessionId) {
  const turns = [];
  let turn, nextNumber = 1;
  const start = id => { turn = { sessionId, turnNumber: nextNumber++, sourceTurnId: id || null, messages: [], lastWasTool: false }; };
  const close = status => {
    if (!turn) return;
    const last = turn.messages.at(-1);
    const syncable = status === 'completed' && !turn.lastWasTool && last?.role === 'assistant'
      && last.phase !== 'commentary' && turn.messages.some(message => message.role === 'user');
    let users = 0, intermediate = 0;
    if (turn.messages.length) turns.push({ sessionId, turnNumber: turn.turnNumber, ...(turn.sourceTurnId ? { sourceTurnId: turn.sourceTurnId } : {}), status, syncable,
      messages: turn.messages.map((message, index) => ({ role: message.role,
        kind: message.role === 'user' ? (++users === 1 ? 'input' : 'followup') : syncable && index === turn.messages.length - 1 ? 'final' : 'intermediate',
        label: message.role === 'user' ? (users === 1 ? '用户输入' : '用户补充输入')
          : syncable && index === turn.messages.length - 1 ? '助手最终回复' : `助手中间回复 ${++intermediate}`,
        text: message.text,
      })) });
    turn = null;
  };
  const message = (role, text, origin, phase) => {
    if (role === 'user') text = userText(text);
    if (!text.trim()) return;
    if (role === 'user' && turn?.messages.at(-1)?.phase === 'final') close('completed');
    if (!turn) start();
    const mirror = turn.messages.find(item => item.role === role && item.text === text && item.origin !== origin && !item.paired);
    if (mirror) { mirror.paired = true; if (phase) mirror.phase = phase; return; }
    turn.messages.push({ role, text, origin, phase, paired: false });
    turn.lastWasTool = false;
  };
  return {
    push(record) {
      const p = record?.payload;
      if (!p || typeof p !== 'object') return;
      if (record.type === 'turn_context') {
        if (p.turn_id && turn?.sourceTurnId && p.turn_id !== turn.sourceTurnId) close(turn.messages.at(-1)?.phase === 'final' ? 'completed' : 'running');
        if (!turn && p.turn_id) start(p.turn_id);
        else if (turn && p.turn_id) turn.sourceTurnId = p.turn_id;
      } else if (record.type === 'event_msg') {
        if (p.type === 'task_started') {
          if (turn && (!p.turn_id || p.turn_id !== turn.sourceTurnId)) close(turn.messages.at(-1)?.phase === 'final' ? 'completed' : 'running');
          if (!turn) start(p.turn_id);
        } else if (p.type === 'user_message') message('user', textContent(p.message), 'event', p.phase);
        else if (p.type === 'agent_message') message('assistant', textContent(p.message), 'event', p.phase);
        else if (['task_complete', 'task_completed', 'turn_aborted', 'task_failed'].includes(p.type)) {
          if (!turn || p.turn_id && turn.sourceTurnId && p.turn_id !== turn.sourceTurnId) return;
          if (p.type.startsWith('task_complete')) {
            if (typeof p.last_agent_message === 'string' && p.last_agent_message.trim()) {
              const last = turn.messages.at(-1);
              if (last?.role === 'assistant' && last.text === p.last_agent_message) { last.phase = 'final'; turn.lastWasTool = false; }
              else message('assistant', p.last_agent_message, 'completion', 'final');
            }
            close('completed');
          } else close(p.type === 'turn_aborted' ? 'aborted' : 'error');
        }
      } else if (record.type === 'response_item' || record.type === 'message') {
        const role = p.role || (p.type === 'user_message' ? 'user' : p.type === 'assistant_message' ? 'assistant' : '');
        if (['user', 'assistant'].includes(role) && (p.type === 'message' || record.type === 'message')) message(role, textContent(p.content), 'response', p.phase || p.channel);
        else if (turn && ['function_call', 'custom_tool_call'].includes(p.type)) turn.lastWasTool = true;
      }
    },
    finish() {
      close(turn?.messages.at(-1)?.phase === 'final' ? 'completed' : 'running');
      const version = createHash('sha256').update(JSON.stringify(turns)).digest('hex');
      return { sessionId, version, turns, turnCount: turns.length, syncTurnCount: turns.filter(turn => turn.syncable).length,
        totalTokens: calculateTurnsTokens(turns), markdown: renderSessionDocument(sessionId, turns) };
    },
  };
}
