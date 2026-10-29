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
  it('freezes selected knowledge as optional versioned artifacts without adding it to executable code evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rh-sync-knowledge-'));
    const harness = createSyncHarness(), engine = new PhasedSyncEngine({ ...harness, config: {}, cwd: dir });
    try {
      const text = JSON.stringify({ documentId: 'doc-v3', version: 3, sources: [{ sourceHash: 'frozen-hash' }], body: 'A terminology definition' });
      const plan = await engine.prepareSyncChunks({ docType: 'requirement', currentDoc: source, commits: [], codeDiff: diff, syncDir: dir,
        knowledgeContext: [{ id: 'knowledge.0', documentId: 'doc-v3', version: 3, sourceHash: 'frozen-hash', text }] });
      expect(plan.knowledgeIds).toEqual(['knowledge.0']);
      expect(plan.code[0].allowed).toContain('knowledge.0'); expect(plan.code[0].required).not.toContain('knowledge.0');
      expect(JSON.parse(await plan.store.read('knowledge.0')).version).toBe(3);
      expect(plan.knowledgeContext[0]).not.toHaveProperty('text');
      const { parseAnalysisChanges } = await import('../../src/server/sync-document-validator.js');
      expect(() => parseAnalysisChanges(JSON.stringify({ changes: [{ id: 'only-knowledge', action: 'add', blockId: plan.blocks[0].id, reason: 'Definition', proposal: 'New rule', evidenceRefs: ['knowledge.0'] }], pending: [] }), plan.blocks, plan.code[0].allowed.filter(id => /^(code\.|session\.)/.test(id)))).toThrow('CHANGE_EVIDENCE_OR_SCOPE');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('terminates repeated invalid output writes with their precise cause without cancelling the parent task',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'req-hub-invalid-write-limit-')),owner=new AbortController();
    const harness=createSyncHarness({onStart(){
      const tool=harness.definitions.get('req_hub_sync_write'),execute=tool.execute;
      tool.execute=async(args,exec)=>{
        if(args.outputId!=='changes')return execute(args,exec);
        const bad=JSON.parse(args.content);bad.changes[0].blockId='mistyped-block';
        for(let i=0;i<20;i++){
          try{await execute({...args,content:bad},exec);}catch(error){if(exec.signal.aborted)throw error;}
        }
        throw Error('INVALID_WRITE_LOOP_NOT_STOPPED');
      };
    }});
    try{
      const engine=new PhasedSyncEngine({...harness,signal:owner.signal,config:{sync:{maxInvalidOutputWrites:2}},cwd:dir});
      const result=await engine.sync({docType:'requirement',currentDoc:source,codeDiff:diff,syncDir:dir});
      expect(owner.signal.aborted).toBe(false);expect(harness.requests[0].signal.aborted).toBe(true);
      expect(result.errors[0].error).toContain('SYNC_OUTPUT_REPAIR_LIMIT');expect(result.errors[0].error).toContain('CHANGE_BLOCK_ID');
      const diagnostic=JSON.parse(await readFile(join(dir,'code-0.read-state.json'),'utf8'));
      expect(diagnostic.invalidOutputWrites).toBe(2);expect(diagnostic.outputsWritten).toEqual(['report']);
      expect(result.mergedDoc).toBeNull();
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('packs more than 24 read pages when capacity allows and reports additive budget components', async () => {
    const dir=await mkdtemp(join(tmpdir(),'req-hub-adaptive-pages-'));
    const codeDiff=Array.from({length:40},(_,i)=>diff.replaceAll('src/rule.js',`src/rule-${i}.js`)+'\n+'+'a'.repeat(4000)).join('\n');
    const harness=createSyncHarness({noChange:true});
    const engine=new PhasedSyncEngine({...harness,config:{},cwd:dir});
    try {
      const options={docType:'requirement',currentDoc:source,codeDiff,syncDir:join(dir,'auto')};
      const auto=await engine.prepareSyncChunks(options);
      engine.config={sync:{maxAnalysisReadPages:24}};
      const capped=await engine.prepareSyncChunks({...options,syncDir:join(dir,'capped')});
      expect(auto.code.length).toBeLessThan(capped.code.length);
      expect(auto.code.some(chunk=>chunk.readPages>24)).toBe(true);
      expect(auto.code.flatMap(chunk=>chunk.items).map(item=>item.file).sort()).toEqual(capped.code.flatMap(chunk=>chunk.items).map(item=>item.file).sort());
      for(const chunk of auto.code){const b=chunk.inputBudget;expect(b.evidenceTokens+b.commonTokens+b.promptTokens+b.reservedTokens).toBe(chunk.tokens);expect(chunk.tokens).toBeLessThan(b.limit);expect(chunk.readPages).toBeLessThanOrEqual(auto.budget.maxAnalysisReadPages);}
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('validates analysis during tool execution so the same child can fix JSON, pending and evidence scope before completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'req-hub-analysis-repair-'));
    let checked = false;
    const harness = createSyncHarness({ onStart() {
      if (checked) return;
      checked = true;
      const tool = harness.definitions.get('req_hub_sync_write'), execute = tool.execute;
      tool.execute = async (args, exec) => {
        if (args.outputId === 'changes' && !tool.repairChecked) {
          tool.repairChecked = true;
          await expect(execute({...args,content:'{"changes":[]'},exec)).rejects.toThrow('ANALYSIS_JSON_INVALID');
          await expect(execute({...args,content:JSON.stringify({changes:[],pending:[{reason:'Uncertain'}]})},exec)).rejects.toThrow('PENDING_SCHEMA');
          const invalid=JSON.parse(args.content);invalid.changes[0].evidenceRefs=['code.unassigned.diff'];
          await expect(execute({...args,content:JSON.stringify(invalid)},exec)).rejects.toThrow('CHANGE_EVIDENCE_OR_SCOPE');
        }
        return execute(args,exec);
      };
    } });
    try {
      const engine = new PhasedSyncEngine({...harness,config:{},cwd:dir});
      const result = await engine.sync({docType:'requirement',currentDoc:source,commits:[],codeDiff:diff,sessionTurns:[],syncDir:dir});
      expect(result.errors).toEqual([]);expect(result.mergedDoc).toContain('新规则');
      expect(harness.definitions.get('req_hub_sync_write').repairChecked).toBe(true);
      expect(harness.requests.filter(request=>JSON.stringify(request.prompt).includes('manifest.code-0'))).toHaveLength(1);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('reports the real child failure instead of a repeated generic sync code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'req-hub-child-error-'));
    const harness = createSyncHarness();
    harness.ctx.subagents.start = async () => ({ id: 'failed-child', result: Promise.resolve({ stopReason: 'error', output: [] }), dispose: async () => {} });
    harness.ctx.sessionQuery = { observeSession: async () => ({ events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MODEL_UNAVAILABLE', message: 'Selected model is unavailable' } } } }] }) };
    const engine = new PhasedSyncEngine({ ...harness, config: {}, cwd: dir });
    try {
      const result = await engine.sync({ docType: 'requirement', currentDoc: source, codeDiff: diff, syncDir: dir });
      expect(result.errors).toEqual([{ phase: 'code_analysis', error: 'MODEL_UNAVAILABLE: Selected model is unavailable' }]);
      expect(result.mergedDoc).toBeNull();
      const receipt = JSON.parse(await readFile(join(dir, 'code-0.read-state.json'), 'utf8'));
      expect(receipt.outputsWritten).toEqual([]);
      expect(receipt.readState.next).toEqual({ artifactId: 'manifest.code-0', offset: 0 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
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
      expect(plan.code.every(chunk => chunk.readPages <= plan.budget.maxAnalysisReadPages)).toBe(true);
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
      const receipt = JSON.parse(await readFile(join(dir, 'code-0.read-state.json'), 'utf8'));
      expect(receipt.readState.remaining).toBe(0);expect(receipt.outputsWritten.sort()).toEqual(['changes','report']);
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
    expect(events.find(event => event.phase === 'code_analysis' && event.status === 'started').concurrency).toBe(3);
  });
  it.each(['requirement', 'design'])('creates an empty %s document with a title and replayable patch', async docType => {
    const { result, files } = await run(docType, {}, { currentDoc: '' });
    expect(result.errors).toEqual([]);
    expect(result.mergedDoc).toBe('# 标题\n\n新规则\n');
    expect(files[0]).toBe(files[1]);
    expect(files[0]).toContain('+# 标题');
  });
  it('merges all code chunks through one reference-only summary stage', async () => {
    const codeDiff = [0,1].map(i => 'diff --git a/src/f'+i+'.js b/src/f'+i+'.js\n--- a/src/f'+i+'.js\n+++ b/src/f'+i+'.js\n@@ -1 +1 @@\n-old\n+'+'x'.repeat(210000)).join('\n');
    const {result,harness}=await run('requirement',{}, {codeDiff});
    expect(result.errors).toEqual([]);expect(result.stats.codeChunks).toBeGreaterThanOrEqual(2);
    expect(harness.requests.filter(request=>request.label.includes('analysis-merge'))).toHaveLength(1);
    expect(result.mergedDoc).toBe(source.replace('旧规则','新规则'));
  });
  it.each(['code', 'discussion'])('uses exactly one summary for 24 %s chunks and preserves all evidence', async kind => {
    const dir = await mkdtemp(join(tmpdir(), 'req-hub-single-summary-'));
    const harness = createSyncHarness();
    const engine = new PhasedSyncEngine({ ...harness, config: {}, cwd: dir });
    try {
      const input = { docType: 'requirement', currentDoc: source, syncDir: dir,
        codeDiff: kind === 'code' ? Array.from({ length: 24 }, (_, i) => diff.replaceAll('src/rule.js', `src/rule-${i}.js`)).join('\n') : '',
        sessionTurns: kind === 'discussion' ? Array.from({ length: 24 }, (_, i) => ({ sessionId: 's', turnNumber: i + 1, userInput: '用户确认新规则', summary: '确认' })) : [] };
      const plan = await engine.prepareSyncChunks(input);
      // Isolate summary fan-in from the separately tested chunk-packing policy.
      const items = plan[kind].flatMap(chunk => chunk.items);
      expect(items).toHaveLength(24);
      plan[kind] = await Promise.all(items.map(async (item, index) => {
        const id = kind + '-fixture-' + index, manifestId = 'manifest.' + id;
        const required = [...plan.common, ...item.required];
        await plan.store.put(manifestId, JSON.stringify({ schemaVersion: 2, required, outputIds: ['report', 'changes'] }));
        return { id, index, manifestId, items: [item], required: [manifestId, ...required], allowed: [manifestId, ...required, ...item.context] };
      }));
      const result = await engine.sync({ ...input, preparedChunks: plan });
      expect(result.errors).toEqual([]);
      expect(harness.requests.filter(request => request.label.includes('analysis-merge'))).toHaveLength(1);
      expect(harness.requests).toHaveLength(26); // 24 analyses, one summary, one edit.
      const combined = JSON.parse(await readFile(join(dir, 'summary-0.json'), 'utf8'));
      expect(combined.changes[0].evidenceRefs).toHaveLength(24);
      expect(new Set(combined.changes[0].sourceIds).size).toBe(24);
      expect(result.mergedDoc).toBe(source.replace('旧规则', '新规则'));
    } finally { await rm(dir, { recursive: true, force: true }); }
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
