import { it, expect, vi } from 'vitest';
import { PROMPT_REGISTRY, getPromptAsync, defaultSkillBindings, setSkillsService } from '../../src/server/prompts.js';
import { TaskExecutor } from '../../src/server/task-executor.js';

const skillBody='Use one instruction per sentence.\nPreserve each statement of uncertainty.\nUse req_hub_writing_submit for the document.';
it('declares file generation for every current registered prompt',()=>{
  expect(Object.values(PROMPT_REGISTRY).every(meta=>meta.generatesFileContent===true)).toBe(true);
});
it('fills effective defaults only when the skill is available and preserves explicit bindings',async()=>{
  const skills={get:vi.fn(async()=>({content:skillBody}))};
  const initial={ai:{skillBindings:{writing:'custom','knowledge-enhancement':null},syncV2:{contractVersion:2}}};
  const result=await defaultSkillBindings(initial,skills,{cwd:'/project'});
  expect(result.ai.skillBindings.writing).toBe('custom');
  expect(result.ai.skillBindings['knowledge-enhancement']).toBeNull();
  expect(result.ai.syncV2.skillBindings['phased-merge-design']).toBe('asd-ste100');
  expect(initial.ai.syncV2).not.toHaveProperty('skillBindings');
  expect(await defaultSkillBindings(initial,{get:async()=>null})).toEqual(initial);
});
it('does not confirm an existing unconfirmed v2 skill as a side effect of default discovery',async()=>{
  const initial={ai:{syncV2:{skillBindings:{'phased-merge-design':'old-custom'}}}};
  const result=await defaultSkillBindings(initial,{get:async()=>({content:skillBody})});
  expect(result.ai.syncV2.contractVersion).toBeUndefined();
});
it('passes the loaded skill exactly once to the subagent provider with the real loader and executor',async()=>{
  const parent={status:'running',session:{id:'parent'}};
  const start=vi.fn(async()=>({id:'child',dispose:async()=>{}}));
  const skills={get:vi.fn(async(_name,lookup)=>{expect(lookup.scope).toBe(parent);return {content:skillBody};})};
  const ctx={skills,subagents:{getProvider:()=>({capabilities:{}}),start}};
  const executor=new TaskExecutor({ctx,config:{},parentAgent:parent,cwd:'/project'});
  for(const key of Object.keys(PROMPT_REGISTRY)){
    const variables=Object.fromEntries(PROMPT_REGISTRY[key].variables.map(item=>[item.name,'fixture']));
    const loaded=await executor.loadPrompt({promptKey:key,variables});
    expect(loaded.skillStatus).toBe('loaded');expect(loaded.skillUsed).toBe('asd-ste100');
    await executor.startSubagent({promptKey:key},loaded);
    const text=start.mock.calls.at(-1)[1].prompt[0].text;
    expect(text.split(skillBody)).toHaveLength(2);
    expect(text).toContain('The task protocol controls tools and output format.');
    expect(text).not.toContain('`present`');
    expect(text).toContain(key==='writing'?'req_hub_writing_submit':key==='wiki-generate'?'req_hub_wiki_submit':key==='knowledge-enhancement'?'req_hub_enhancement_submit':key.startsWith('phased-merge-')?'req_hub_sync_edit':'req_hub_sync_write');
  }
});
it('continues without a missing configured skill and does not reuse another scope content',async()=>{
  const first={get:async()=>({content:'First scope rule.'})},second={get:async()=>null};
  const config={ai:{skillBindings:{writing:'custom'}}};
  expect((await getPromptAsync(config,'writing','/same',first)).systemPrompt).toBe('First scope rule.');
  const missing=await getPromptAsync(config,'writing','/same',second);
  expect(missing.skillStatus).toBe('unavailable');expect(missing.skillUsed).toBeNull();expect(missing.promptTemplate).toContain('req_hub_writing_submit');
  expect((await getPromptAsync({ai:{skillBindings:{writing:null}}},'writing','/same',first)).skillStatus).toBe('not_bound');
  setSkillsService(null);
});
it.each([null,{content:''},{content:' '.repeat(10)},{content:'x'.repeat(200001)},{content:'Rule.',invocation:{modelInvocable:false}},new Error('load failed')])('does not bind an unavailable skill or block generation (%j)',async value=>{
  const skills={get:async()=>{if(value instanceof Error)throw value;return value;}};
  const defaults=await defaultSkillBindings({},skills);expect(defaults).toEqual({});
  const result=await getPromptAsync({},'wiki-generate','/project',skills);
  expect(result.skillStatus).toBe('unavailable');expect(result.promptTemplate).toContain('req_hub_wiki_submit');
});
