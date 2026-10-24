import { it, expect } from 'vitest';
import { extractTurnsFromEvents, readSessionSnapshot, renderSessionDocument, calculateTurnsTokens } from '../../src/server/session-utils.js';
import { listRelatedSessions } from '../../src/server/session-selector.js';
import { sessionEvents } from './session-fixture.js';

it('keeps human steering and assistant intermediate/final text in exact order without truncation or event metadata', () => {
  const final = '最终正文'.repeat(400), intermediate = '较长的中间回复'.repeat(600);
  const turns = extractTurnsFromEvents(sessionEvents({ final, intermediate }), { sessionId: 's' });
  expect(turns[0]).toMatchObject({ turnNumber: 1, status: 'completed', syncable: true });
  expect(turns[0].messages.map(message => [message.label, message.text])).toEqual([
    ['用户输入', '用户明确确认新规则'], ['助手中间回复 1', intermediate], ['用户补充输入', '保留旧接口。'], ['助手最终回复', final],
  ]);
  const document = renderSessionDocument('s', turns);
  expect(document).toContain(final); expect(document).toContain(intermediate);
  expect(JSON.stringify(turns) + document).not.toContain('SECRET');
  expect(calculateTurnsTokens(turns)).toBeGreaterThan(calculateTurnsTokens(extractTurnsFromEvents(sessionEvents())));
});

it.each(['aborted','error','interrupted','max-tokens','running'])('does not promote partial %s responses to final answers', reason => {
  const events = sessionEvents();
  if (reason === 'running') events.pop(); else events.at(-1).data.reason.kind = reason;
  const [turn] = extractTurnsFromEvents(events);
  expect(turn.syncable).toBe(false); expect(turn.messages.some(message => message.kind === 'final')).toBe(false);
});

it('rejects a tool-requesting or reasoning-only last step as a final answer', () => {
  for (const content of [[{ type: 'tool-call', name: 'read' }], [{ type: 'reasoning', text: 'secret' }]]) {
    const events = sessionEvents(); events.at(-2).data.message.content = content;
    const [turn] = extractTurnsFromEvents(events);
    expect(turn.syncable).toBe(false);
    expect(turn.messages.some(message => message.kind === 'final')).toBe(false);
  }
});

it('fails explicitly on read errors and versions only canonical conversation content', async () => {
  await expect(readSessionSnapshot({ readSession: async () => { throw Error('unavailable'); } }, 's')).rejects.toThrow('SESSION_READ_FAILED');
  let events = sessionEvents(); const query = { readSession: async () => ({ events }) };
  const a = await readSessionSnapshot(query, 's');
  events[2].data.content = 'different injected context';
  expect((await readSessionSnapshot(query, 's')).version).toBe(a.version);
  events.at(-2).data.message.content = 'changed final';
  expect((await readSessionSnapshot(query, 's')).version).not.toBe(a.version);
});

it('lists real turn counts and marks unreadable sessions without using event counts', async () => {
  const query = { listSessions: async () => ['s','bad'].map(id => ({ header: { id, cwd: 'D:/work', createdAt: 1 } })),
    readTitle: async id => ({ title: id }), readSession: async id => { if (id === 'bad') throw Error('broken'); return { events: sessionEvents() }; } };
  const list = await listRelatedSessions(null, 'D:/work', { sessionQuery: query });
  expect(list[0]).toMatchObject({ turnCount: 1, syncTurnCount: 1 });
  expect(list[0].snapshotVersion).toMatch(/^[a-f0-9]{64}$/); expect(list[0]).not.toHaveProperty('eventCount');
  expect(list[1].syncTurnCount).toBe(0); expect(list[1].snapshotError).toContain('broken');
});
