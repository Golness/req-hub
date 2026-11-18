import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
  run: vi.fn(),
  budget: vi.fn(),
}));
vi.mock('../../src/server/workspace-task-agent.js', () => ({
  createWorkspaceTaskAgent: mocks.create,
}));
vi.mock('../../src/server/sync-budget.js', () => ({ resolveSyncBudget: mocks.budget }));
vi.mock('../../src/server/knowledge-v2/compiler.js', () => ({ runModelStep: mocks.run }));
import { createDailyBriefGenerator } from '../../src/server/daily-brief.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({ agent: { id: 'owner' }, dispose: mocks.dispose });
  mocks.budget.mockResolvedValue({ limit: 100000 });
  mocks.run.mockImplementation(async (options) => {
    options.validateResult({ answer: 'Summary' });
    return { answer: 'Summary', citations: [] };
  });
});
const input = () => ({
  group: { workspaceTitle: 'Workspace', group: 'requirement' },
  evidence: [{ id: 'one', path: 'one.md', body: 'content', version: 'v1', contentAvailable: true }],
  scope: { workspace: { id: 'ws', path: '/workspace' } },
  config: {},
  day: '2026-11-17',
  signal: new AbortController().signal,
});

it('fully covers every Unicode chunk and consolidates all batch summaries before returning', async () => {
  const data = input();
  data.evidence[0].body = '中文😀'.repeat(20000);
  const generate = createDailyBriefGenerator({ llm: {} }, { id: 'installation' });
  expect(await generate(data)).toBe('Summary');
  const calls = mocks.run.mock.calls.map(([options]) => options);
  const originals = calls
    .flatMap((options) => options.documents)
    .filter((doc) => doc.id.startsWith('one:'));
  expect(originals.map((doc) => doc.body.slice(doc.body.indexOf('\n') + 1)).join('')).toBe(
    data.evidence[0].body,
  );
  expect(calls.at(-1).documents.every((doc) => doc.id.startsWith('summary:'))).toBe(true);
  expect(
    calls.every(
      (options) =>
        options.kind === 'query' &&
        options.promptKey === 'daily-brief' &&
        options.documents.every((doc) => doc.required),
    ),
  ).toBe(true);
  expect(calls[0].config.knowledgeV2.modelRetryCount).toBe(0);
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

it('rejects disabled AI and applies limits to model batches rather than file collection', async () => {
  const generate = createDailyBriefGenerator({}, {});
  await expect(generate({ ...input(), config: { ai: { enabled: false } } })).rejects.toMatchObject({
    code: 'DAILY_MODEL_DISABLED',
  });
  await expect(
    generate({ ...input(), config: { dailyReports: { maxBriefInputBytes: 1 } } }),
  ).rejects.toMatchObject({ code: 'DAILY_MODEL_BUDGET_EXCEEDED' });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

it('releases the owner on model failure, budget exhaustion and invalid model output', async () => {
  const generate = createDailyBriefGenerator({}, {});
  mocks.run.mockRejectedValueOnce(new Error('execution failure'));
  await expect(generate(input())).rejects.toThrow('execution failure');
  const data = input();
  data.evidence[0].body = 'x'.repeat(50000);
  data.config.dailyReports = { maxModelCalls: 1 };
  await expect(generate(data)).rejects.toMatchObject({ code: 'DAILY_MODEL_BUDGET_EXCEEDED' });
  mocks.run.mockImplementationOnce(async (options) =>
    options.validateResult({ answer: '中'.repeat(5000) }),
  );
  await expect(generate(input())).rejects.toMatchObject({ code: 'DAILY_BRIEF_INVALID' });
  expect(mocks.dispose).toHaveBeenCalledTimes(3);
});

it('processes all source chunks across batches even when total content exceeds one model input window', async () => {
  const data = input();
  data.config.dailyReports = { maxBriefInputBytes: 30000, maxModelCalls: 128 };
  data.readEvidence = async function* () {
    for (let index = 0; index < 60; index++) {
      yield {
        id: 'chunk-' + index,
        path: 'large.md',
        body: 'x'.repeat(5000),
        version: 'v1',
        contentAvailable: true,
      };
    }
  };
  expect(await createDailyBriefGenerator({}, {})(data)).toBe('Summary');
  const originals = mocks.run.mock.calls
    .flatMap(([options]) => options.documents)
    .filter((document) => document.id.startsWith('chunk-'));
  expect(originals).toHaveLength(60);
});

it('retains workspace and requirement provenance when summarizing a consolidated day', async () => {
  const data = input();
  data.group.groups = [
    { workspaceId: 'one', workspaceTitle: 'One', group: 'author/2026-11-17-first' },
    { workspaceId: 'two', workspaceTitle: 'Two', group: '' },
  ];
  data.evidence = data.group.groups.map((section) => ({
    ...section,
    id: section.workspaceId,
    path: 'notes.md',
    body: 'Confirmed content',
    version: 'v1',
    contentAvailable: true,
  }));
  await createDailyBriefGenerator({}, {})(data);
  const options = mocks.run.mock.calls[0][0];
  expect(JSON.parse(options.instruction)).toMatchObject({
    scope: 'all-workspaces',
    sections: data.group.groups.map(({ workspaceId, workspaceTitle, group }) => ({
      workspaceId,
      workspace: workspaceTitle,
      requirement: group,
    })),
  });
  const metadata = options.documents.map((doc) => JSON.parse(doc.body.split('\n')[0]));
  expect(metadata.map((file) => file.workspaceId)).toEqual(['one', 'two']);
});

it('converges to a single brief even when every batch returns a maximum-size summary', async () => {
  const data = input();
  data.evidence[0].body = 'x'.repeat(60000);
  mocks.run.mockImplementation(async (options) => {
    const result = { answer: 'x'.repeat(12000), citations: [] };
    options.validateResult(result);
    return result;
  });
  expect(await createDailyBriefGenerator({}, {})(data)).toHaveLength(12000);
  expect(mocks.run.mock.calls.length).toBeLessThan(10);
  expect(mocks.run.mock.calls.at(-1)[0].documents).toHaveLength(2);
});
