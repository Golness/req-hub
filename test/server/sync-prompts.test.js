import { describe, it, expect } from 'vitest';
import {
  PROMPT_REGISTRY,
  getPrompt,
  getPromptAsync,
  buildFullPrompt,
} from '../../src/server/prompts.js';
const keys = Object.keys(PROMPT_REGISTRY).filter((key) => key.startsWith('phased-'));
describe('v2 prompt contract', () => {
  it('distinguishes a requirements baseline from the technical design and implementation evidence', () => {
    for (const source of ['code', 'discussion']) {
      const prompt = PROMPT_REGISTRY[`phased-${source}-analysis-design`].default;
      expect(prompt).toContain('read it fully before code or session analysis');
      expect(prompt).toContain('Do not turn the technical design into a requirements document');
      expect(prompt).toContain('They do not prove that code implements that behavior');
      expect(prompt).toContain('Do not use design.reference in evidenceRefs');
      expect(PROMPT_REGISTRY[`phased-${source}-analysis-requirement`].default).not.toContain(
        '## Requirements baseline for technical design',
      );
    }
    expect(PROMPT_REGISTRY['phased-merge-design'].default).toContain(
      "not the technical document's structure",
    );
  });
  it('keeps details in indexes and uses edit receipts instead of requiring full candidate rereads', () => {
    for (const key of keys) {
      const prompt = PROMPT_REGISTRY[key].default;
      if (key.startsWith('phased-merge-')) {
        expect(prompt).toContain('Use the returned candidateHash as expectedHash');
        expect(prompt).not.toContain('Read the candidate again after each edit');
      } else {
        expect(prompt).toContain('Keep all change details and unresolved facts in the JSON index');
        expect(prompt).toContain(
          'Do not repeat proposals, evidence lists, or per-item explanations',
        );
        expect(prompt).toContain('Retry until both report and changes return written=true');
      }
    }
  });
  it('updates all ten stages and exposes only reference variables', () => {
    expect(keys).toHaveLength(10);
    for (const key of keys) {
      const meta = PROMPT_REGISTRY[key];
      expect(meta.contractVersion).toBe(2);
      expect(meta.variables.map((v) => v.name)).not.toEqual(expect.arrayContaining(['codeDiff']));
      const rendered = buildFullPrompt({
        promptTemplate: meta.default,
        variables: { runtimeId: 'r', manifestId: 'm', reportId: 'report', changesId: 'changes' },
      });
      expect(rendered).toContain('req_hub_sync_read');
      expect(rendered).not.toMatch(/\{(?:codeDiff|currentDoc|sessionContent|commitList)\}/);
      if (key.startsWith('phased-merge-')) expect(rendered).toContain('write patches manually');
      else {
        expect(rendered).toContain('Each pending item must be an object');
        expect(rendered).toContain('Never substitute sourceArtifactId');
        expect(rendered).toContain('Validation failure writes nothing');
      }
    }
  });
  it('does not import old prompt or Skill settings', async () => {
    const key = keys[0],
      config = { ai: { prompts: { [key]: 'OLD_PROMPT' }, skillBindings: { [key]: 'old' } } };
    expect(getPrompt(config, key)).toBe(PROMPT_REGISTRY[key].default);
    const prompt = await getPromptAsync(config, key);
    expect(prompt.promptTemplate).toBe(PROMPT_REGISTRY[key].default);
    expect(prompt.skillUsed).toBeNull();
  });
});
