import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhasedSyncEngine } from '../../src/server/phased-sync-engine.js';
import { createSyncHarness } from './sync-v2-harness.js';

const source = '# 标题\r\n\r\n旧规则\r\n\r\n## 无关\r\n保留  双空格\r\n';
const diff = 'diff --git a/src/rule.js b/src/rule.js\n--- a/src/rule.js\n+++ b/src/rule.js\n@@ -1 +1 @@\n-old\n+DIFF_SENTINEL';
async function run(docType, harnessOptions = {}, input = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'req-hub-v2-engine-'));
  const harness = createSyncHarness(harnessOptions);
  const engine = new PhasedSyncEngine({ ...harness, config: {}, cwd: dir });
  const events = [];
  try {
    const result = await engine.sync({ docType, currentDoc: source, commits: [], codeDiff: diff, sessionTurns: [], syncDir: dir,
      onProgress: event => events.push(event), ...input });
    return { result, events, harness, files: result.validation ? await Promise.all(['document.patch', 'applied-document.diff', 'validation.json'].map(name => readFile(join(dir, name), 'utf8'))) : [] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('v2 frozen evidence and isolated candidates', () => {
  it('splits required diffs losslessly and leaves full frozen source versions optional', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'req-hub-large-file-'));
    const harness = createSyncHarness({ noChange: true });
    const engine = new PhasedSyncEngine({ ...harness, config: {}, cwd: dir });
    try {
      const codeDiff = diff + '\n+' + '中文大文件\n'.repeat(16000);
      const options = { docType: 'design', currentDoc: source, syncDir: dir, codeDiff,
        sourceSnapshots: [{ file: 'src/rule.js', base: '旧代码\n'.repeat(15000), target: '目标代码\n'.repeat(15000), final: '最终代码\n'.repeat(15000) }] };
      const plan = await engine.prepareSyncChunks(options);
      expect(plan.code.length).toBeGreaterThan(1);
      expect(plan.code.every(chunk => chunk.tokens < 150000)).toBe(true);
      const ranges = new Map();
      for (const chunk of plan.code) for (const id of chunk.items.flatMap(item => item.required)) {
        const part = JSON.parse(await plan.store.read(id));
        const parts = ranges.get(part.sourceArtifactId) || [];
        parts.push(part); ranges.set(part.sourceArtifactId, parts);
      }
      expect(ranges.size).toBe(1);
      expect([...ranges.keys()]).toEqual(['code.0.diff']);
      for (const chunk of plan.code) {
        expect(chunk.required).not.toContain('code.0.base');
        expect(chunk.allowed).toContain('code.0.base');
        expect(chunk.allowed).toContain('code.0.final');
      }
      expect(JSON.parse(await plan.store.read('code.0.base')).content).toBe(options.sourceSnapshots[0].base);
      for (const [id, parts] of ranges) {
        parts.sort((a, b) => a.start - b.start);
        expect(parts[0].start).toBe(0);
        expect(parts.at(-1).end).toBe(parts[0].totalChars);
        expect(parts.map(part => part.text).join('')).toBe(await plan.store.read(id));
      }
      const result = await engine.sync({ ...options, preparedChunks: plan });
      expect(result.errors).toEqual([]);
      expect(result.mergedDoc).toBe(source);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(['requirement', 'design'])('updates only the requested %s text and produces reproducible diff', async docType => {
    const { result, harness, events, files } = await run(docType);
    expect(result.errors).toEqual([]);
    expect(result.mergedDoc).toBe(source.replace('旧规则', '新规则'));
    expect(files[0]).toBe(files[1]);
    expect(files[0]).toContain('+新规则');
    expect(harness.requests.length).toBeGreaterThan(0);
    for (const request of harness.requests) {
      expect(JSON.stringify(request.prompt)).not.toContain('DIFF_SENTINEL');
      expect(JSON.stringify(request.prompt)).not.toContain('保留  双空格');
      expect(request.toolFilter.allow).toEqual(['req_hub_sync_read', 'req_hub_sync_write', 'req_hub_sync_edit']);
    }
    expect(events.some(event => event.phase === 'validate' && event.status === 'completed')).toBe(true);
  });
  it.each(['requirement', 'design'])('creates an empty %s document with a title and replayable patch', async docType => {
    const { result, files } = await run(docType, {}, { currentDoc: '' });
    expect(result.errors).toEqual([]);
    expect(result.mergedDoc).toBe('# 标题\n\n新规则\n');
    expect(files[0]).toBe(files[1]);
    expect(files[0]).toContain('+# 标题');
  });
  it('merges all code chunks through bounded reference-only summary stages', async () => {
    const codeDiff = [0,1].map(i => 'diff --git a/src/f'+i+'.js b/src/f'+i+'.js\n--- a/src/f'+i+'.js\n+++ b/src/f'+i+'.js\n@@ -1 +1 @@\n-old\n+'+'x'.repeat(210000)).join('\n');
    const {result,harness}=await run('requirement',{}, {codeDiff});
    expect(result.errors).toEqual([]);expect(result.stats.codeChunks).toBe(2);
    expect(harness.requests.some(request=>request.label.includes('analysis-merge'))).toBe(true);
    expect(result.mergedDoc).toBe(source.replace('旧规则','新规则'));
  });
  it('reads session artifacts and combines their evidence with code',async()=>{
    const {result}=await run('design',{}, {sessionTurns:[{sessionId:'s',turnNumber:1,userInput:'用户明确确认新规则',summary:'确认'}]});
    expect(result.errors).toEqual([]);expect(result.stats.discussionChunks).toBe(1);
    expect(result.mergedDoc).toBe(source.replace('旧规则','新规则'));
  });
  it('keeps no-change bytes and emits truly empty patches', async () => {
    const { result, files } = await run('design', { noChange: true });
    expect(result.errors).toEqual([]); expect(result.mergedDoc).toBe(source); expect(files[0]).toBe('');
  });
  it('does not accept a completed response when required evidence was not read', async () => {
    const { result } = await run('requirement', { skipCoverage: true });
    expect(result.errors.length).toBeGreaterThan(0); expect(result.mergedDoc).toBeNull();
  });
  it('rejects oversized analysis output instead of truncating', async () => {
    const { result } = await run('requirement', { oversize: true });
    expect(result.errors.length).toBeGreaterThan(0); expect(result.mergedDoc).toBeNull();
  });
  it('handles non-code-only input without spawning a model', async () => {
    const { result, harness } = await run('design', {}, { codeDiff: 'diff --git a/README.md b/README.md\n-old\n+new' });
    expect(result.errors).toEqual([]); expect(result.mergedDoc).toBe(source); expect(harness.requests).toHaveLength(0);
  });
  it('accepts a large turn that now fits the estimated budget', async () => {
    const { result, harness } = await run('requirement', { noChange: true }, { sessionTurns: [{ sessionId: 'big', turnNumber: 1, userInput: 'x'.repeat(160000) }] });
    expect(result.errors).toEqual([]); expect(harness.requests.length).toBeGreaterThan(0);
  });
  it('splits an oversized intermediate reply losslessly while retaining the user and final replies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'req-hub-large-turn-'));
    const harness = createSyncHarness({ noChange: true });
    const engine = new PhasedSyncEngine({ ...harness, config: {}, cwd: dir });
    const turn = { sessionId: 'big', turnNumber: 7, syncable: true,
      messages: [{ role: 'user', label: '用户输入', text: '小输入' },
        { role: 'assistant', label: '助手中间回复 1', text: '中文回复\n'.repeat(24000) },
        { role: 'assistant', label: '助手最终回复', text: '最终回复' }] };
    try {
      const options = { docType: 'requirement', syncDir: dir, currentDoc: source, sessionTurns: [turn] };
      const plan = await engine.prepareSyncChunks(options);
      expect(plan.discussion.length).toBeGreaterThan(1);
      const parts = await Promise.all(plan.discussion.flatMap(chunk => chunk.items).map(async item => JSON.parse(await plan.store.read(item.required[0]))));
      parts.sort((a, b) => a.start - b.start);
      expect(parts.every(part => part.sessionId === 'big' && part.turnNumber === 7 && part.fragment)).toBe(true);
      expect(parts[0].start).toBe(0);
      expect(parts.at(-1).end).toBe(parts[0].totalChars);
      expect(parts.every((part, i) => i === 0 || part.start === parts[i - 1].end)).toBe(true);
      expect(parts.map(part => part.text).join('')).toBe(await plan.store.read('session.turn.0'));
      const result = await engine.sync({ ...options, preparedChunks: plan });
      expect(result.errors).toEqual([]); expect(result.mergedDoc).toBe(source);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
