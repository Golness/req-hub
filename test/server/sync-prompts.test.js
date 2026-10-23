import { describe, it, expect } from 'vitest';
import { PROMPT_REGISTRY, getPrompt, getPromptAsync, buildFullPrompt } from '../../src/server/prompts.js';
const keys = Object.keys(PROMPT_REGISTRY).filter(key => key.startsWith('phased-'));
describe('v2 prompt contract', () => {
  it('updates all ten stages and exposes only reference variables', () => {
    expect(keys).toHaveLength(10);
    for (const key of keys) {
      const meta = PROMPT_REGISTRY[key];
      expect(meta.contractVersion).toBe(2);
      expect(meta.variables.map(v => v.name)).not.toEqual(expect.arrayContaining(['codeDiff']));
      const rendered = buildFullPrompt({ promptTemplate: meta.default, variables: { runtimeId:'r',manifestId:'m',reportId:'report',changesId:'changes' } });
      expect(rendered).toContain('req_hub_sync_read');
      expect(rendered).not.toMatch(/\{(?:codeDiff|currentDoc|sessionContent|commitList)\}/);
      if (key.startsWith('phased-merge-')) expect(rendered).toContain('不手写补丁');
    }
  });
  it('does not import old prompt or Skill settings', async () => {
    const key=keys[0], config={ai:{prompts:{[key]:'OLD_PROMPT'},skillBindings:{[key]:'old'}}};
    expect(getPrompt(config,key)).toBe(PROMPT_REGISTRY[key].default);
    const prompt=await getPromptAsync(config,key);
    expect(prompt.promptTemplate).toBe(PROMPT_REGISTRY[key].default);expect(prompt.skillUsed).toBeNull();
  });
});
