import { it, expect } from 'vitest';
import { PhasedSyncEngine } from '../../src/server/phased-sync-engine.js';
import { createSyncHarness } from './sync-v2-harness.js';
it('rejects old body variables in a newly configured v2 prompt', () => {
 const key='phased-code-analysis-design';
 const engine=new PhasedSyncEngine({config:{ai:{syncV2:{prompts:{[key]:'read {codeDiff}'}}}}});
 expect(()=>engine.getStageConfig(key)).toThrow('PROMPT_CONTRACT_CONFLICT');
});
it('ignores old runtime settings and preserves the current contract for v2 custom text', () => {
 const key='phased-merge-requirement';
 const config={ai:{prompts:{[key]:'OLD'},syncV2:{prompts:{[key]:'简明专业'}}}};
 const engine=new PhasedSyncEngine({config});
 const effective=engine.getStageConfig(key);
 expect(effective.ai.syncV2.prompts[key]).toContain('简明专业');
 expect(effective.ai.syncV2.prompts[key]).toContain('不手写补丁');
 expect(config.ai.syncV2.prompts[key]).toBe('简明专业');
});
it('supports the Harness isolated-tool provider capability contract', () => {
 const {ctx}=createSyncHarness();
 expect(ctx.subagents.getProvider('spawn').capabilities.toolFilter).toBe(true);
});
