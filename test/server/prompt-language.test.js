import { expect, it } from 'vitest';
import {
  PROMPT_REGISTRY,
  TASK_LANGUAGE_CONTRACT,
  buildFullPrompt,
} from '../../src/server/prompts.js';
import { TaskExecutor } from '../../src/server/task-executor.js';

it('uses English instructions in every built-in template without changing protocol variables', () => {
  expect(Object.keys(PROMPT_REGISTRY)).toHaveLength(13);
  for (const meta of Object.values(PROMPT_REGISTRY)) {
    expect(meta.default).not.toMatch(/\p{Script=Han}/u);
    for (const variable of meta.variables.filter((item) => item.required)) {
      expect(meta.default).toContain(`{${variable.name}}`);
    }
  }
});

it('keeps frozen content literal while adding the delivery language precedence', () => {
  const content = '# 需求\n金额为 $&。保留 {instruction}、D:\\文档\\原文.md。';
  const prompt = buildFullPrompt({
    systemPrompt: 'Skill instructions',
    promptTemplate: 'Document: {content}\nRequest: {instruction}',
    variables: { content, instruction: 'Only improve the acceptance criteria.' },
  });
  expect(prompt).toContain(content);
  expect(prompt).toContain('Request: Only improve the acceptance criteria.');
  expect(prompt.endsWith(TASK_LANGUAGE_CONTRACT)).toBe(true);
  expect(TASK_LANGUAGE_CONTRACT).toContain(
    'Use the language explicitly requested for the deliverable first.',
  );
  expect(TASK_LANGUAGE_CONTRACT).toContain("preserve the input document's language");
  expect(TASK_LANGUAGE_CONTRACT).toContain(
    'Do not infer delivery language from these English instructions',
  );
  expect(TASK_LANGUAGE_CONTRACT).toContain('Tool arguments that contain final document text');
});

it.each(['loaded', 'unavailable', 'disabled'])(
  'applies the language contract to custom templates when the skill is %s',
  async (state) => {
    const template = '自定义原文：{content}';
    const executor = new TaskExecutor({
      config: {
        ai: {
          prompts: { writing: template },
          skillBindings: { writing: state === 'disabled' ? null : 'asd-ste100' },
        },
      },
      ctx: {
        skills: {
          get: async () =>
            state === 'loaded'
              ? { content: 'Use short sentences.', invocation: { userInvocable: true } }
              : null,
        },
      },
    });
    const prepared = await executor.loadPrompt({
      promptKey: 'writing',
      variables: { content: '# Original English document' },
    });
    expect(prepared.promptTemplate).toBe(template);
    expect(prepared.fullPrompt).toContain('自定义原文：# Original English document');
    expect(prepared.fullPrompt.endsWith(TASK_LANGUAGE_CONTRACT)).toBe(true);
    if (state === 'loaded') {
      expect(prepared.fullPrompt).toMatch(/^\/asd-ste100\n/);
      expect(prepared.fullPrompt).not.toContain('Preserve the requested language.');
    }
  },
);

it('distinguishes intermediate sync output from final document text and final review findings', () => {
  for (const [key, meta] of Object.entries(PROMPT_REGISTRY)) {
    if (key.startsWith('phased-merge-')) {
      expect(meta.default).toContain('Translate English proposals');
      expect(meta.default).toContain('Finish with a brief English acknowledgment');
    } else if (key.startsWith('phased-')) {
      expect(meta.default).toContain('Write intermediate reports and JSON prose');
      expect(meta.default).toContain('in English');
    }
  }
  expect(PROMPT_REGISTRY.writing.default).toContain('Describe reasons and scope in English');
  expect(PROMPT_REGISTRY.writing.default).toContain('preserve the input document language');
  expect(PROMPT_REGISTRY['wiki-generate'].default).toContain('Write maintenance rules in English');
  expect(PROMPT_REGISTRY['knowledge-enhancement'].default).toContain('final review deliverables');
});
