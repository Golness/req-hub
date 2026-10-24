import { createHash } from 'node:crypto';
import { estimateTextTokens } from './token-utils.js';

const textOnly = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') : '';

/** One lossless text projection for selection, preview, persisted evidence and budgeting. */
export function extractTurnsFromEvents(events, { sessionId } = {}) {
  const turns = [];
  let turn;
  const close = reason => {
    if (!turn) return;
    const last = turn.messages.at(-1);
    turn.status = reason || 'running';
    turn.syncable = reason === 'completed' && last?.role === 'assistant' && !last.interrupted
      && turn.messages.some(message => message.role === 'user');
    let intermediate = 0, users = 0;
    turn.messages = turn.messages.map((message, index) => ({
      role: message.role,
      kind: message.role === 'user' ? (++users === 1 ? 'input' : 'followup')
        : turn.syncable && index === turn.messages.length - 1 ? 'final' : 'intermediate',
      label: message.role === 'user' ? (users === 1 ? '用户输入' : '用户补充输入')
        : turn.syncable && index === turn.messages.length - 1 ? '助手最终回复' : `助手中间回复 ${++intermediate}`,
      text: message.text,
    }));
    turns.push(turn); turn = null;
  };
  for (const event of events) {
    if (event.type === 'turn/start') {
      close('running');
      turn = { sessionId, turnNumber: event.data.turn, messages: [] };
    } else if (turn && event.type === 'turn/end' && event.data.turn === turn.turnNumber) {
      close(event.data.reason?.kind);
    } else if (turn && event.type === 'user/message' && event.data.source?.kind === 'user') {
      const text = textOnly(event.data.content);
      if (text) turn.messages.push({ role: 'user', text });
    } else if (turn && event.type === 'assistant/message' && event.data.turn === turn.turnNumber) {
      const text = textOnly(event.data.message?.content);
      const blocks = event.data.message?.content;
      const interrupted = event.data.interrupted || Array.isArray(blocks) && blocks.some(block => block.type === 'tool-call');
      if (text) turn.messages.push({ role: 'assistant', text, interrupted });
      else turn.messages.push({ role: 'assistant', text: '', interrupted: true });
    }
  }
  close('running');
  return turns.map(turn => ({ ...turn, messages: turn.messages.filter(message => message.text) }));
}

export async function readSessionSnapshot(sessionQuery, sessionId, sessions) {
  let events;
  try {
    if (sessionQuery) events = (await sessionQuery.readSession(sessionId)).events;
    else {
      const session = sessions?.get(sessionId);
      if (session) events = session.snapshotEvents();
    }
    if (!Array.isArray(events)) throw new Error('会话读取服务不可用');
  } catch (error) { throw new Error(`SESSION_READ_FAILED: ${sessionId}：${error.message}`); }
  const turns = extractTurnsFromEvents(events, { sessionId });
  const version = createHash('sha256').update(JSON.stringify(turns)).digest('hex');
  return { sessionId, version, turns, turnCount: turns.length, syncTurnCount: turns.filter(turn => turn.syncable).length,
    totalTokens: calculateTurnsTokens(turns) };
}

export async function extractSessionTurns(sessionQuery, sessionId, options = {}) {
  return (await readSessionSnapshot(sessionQuery, sessionId, options.sessions)).turns;
}

export async function extractMultipleSessionTurns(sessionQuery, sessionIds, options = {}) {
  const snapshots = await Promise.all(sessionIds.map(id => options.readSnapshot ? options.readSnapshot(id) : readSessionSnapshot(sessionQuery, id, options.sessions)));
  const turns = snapshots.flatMap(snapshot => snapshot.turns.filter(turn => turn.syncable));
  return { snapshots, turns, totalTokens: calculateTurnsTokens(turns) };
}

export function renderSessionTurn(turn) {
  const messages = turn.messages || [
    { label: '用户输入', text: turn.userInput || '' }, { label: '助手最终回复', text: turn.summary || '' },
  ].filter(message => message.text);
  return `## 第 ${turn.turnNumber ?? '?'} 轮\n\n` + messages.map(message => `### ${message.label}\n\n${message.text}\n`).join('\n');
}

export function renderSessionDocument(sessionId, turns) {
  return `# 会话：${sessionId}\n\n` + turns.map(renderSessionTurn).join('\n');
}

export function calculateTurnsTokens(turns) {
  return turns.reduce((sum, turn) => sum + estimateTextTokens(renderSessionTurn(turn)), 0);
}
