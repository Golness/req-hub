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
    const codeDiff = [0,1].map(i => 'diff --git a/src/f'+i+'.js b/src/f'+i+'.js\n--- a/src/f'+i+'.js\n+++ b/src/f'+i+'.js\n@@ -1 +1 @@\n-old\n+'+'x'.repeat(60000)).join('\n');
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
  it('rejects a single large turn during preflight before any code analysis', async () => {
    const { result, harness } = await run('requirement', {}, { sessionTurns: [{ sessionId: 'big', turnNumber: 1, userInput: 'x'.repeat(160000) }] });
    expect(result.errors[0].phase).toBe('init'); expect(harness.requests).toHaveLength(0);
  });
});
