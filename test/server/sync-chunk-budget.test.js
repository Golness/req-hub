import { describe, it, expect } from 'vitest';
import { chunkCodeDiff, chunkTurns } from '../../src/server/phased-sync-engine.js';
import { estimateSubagentInputTokens } from '../../src/server/token-utils.js';

const file = (path, size) => ({ file: path, content: 'x'.repeat(size) });
const options = (overhead = 0) => ({
  buildVariables: (items, index, total) => ({ content: items.map(i => i.content ?? i.userInput).join('\n'), label: `${index + 1}/${total}` }),
  preparePrompt: async variables => ({ fullPrompt: 'p'.repeat(overhead) + variables.label + variables.content }),
});

describe('full sync input packing', () => {
  it('moves whole packages to the next chunk and preserves interleaved files', async () => {
    const chunks = await chunkCodeDiff([file('a/1', 60000), file('b/1', 50000), file('a/2', 60000)], options());
    expect(chunks.map(c => c.items.map(f => f.file))).toEqual([['a/1', 'a/2'], ['b/1']]);
    for (const chunk of chunks) {
      expect(chunk.tokens).toBe(estimateSubagentInputTokens(chunk.preparedPromptData.fullPrompt));
      expect(chunk.tokens).toBeLessThan(150000);
      expect(chunk.variables.label).toBe(`${chunk.index + 1}/2`);
    }
  });

  it('splits oversized packages at file boundaries without losing files', async () => {
    const chunks = await chunkCodeDiff([file('a/1', 60000), file('a/2', 60000), file('a/3', 60000)], options());
    expect(chunks.map(c => c.items.length)).toEqual([2, 1]);
    expect(chunks.flatMap(c => c.items.map(f => f.file))).toEqual(['a/1', 'a/2', 'a/3']);
  });

  it('budgets the rendered wrapper and repeated template values, not just source text', async () => {
    const opts = options();
    opts.preparePrompt = async v => ({ fullPrompt: 'p'.repeat(40000) + v.content + v.content });
    const chunks = await chunkCodeDiff([file('a/1', 30000), file('a/2', 30000)], opts);
    expect(chunks).toHaveLength(2);
    expect(chunks.every(c => c.tokens < 150000)).toBe(true);
  });

  it('keeps a file’s committed and uncommitted layers together', async () => {
    const chunks = await chunkCodeDiff([file('a/1', 40000), file('b/1', 70000), file('a/1', 40000)], options());
    expect(chunks).toHaveLength(2);
    expect(chunks[0].items).toHaveLength(1);
    expect(chunks[0].items[0].content.length).toBe(80001);
  });

  it('moves complete sessions, keeping all turns together', async () => {
    const turns = [
      { sessionId: 'one', userInput: 'x'.repeat(50000) },
      { sessionId: 'two', userInput: 'x'.repeat(60000) },
      { sessionId: 'one', userInput: 'x'.repeat(50000) },
    ];
    const chunks = await chunkTurns(turns, options());
    expect(chunks.map(c => c.items.map(t => t.sessionId))).toEqual([['one', 'one'], ['two']]);
  });

  it('splits a large session between complete turns while retaining session identity', async () => {
    const turns = Array.from({ length: 4 }, (_, index) => ({ sessionId: 'large', turnNumber: index + 1, userInput: 'x'.repeat(60000) }));
    const chunks = await chunkTurns(turns, options());
    expect(chunks.map(c => c.items.map(t => t.turnNumber))).toEqual([[1, 2], [3, 4]]);
    expect(chunks.flatMap(c => c.items)).toEqual(turns);
    expect(chunks.every(c => c.tokens < 150000)).toBe(true);
  });

  it('removes arbitrary file and turn count caps', async () => {
    expect(await chunkCodeDiff(Array.from({ length: 20 }, (_, i) => file(`a/${i}`, 5)), options())).toHaveLength(1);
    expect(await chunkTurns(Array.from({ length: 60 }, () => ({ sessionId: 'one', userInput: 'hi' })), options())).toHaveLength(1);
  });

  it('fails explicitly for a single oversized file or session or fixed prompt', async () => {
    await expect(chunkCodeDiff([file('big/a', 150000)], options())).rejects.toThrow('big/a');
    await expect(chunkTurns([{ sessionId: 'big-session', userInput: 'x'.repeat(150000) }], options())).rejects.toThrow('big-session');
    await expect(chunkCodeDiff([file('a', 1)], options(150000))).rejects.toThrow('预算');
    await expect(chunkCodeDiff([{ file: '中文', content: '中'.repeat(50000) }], options())).rejects.toThrow('中文');
  });

  it('handles empty sources without rendering a prompt', async () => {
    expect(await chunkCodeDiff([], options())).toEqual([]);
    expect(await chunkTurns([], options())).toEqual([]);
  });
});
